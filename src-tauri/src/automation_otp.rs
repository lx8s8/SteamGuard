//! Optional desktop-only loopback API for explicitly allowlisted test accounts.
//! This module never unlocks a vault, exposes seeds, or advances HOTP counters.
use crate::{models, otp, AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    net::{Ipv4Addr, TcpListener},
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

const CONFIG_ENV: &str = "STEAMGUARD_AUTOMATION_OTP_CONFIG";
const TOKEN_ENV: &str = "STEAMGUARD_AUTOMATION_OTP_TOKEN";
const MAX_CONFIG: u64 = 64 * 1024;
const MAX_HEADER: usize = 8 * 1024;
const MAX_BODY: usize = 16 * 1024;
const MAX_CONCURRENT: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CONFIG_ERROR: &str = "自动化 OTP 配置无效，请检查独立配置文件与环境变量";
const START_ERROR: &str = "无法启动自动化 OTP 本机服务，请检查端口是否被占用";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    schema_version: u8,
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    bindings: Vec<Binding>,
}
fn default_port() -> u16 {
    49188
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    account_alias: String,
    environment: String,
    brand: String,
    token_id: String,
}
impl Config {
    fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1 || self.port < 1024 || self.bindings.len() > 64 {
            return Err(CONFIG_ERROR);
        }
        if !self.enabled {
            return Ok(());
        }
        let mut aliases = HashSet::new();
        if self.bindings.is_empty()
            || self.bindings.iter().any(|b| {
                !alias(&b.account_alias)
                    || !alias(&b.environment)
                    || !alias(&b.brand)
                    || !aliases.insert(&b.account_alias)
                    || uuid::Uuid::parse_str(&b.token_id)
                        .ok()
                        .is_none_or(|id| id.to_string() != b.token_id)
            })
        {
            return Err(CONFIG_ERROR);
        }
        Ok(())
    }
}
fn alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn bearer(value: &str) -> bool {
    (32..=512).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b))
}
fn load_config(path: &Path) -> Result<Config, &'static str> {
    if !path.is_absolute() {
        return Err(CONFIG_ERROR);
    }
    let file = std::fs::File::open(path).map_err(|_| CONFIG_ERROR)?;
    if !file.metadata().map_err(|_| CONFIG_ERROR)?.is_file() {
        return Err(CONFIG_ERROR);
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CONFIG_ERROR)?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err(CONFIG_ERROR);
    }
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| CONFIG_ERROR)?;
    config.validate()?;
    Ok(config)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveRequest {
    account_alias: String,
    environment: String,
    brand: String,
    #[serde(default = "default_validity")]
    min_validity_seconds: u64,
    run_id: String,
}
fn default_validity() -> u64 {
    8
}
impl ResolveRequest {
    fn validate(&self) -> Result<(), ApiError> {
        if !alias(&self.account_alias)
            || !alias(&self.environment)
            || !alias(&self.brand)
            || !identifier(&self.run_id)
            || !(1..=60).contains(&self.min_validity_seconds)
        {
            return Err(ApiError::BadRequest);
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveResponse {
    account_alias: String,
    kind: &'static str,
    code: String,
    expires_at: String,
    server_time: String,
}
impl Drop for ResolveResponse {
    fn drop(&mut self) {
        self.code.zeroize();
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiError {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    ValidityTooShort(u64),
    PayloadTooLarge,
    UnsupportedMediaType,
    UnsupportedType,
    Locked,
    TooManyRequests,
    Unavailable,
}
impl ApiError {
    fn status(self) -> (u16, &'static str, &'static str) {
        match self {
            Self::BadRequest => (400, "Bad Request", "invalid_request"),
            Self::Unauthorized => (401, "Unauthorized", "unauthorized"),
            Self::Forbidden => (403, "Forbidden", "forbidden"),
            Self::NotFound => (404, "Not Found", "not_found"),
            Self::MethodNotAllowed => (405, "Method Not Allowed", "method_not_allowed"),
            Self::ValidityTooShort(_) => (409, "Conflict", "validity_too_short"),
            Self::PayloadTooLarge => (413, "Content Too Large", "payload_too_large"),
            Self::UnsupportedMediaType => (415, "Unsupported Media Type", "unsupported_media_type"),
            Self::UnsupportedType => (422, "Unprocessable Content", "unsupported_type"),
            Self::Locked => (423, "Locked", "locked"),
            Self::TooManyRequests => (429, "Too Many Requests", "too_many_requests"),
            Self::Unavailable => (503, "Service Unavailable", "unavailable"),
        }
    }
}
type Resolver =
    dyn Fn(&Binding, &ResolveRequest) -> Result<ResolveResponse, ApiError> + Send + Sync;
struct Service {
    authorization: Zeroizing<String>,
    bindings: HashMap<String, Binding>,
    resolver: Arc<Resolver>,
    port: u16,
}

/// Requests never renew the UI inactivity timer or reuse the preview-only cache.
fn resolve_state(
    state: &AppState,
    binding: &Binding,
    request: &ResolveRequest,
) -> Result<ResolveResponse, ApiError> {
    let epoch = state.epoch.load(Ordering::SeqCst);
    // A background import or disk write must not block an HTTP worker indefinitely.
    let mut vault = state.vault.try_lock().map_err(|_| ApiError::Unavailable)?;
    if vault.data.is_none()
        || vault.background_expired()
        || models::now().saturating_sub(vault.last_activity) > 900
    {
        return Err(ApiError::Locked);
    }
    let token = vault
        .ensure()
        .map_err(|_| ApiError::Locked)?
        .tokens
        .iter()
        .find(|t| t.id == binding.token_id)
        .ok_or(ApiError::NotFound)?;
    if token.kind != "totp" || !matches!(token.digits, 6 | 8) {
        return Err(ApiError::UnsupportedType);
    }
    token
        .validate_otp()
        .map_err(|_| ApiError::UnsupportedType)?;
    let now = state.timestamp();
    let remaining = token.period - now % token.period;
    if remaining < request.min_validity_seconds {
        return Err(ApiError::ValidityTooShort(remaining.saturating_add(1)));
    }
    let code = otp::code(token, now).map_err(|_| ApiError::Unavailable)?;
    let response = ResolveResponse {
        account_alias: binding.account_alias.clone(),
        kind: "totp",
        code,
        expires_at: timestamp(now.saturating_add(remaining))?,
        server_time: timestamp(now)?,
    };
    if state.epoch.load(Ordering::SeqCst) != epoch {
        return Err(ApiError::Locked);
    }
    Ok(response)
}
fn timestamp(seconds: u64) -> Result<String, ApiError> {
    let seconds: i64 = seconds.try_into().map_err(|_| ApiError::Unavailable)?;
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .ok_or(ApiError::Unavailable)
}

pub struct Controller {
    cancel: CancellationToken,
}
impl Controller {
    pub fn stop(&self) {
        self.cancel.cancel();
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        self.stop();
    }
}
/// Explicit configuration is read once at launch; absent or disabled means no listener.
pub fn initialize(app: tauri::AppHandle) -> Result<(), &'static str> {
    let Some(path) = std::env::var_os(CONFIG_ENV) else {
        return Ok(());
    };
    let config = load_config(Path::new(&path))?;
    if !config.enabled {
        return Ok(());
    }
    let token = Zeroizing::new(std::env::var(TOKEN_ENV).map_err(|_| CONFIG_ERROR)?);
    if !bearer(&token) {
        return Err(CONFIG_ERROR);
    }
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, config.port)).map_err(|_| START_ERROR)?;
    listener.set_nonblocking(true).map_err(|_| START_ERROR)?;
    let resolver_app = app.clone();
    let resolver = Arc::new(move |binding: &Binding, request: &ResolveRequest| {
        resolve_state(&resolver_app.state::<AppState>(), binding, request)
    });
    let service = Arc::new(Service {
        authorization: Zeroizing::new(format!("Bearer {}", &*token)),
        bindings: config
            .bindings
            .into_iter()
            .map(|b| (b.account_alias.clone(), b))
            .collect(),
        resolver,
        port: config.port,
    });
    let cancel = CancellationToken::new();
    app.manage(Controller {
        cancel: cancel.clone(),
    });
    tauri::async_runtime::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
            serve(listener, service, cancel).await;
        }
    });
    Ok(())
}

async fn serve(
    listener: tokio::net::TcpListener,
    service: Arc<Service>,
    cancel: CancellationToken,
) {
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut requests = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            Some(_) = requests.join_next(), if !requests.is_empty() => {},
            accepted = listener.accept() => {
                let Ok((mut stream, address)) = accepted else { break; };
                if !address.ip().is_loopback() { continue; }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    // Do not add overload responses to an unbounded secondary task queue.
                    let _ = tokio::time::timeout(Duration::from_millis(100), write_error(&mut stream, ApiError::TooManyRequests)).await;
                    continue;
                };
                let service = service.clone();
                requests.spawn(async move {
                    let _permit = permit;
                    let _ = tokio::time::timeout(REQUEST_TIMEOUT, handle(&mut stream, &service)).await;
                });
            }
        }
    }
    requests.abort_all();
    while requests.join_next().await.is_some() {}
}
async fn handle(stream: &mut TcpStream, service: &Service) {
    let result = async {
        let request = read_request(stream, service).await?;
        let binding = service
            .bindings
            .get(&request.account_alias)
            .ok_or(ApiError::NotFound)?;
        if binding.environment != request.environment || binding.brand != request.brand {
            return Err(ApiError::Forbidden);
        }
        (service.resolver)(binding, &request)
    }
    .await;
    match result {
        Ok(response) => {
            if let Ok(body) = serde_json::to_vec(&response) {
                let body = Zeroizing::new(body);
                let _ = write_response(stream, 200, "OK", &body, None).await;
            } else {
                let _ = write_error(stream, ApiError::Unavailable).await;
            }
        }
        Err(error) => {
            let _ = write_error(stream, error).await;
        }
    }
}
fn fixed_equal(left: &[u8], right: &[u8]) -> bool {
    // Length is public; all bytes of equal-length bearer values are compared.
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |different, (a, b)| different | (a ^ b))
        == 0
}
async fn read_request(
    stream: &mut TcpStream,
    service: &Service,
) -> Result<ResolveRequest, ApiError> {
    let mut bytes = Zeroizing::new(Vec::new());
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            if end + 4 > MAX_HEADER {
                return Err(ApiError::PayloadTooLarge);
            }
            break end + 4;
        }
        if bytes.len() >= MAX_HEADER {
            return Err(ApiError::PayloadTooLarge);
        }
        let mut chunk = [0u8; 1024];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|_| ApiError::BadRequest)?;
        if n == 0 {
            return Err(ApiError::BadRequest);
        }
        bytes.extend_from_slice(&chunk[..n]);
        chunk.zeroize();
    };
    let length = parse_headers(&bytes[..header_end], service)?;
    if bytes.len() > header_end + length {
        return Err(ApiError::BadRequest);
    }
    while bytes.len() < header_end + length {
        let mut chunk = [0u8; 1024];
        let amount = chunk.len().min(header_end + length - bytes.len());
        let n = stream
            .read(&mut chunk[..amount])
            .await
            .map_err(|_| ApiError::BadRequest)?;
        if n == 0 {
            return Err(ApiError::BadRequest);
        }
        bytes.extend_from_slice(&chunk[..n]);
        chunk.zeroize();
    }
    let request: ResolveRequest =
        serde_json::from_slice(&bytes[header_end..]).map_err(|_| ApiError::BadRequest)?;
    request.validate()?;
    Ok(request)
}
fn parse_headers(bytes: &[u8], service: &Service) -> Result<usize, ApiError> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    if !request
        .parse(bytes)
        .map_err(|_| ApiError::BadRequest)?
        .is_complete()
        || request.version != Some(1)
    {
        return Err(ApiError::BadRequest);
    }
    let mut fields = HashMap::new();
    for header in request.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        if fields.insert(name, header.value).is_some() {
            return Err(ApiError::BadRequest);
        }
    }
    if fields.contains_key("origin") {
        return Err(ApiError::Forbidden);
    }
    if !fields
        .get("authorization")
        .is_some_and(|v| fixed_equal(v, service.authorization.as_bytes()))
    {
        return Err(ApiError::Unauthorized);
    }
    let expected_host = format!("127.0.0.1:{}", service.port);
    let localhost = format!("localhost:{}", service.port);
    if !fields
        .get("host")
        .is_some_and(|v| *v == expected_host.as_bytes() || *v == localhost.as_bytes())
    {
        return Err(ApiError::Forbidden);
    }
    if request.path != Some("/v1/otp/resolve") {
        return Err(ApiError::NotFound);
    }
    if request.method != Some("POST") {
        return Err(ApiError::MethodNotAllowed);
    }
    if fields.contains_key("transfer-encoding") || fields.contains_key("expect") {
        return Err(ApiError::BadRequest);
    }
    if !fields.get("content-type").is_some_and(|v| {
        std::str::from_utf8(v).is_ok_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        })
    }) || fields
        .get("content-encoding")
        .is_some_and(|v| *v != b"identity")
    {
        return Err(ApiError::UnsupportedMediaType);
    }
    let length = fields.get("content-length").ok_or(ApiError::BadRequest)?;
    if length.is_empty() || !length.iter().all(u8::is_ascii_digit) {
        return Err(ApiError::BadRequest);
    }
    let length = std::str::from_utf8(length)
        .ok()
        .and_then(|n| n.parse::<usize>().ok())
        .ok_or(ApiError::PayloadTooLarge)?;
    if length > MAX_BODY {
        return Err(ApiError::PayloadTooLarge);
    }
    Ok(length)
}
async fn write_error(stream: &mut TcpStream, error: ApiError) -> std::io::Result<()> {
    let (status, reason, code) = error.status();
    let body = format!("{{\"error\":\"{code}\"}}");
    let retry_after = match error {
        ApiError::ValidityTooShort(seconds) => Some(seconds.clamp(1, 300)),
        _ => None,
    };
    write_response(stream, status, reason, body.as_bytes(), retry_after).await
}
async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    retry_after: Option<u64>,
) -> std::io::Result<()> {
    let retry_after = retry_after
        .map(|seconds| format!("Retry-After: {seconds}\r\n"))
        .unwrap_or_default();
    let headers = format!("HTTP/1.1 {status} {reason}\r\n{retry_after}Content-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{steam, sync, vault};
    use serde_json::json;
    use std::{
        net::SocketAddr,
        sync::{atomic::AtomicU64, Mutex},
    };

    const AUTH: &str = "synthetic-test-bearer-00000000000000000000";
    const ID: &str = "ec2ed188-254b-47c6-907c-1e8ea221d633";
    fn binding() -> Binding {
        Binding {
            account_alias: "demo-dev-user".into(),
            environment: "dev".into(),
            brand: "demo".into(),
            token_id: ID.into(),
        }
    }
    fn request() -> ResolveRequest {
        ResolveRequest {
            account_alias: "demo-dev-user".into(),
            environment: "dev".into(),
            brand: "demo".into(),
            min_validity_seconds: 8,
            run_id: "synthetic-test-run".into(),
        }
    }
    fn body() -> serde_json::Value {
        json!({"accountAlias":"demo-dev-user","environment":"dev","brand":"demo","minValiditySeconds":8,"runId":"synthetic-test-run"})
    }
    fn state(kind: &str, seconds: u64) -> AppState {
        let mut token = models::Token::new(
            "RFC fixture".into(),
            kind.into(),
            b"12345678901234567890".to_vec(),
        );
        token.id = ID.into();
        let mut vault =
            vault::Vault::new(std::env::temp_dir().join("unused-automation-otp-fixture"));
        vault.data = Some(vault::VaultData {
            tokens: vec![token],
            ..Default::default()
        });
        vault.last_activity = models::now();
        AppState {
            vault: Mutex::new(vault),
            previews: Mutex::new(HashMap::new()),
            steam: steam::SteamService::new().unwrap(),
            epoch: AtomicU64::new(0),
            time_offset: std::sync::atomic::AtomicI64::new(seconds as i64 - models::now() as i64),
            sync: sync::Controller::default(),
        }
    }
    fn error(result: Result<ResolveResponse, ApiError>) -> ApiError {
        match result {
            Ok(_) => panic!("expected fixed error"),
            Err(error) => error,
        }
    }
    #[test]
    fn configuration_is_explicit_bounded_and_exact() {
        let disabled: Config = serde_json::from_value(json!({"schemaVersion":1})).unwrap();
        assert!(!disabled.enabled);
        assert!(disabled.validate().is_ok());
        let mut enabled: Config = serde_json::from_value(json!({"schemaVersion":1,"enabled":true,"bindings":[{"accountAlias":"demo-dev-user","environment":"dev","brand":"demo","tokenId":ID}]})).unwrap();
        assert!(enabled.validate().is_ok());
        enabled.bindings.push(binding());
        assert!(enabled.validate().is_err());
        enabled.bindings.pop();
        enabled.bindings[0].token_id = "display-name".into();
        assert!(enabled.validate().is_err());
        assert!(serde_json::from_value::<Config>(
            json!({"schemaVersion":1,"enabled":true,"host":"0.0.0.0"})
        )
        .is_err());
        assert!(!bearer("short"));
        assert!(!bearer(&format!("{AUTH}\r\n")));
        assert!(bearer(AUTH));
        assert!(load_config(Path::new("relative.json")).is_err());
    }
    #[test]
    fn configuration_reader_rejects_oversized_files() {
        let path = std::env::temp_dir().join(format!(
            "steamguard-otp-config-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, vec![b' '; MAX_CONFIG as usize + 1]).unwrap();
        assert!(load_config(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn requests_reject_unknown_fields_invalid_scope_and_unbounded_validity() {
        assert!(request().validate().is_ok());
        for value in [0, 61, u64::MAX] {
            let mut request = request();
            request.min_validity_seconds = value;
            assert!(request.validate().is_err());
        }
        let mut value = body();
        value["password"] = json!("must-never-be-accepted");
        assert!(serde_json::from_value::<ResolveRequest>(value).is_err());
        let mut request = request();
        request.run_id = "contains\nnewline".into();
        assert!(request.validate().is_err());
    }
    #[test]
    fn resolver_reads_only_exact_unlocked_totp_without_renewing_activity() {
        let state = state("totp", 1_700_000_010);
        let last_activity = state.vault.lock().unwrap().last_activity;
        let result = resolve_state(&state, &binding(), &request()).unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "totp");
        assert!(value["code"].as_str().is_some_and(|c| c.len() == 6));
        assert!(value["serverTime"].as_str().unwrap().ends_with('Z'));
        assert_eq!(state.vault.lock().unwrap().last_activity, last_activity);
        let mut missing = binding();
        missing.token_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            error(resolve_state(&state, &missing, &request())),
            ApiError::NotFound
        );
        state.vault.lock().unwrap().lock();
        assert_eq!(
            error(resolve_state(&state, &binding(), &request())),
            ApiError::Locked
        );
    }
    #[test]
    fn resolver_rejects_idle_expiry_busy_vault_and_non_totp_types() {
        let state = state("totp", 1_700_000_010);
        let guard = state.vault.lock().unwrap();
        assert_eq!(
            error(resolve_state(&state, &binding(), &request())),
            ApiError::Unavailable
        );
        drop(guard);
        state.vault.lock().unwrap().last_activity = models::now().saturating_sub(901);
        assert_eq!(
            error(resolve_state(&state, &binding(), &request())),
            ApiError::Locked
        );
        for kind in ["hotp", "steam", "battlenet"] {
            let state = self::state(kind, 1_700_000_010);
            assert_eq!(
                error(resolve_state(&state, &binding(), &request())),
                ApiError::UnsupportedType
            );
        }
        let state = self::state("totp", 1_700_000_010);
        state.vault.lock().unwrap().data.as_mut().unwrap().tokens[0].digits = 4;
        assert_eq!(
            error(resolve_state(&state, &binding(), &request())),
            ApiError::UnsupportedType
        );
    }
    #[test]
    fn resolver_returns_retry_hint_when_current_window_is_too_short() {
        let state = state("totp", 1_700_000_039);
        state.vault.lock().unwrap().data.as_mut().unwrap().tokens[0].period = 1;
        let result = error(resolve_state(&state, &binding(), &request()));
        assert!(matches!(result, ApiError::ValidityTooShort(2)));
        assert_eq!(result.status().0, 409);
    }

    async fn start(
        resolver: Arc<Resolver>,
    ) -> (SocketAddr, CancellationToken, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let service = Arc::new(Service {
            authorization: Zeroizing::new(format!("Bearer {AUTH}")),
            bindings: [("demo-dev-user".into(), binding())]
                .into_iter()
                .collect(),
            resolver,
            port: address.port(),
        });
        let cancel = CancellationToken::new();
        let task = tokio::spawn(serve(listener, service, cancel.clone()));
        (address, cancel, task)
    }
    fn fake_response(binding: &Binding, _: &ResolveRequest) -> Result<ResolveResponse, ApiError> {
        Ok(ResolveResponse {
            account_alias: binding.account_alias.clone(),
            kind: "totp",
            code: "001234".into(),
            expires_at: "2026-11-04T00:00:30Z".into(),
            server_time: "2026-11-04T00:00:00Z".into(),
        })
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
    }
    async fn post(address: SocketAddr, value: &serde_json::Value) -> reqwest::Response {
        client()
            .post(format!("http://{address}/v1/otp/resolve"))
            .bearer_auth(AUTH)
            .json(value)
            .send()
            .await
            .unwrap()
    }
    async fn raw(address: SocketAddr, text: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(text.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        if let Err(error) = stream.read_to_end(&mut bytes).await {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
            assert!(!bytes.is_empty());
        }
        String::from_utf8(bytes).unwrap()
    }
    #[tokio::test]
    async fn loopback_http_preserves_leading_zeros_and_disables_caching() {
        let (address, cancel, task) = start(Arc::new(fake_response)).await;
        let response = post(address, &body()).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["pragma"], "no-cache");
        let value: serde_json::Value = response.json().await.unwrap();
        assert_eq!(value["code"], "001234");
        assert_eq!(value.as_object().unwrap().len(), 5);
        cancel.cancel();
        task.await.unwrap();
        assert!(TcpStream::connect(address).await.is_err());
    }
    #[tokio::test]
    async fn loopback_http_rejects_auth_scope_origin_unknown_alias_and_secret_fields() {
        let (address, cancel, task) = start(Arc::new(fake_response)).await;
        let url = format!("http://{address}/v1/otp/resolve");
        let response = client()
            .post(&url)
            .bearer_auth("wrong")
            .json(&body())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        assert_eq!(
            response.text().await.unwrap(),
            "{\"error\":\"unauthorized\"}"
        );
        let response = client()
            .post(&url)
            .bearer_auth(AUTH)
            .header("Origin", "https://example.invalid")
            .json(&body())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        let mut value = body();
        value["environment"] = json!("prod");
        assert_eq!(post(address, &value).await.status(), 403);
        value = body();
        value["accountAlias"] = json!("unknown");
        assert_eq!(post(address, &value).await.status(), 404);
        value = body();
        value["secret"] = json!("must-not-be-accepted");
        assert_eq!(post(address, &value).await.status(), 400);
        cancel.cancel();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn loopback_http_has_fixed_locked_error_and_bounded_retry_after() {
        let (address, cancel, task) = start(Arc::new(|_, _| Err(ApiError::Locked))).await;
        let response = post(address, &body()).await;
        assert_eq!(response.status(), 423);
        assert_eq!(response.text().await.unwrap(), "{\"error\":\"locked\"}");
        cancel.cancel();
        task.await.unwrap();
        let (address, cancel, task) =
            start(Arc::new(|_, _| Err(ApiError::ValidityTooShort(4)))).await;
        let response = post(address, &body()).await;
        assert_eq!(response.status(), 409);
        assert_eq!(response.headers()["retry-after"], "4");
        assert_eq!(
            response.text().await.unwrap(),
            "{\"error\":\"validity_too_short\"}"
        );
        cancel.cancel();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn loopback_http_rejects_oversized_and_ambiguous_http_framing() {
        let (address, cancel, task) = start(Arc::new(fake_response)).await;
        let base = format!("POST /v1/otp/resolve HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {AUTH}\r\nContent-Type: application/json\r\n");
        let response = raw(
            address,
            &format!("{base}Content-Length: {}\r\n\r\n", MAX_BODY + 1),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 413"));
        let response = raw(
            address,
            &format!("{base}Content-Length: 0\r\nContent-Length: 0\r\n\r\n"),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 400"));
        let response = raw(
            address,
            &format!("{base}Transfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n"),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 400"));
        cancel.cancel();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn loopback_http_bounds_concurrency_and_cancels_pending_reads_on_shutdown() {
        let (address, cancel, task) = start(Arc::new(fake_response)).await;
        let mut pending = Vec::new();
        for _ in 0..MAX_CONCURRENT {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(b"POST /v1/otp/resolve HTTP/1.1\r\n")
                .await
                .unwrap();
            pending.push(stream);
        }
        // Connecting the next stream happens after the prior sockets have been accepted in order.
        let response = raw(address, "POST /v1/otp/resolve HTTP/1.1\r\n").await;
        assert!(response.starts_with("HTTP/1.1 429"));
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        for mut stream in pending {
            let mut byte = [0; 1];
            match stream.read(&mut byte).await {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                _ => panic!("pending connection must be closed"),
            }
        }
    }
}
