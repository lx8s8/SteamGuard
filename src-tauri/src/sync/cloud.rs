//! Public-client cloud authorization. OAuth tokens never cross the IPC boundary.
use super::*;
use crate::{
    network::{NetworkClient, NetworkSettings},
    AppState,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri_plugin_cloud_auth::CloudAuthExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::ZeroizeOnDrop;

#[cfg(any(target_os = "android", target_os = "ios"))]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub fn initialize(app: tauri::AppHandle) {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = APP.set(app);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = app;
}

#[cfg(desktop)]
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const MICROSOFT_SCOPE: &str =
    "https://graph.microsoft.com/Files.ReadWrite.AppFolder offline_access";
const TOKEN_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Onedrive,
    Dropbox,
}
impl Provider {
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Google => "steamguard-cloud://google/",
            Self::Onedrive => "steamguard-cloud://onedrive/",
            Self::Dropbox => "steamguard-cloud://dropbox/",
        }
    }
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Google => "Google Drive",
            Self::Onedrive => "OneDrive",
            Self::Dropbox => "Dropbox",
        }
    }
    fn client_id(self) -> &'static str {
        match self {
            Self::Google => option_env!("STEAMGUARD_GOOGLE_DESKTOP_CLIENT_ID").unwrap_or(""),
            Self::Onedrive => option_env!("STEAMGUARD_MICROSOFT_CLIENT_ID").unwrap_or(""),
            Self::Dropbox => option_env!("STEAMGUARD_DROPBOX_APP_KEY").unwrap_or(""),
        }
    }
    fn token_url(self) -> &'static str {
        match self {
            Self::Google => "https://oauth2.googleapis.com/token",
            Self::Onedrive => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            Self::Dropbox => "https://api.dropboxapi.com/oauth2/token",
        }
    }
    fn client_secret(self) -> &'static str {
        if self == Self::Google {
            option_env!("STEAMGUARD_GOOGLE_DESKTOP_CLIENT_SECRET").unwrap_or("")
        } else {
            ""
        }
    }
    fn configured(self) -> bool {
        !self.client_id().trim().is_empty()
            && (self != Self::Google || !self.client_secret().is_empty())
    }
    fn supported(self) -> bool {
        true
    }
}
pub fn provider(endpoint: &str) -> Option<Provider> {
    [Provider::Google, Provider::Onedrive, Provider::Dropbox]
        .into_iter()
        .find(|p| p.endpoint() == endpoint)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    provider: Provider,
    name: &'static str,
    configured: bool,
    supported: bool,
}
#[tauri::command]
pub async fn cloud_providers() -> Vec<Availability> {
    let providers = [Provider::Google, Provider::Onedrive, Provider::Dropbox]
        .into_iter()
        .map(|p| {
            let configured = p.configured();
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let configured = if p == Provider::Google {
                APP.get().is_some_and(|a| a.cloud_auth().configured())
            } else {
                configured
            };
            Availability {
                provider: p,
                name: p.name(),
                configured,
                supported: p.supported(),
            }
        })
        .collect::<Vec<_>>();
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let mut providers = providers;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if let Some(app) = APP.get() {
        if let Some(google) = providers
            .iter_mut()
            .find(|p| p.provider == Provider::Google)
        {
            if google.configured {
                google.supported = app.cloud_auth().availability().await.unwrap_or(false);
            }
        }
    }
    providers
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    #[zeroize(skip)]
    pub provider: Provider,
    pub refresh_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub native_account_id: String,
}
impl Credentials {
    pub fn parse(endpoint: &str, bytes: &str) -> Result<Self, String> {
        if bytes.len() > TOKEN_LIMIT {
            return Err("网盘登录凭据无效，请重新登录".into());
        }
        let c: Self = serde_json::from_str(bytes).map_err(|_| "网盘登录凭据无效，请重新登录")?;
        let native = c.provider == Provider::Google
            && !c.native_account_id.is_empty()
            && c.native_account_id.len() <= 1024
            && c.refresh_token.is_empty();
        if Some(c.provider) != provider(endpoint)
            || (!native && (c.refresh_token.is_empty() || !c.native_account_id.is_empty()))
            || c.refresh_token.len() > 16 * 1024
        {
            return Err("网盘登录凭据无效，请重新登录".into());
        }
        Ok(c)
    }
}

enum Flow {
    #[cfg(any(desktop, test))]
    Browser {
        verifier: Zeroizing<String>,
        redirect: String,
        code: Option<Zeroizing<String>>,
    },
    Manual {
        verifier: Zeroizing<String>,
    },
    Device {
        code: Zeroizing<String>,
        interval: u64,
        next: Instant,
    },
    Ready(Zeroizing<String>),
}
struct Pending {
    provider: Provider,
    epoch: u64,
    expires: Instant,
    cancellation: tokio_util::sync::CancellationToken,
    flow: Flow,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
#[derive(Default, Clone)]
pub struct Sessions {
    inner: Arc<Mutex<BTreeMap<String, Pending>>>,
}
impl Sessions {
    pub fn clear(&self) {
        if let Ok(mut m) = self.inner.lock() {
            m.clear();
        }
    }
    pub fn resolve(&self, endpoint: &str, handle: &str, epoch: u64) -> Result<String, String> {
        let m = self.inner.lock().map_err(|_| "网盘登录状态不可用")?;
        let p = m
            .get(handle)
            .filter(|p| {
                p.epoch == epoch
                    && p.expires > Instant::now()
                    && Some(p.provider) == provider(endpoint)
            })
            .ok_or("网盘登录已过期，请重新登录")?;
        match &p.flow {
            Flow::Ready(bytes) => Ok(bytes.to_string()),
            _ => Err("请先完成网盘登录".into()),
        }
    }
    fn replace(&self, old: &str, new: &str) {
        if let Ok(mut m) = self.inner.lock() {
            for p in m.values_mut() {
                if let Flow::Ready(bytes) = &mut p.flow {
                    if bytes.as_str() == old {
                        bytes.zeroize();
                        **bytes = new.into();
                    }
                }
            }
        }
    }
}
fn nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn network(settings: &NetworkSettings) -> Result<NetworkClient, String> {
    let c = NetworkClient::new()?;
    c.configure(settings.clone())?;
    Ok(c)
}
struct SecretJson(serde_json::Value);
impl std::ops::Deref for SecretJson {
    type Target = serde_json::Value;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for SecretJson {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for SecretJson {
    fn drop(&mut self) {
        fn wipe(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::String(s) => s.zeroize(),
                serde_json::Value::Array(items) => items.iter_mut().for_each(wipe),
                serde_json::Value::Object(items) => items.values_mut().for_each(wipe),
                _ => {}
            }
        }
        wipe(&mut self.0);
    }
}
fn take_secret(value: &mut serde_json::Value, key: &str) -> Option<Zeroizing<String>> {
    match value[key].take() {
        serde_json::Value::String(s) => Some(Zeroizing::new(s)),
        _ => None,
    }
}
async fn json(mut response: reqwest::Response) -> Result<(bool, SecretJson), String> {
    let success = response.status().is_success();
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "连接网盘登录服务失败")? {
        if bytes.len() + chunk.len() > TOKEN_LIMIT {
            return Err("网盘登录响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let result = serde_json::from_slice(&bytes).map_err(|_| "无法读取网盘登录响应")?;
    Ok((success, SecretJson(result)))
}
fn login_error(value: &serde_json::Value) -> String {
    match value.get("error").and_then(|v| v.as_str()).unwrap_or("") {
        "access_denied" | "authorization_declined" => "网盘登录已取消",
        "invalid_grant" | "expired_token" => "网盘登录已过期，请重新登录",
        "invalid_client" | "unauthorized_client" => "网盘登录配置无效，请检查 OAuth 客户端登记",
        _ => "网盘登录失败，请重试",
    }
    .into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    handle: String,
    flow: &'static str,
    user_code: Option<String>,
    verification_url: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorized {
    pending: bool,
    handle: String,
    endpoint: String,
    username: String,
}
#[tauri::command]
pub async fn cloud_auth_start(
    app: tauri::AppHandle,
    s: tauri::State<'_, AppState>,
    provider: Provider,
) -> Result<Started, String> {
    let (settings, epoch) = {
        let mut v = s.vault()?;
        let d = v.ensure()?;
        (d.network.clone(), s.epoch.load(Ordering::SeqCst))
    };
    if !provider.supported() {
        return Err("此平台尚未配置 Google 原生登录，请使用 WebDAV 或其他网盘".into());
    }
    s.sync.cloud.clear();
    let handle = uuid::Uuid::new_v4().to_string();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let mut started = Started {
        handle: handle.clone(),
        flow: "browser",
        user_code: None,
        verification_url: None,
    };
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if provider == Provider::Google {
        let app = APP.get().ok_or("网盘登录服务尚未初始化")?;
        if !app.cloud_auth().configured() {
            return Err("此网盘尚未配置 OAuth 客户端，请参阅接入配置文档".into());
        }
        let session = app.cloud_auth().authorize().await?;
        if session.account_id.is_empty()
            || session.account_id.len() > 1024
            || session.access_token.is_empty()
        {
            return Err("网盘登录响应无效".into());
        }
        let credentials = Credentials {
            provider,
            refresh_token: String::new(),
            native_account_id: session.account_id.clone(),
        };
        let bytes =
            Zeroizing::new(serde_json::to_string(&credentials).map_err(|_| "无法保存网盘登录")?);
        {
            let mut v = s.vault()?;
            v.ensure()?;
            if s.epoch.load(Ordering::SeqCst) != epoch {
                return Err("网盘登录已取消".into());
            }
        }
        s.sync
            .cloud
            .inner
            .lock()
            .map_err(|_| "网盘登录状态不可用")?
            .insert(
                handle.clone(),
                Pending {
                    provider,
                    epoch,
                    expires: Instant::now() + Duration::from_secs(600),
                    cancellation,
                    flow: Flow::Ready(bytes),
                },
            );
        started.flow = "complete";
        return Ok(started);
    }
    if !provider.configured() {
        return Err("此网盘尚未配置 OAuth 客户端，请参阅接入配置文档".into());
    }
    let (flow, url) = match provider {
        Provider::Onedrive => {
            let c = network(&settings)?;
            let (ok, value) = json(
                c.post("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")
                    .form(&[
                        ("client_id", provider.client_id()),
                        ("scope", MICROSOFT_SCOPE),
                    ])
                    .send()
                    .await
                    .map_err(|_| "连接网盘登录服务失败")?,
            )
            .await?;
            if !ok {
                return Err(login_error(&value));
            }
            let code = value["device_code"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("网盘登录响应无效")?
                .to_owned();
            let uri = value["verification_uri"]
                .as_str()
                .filter(|s| {
                    [
                        "https://microsoft.com/devicelogin",
                        "https://www.microsoft.com/link",
                        "https://microsoft.com/link",
                    ]
                    .contains(s)
                })
                .ok_or("网盘登录响应地址无效")?
                .to_owned();
            started.flow = "device";
            started.user_code = Some(
                value["user_code"]
                    .as_str()
                    .ok_or("网盘登录响应无效")?
                    .to_owned(),
            );
            started.verification_url = Some(uri.clone());
            (
                Flow::Device {
                    code: Zeroizing::new(code),
                    interval: value["interval"].as_u64().unwrap_or(5).clamp(5, 60),
                    next: Instant::now() + Duration::from_secs(5),
                },
                uri,
            )
        }
        Provider::Dropbox => {
            let verifier = Zeroizing::new(nonce());
            let mut url = url::Url::parse("https://www.dropbox.com/oauth2/authorize").unwrap();
            url.query_pairs_mut().extend_pairs([
                ("client_id", provider.client_id()),
                ("response_type", "code"),
                ("token_access_type", "offline"),
                (
                    "scope",
                    "files.metadata.read files.content.read files.content.write",
                ),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge(&verifier)),
            ]);
            started.flow = "manual";
            (Flow::Manual { verifier }, url.to_string())
        }
        Provider::Google => {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                return Err("此平台尚未配置 Google 原生登录，请使用 WebDAV 或其他网盘".into());
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                    .await
                    .map_err(|_| "无法启动本地网盘登录回调")?;
                let redirect = format!(
                    "http://127.0.0.1:{}/oauth/callback",
                    listener
                        .local_addr()
                        .map_err(|_| "无法启动本地网盘登录回调")?
                        .port()
                );
                let verifier = Zeroizing::new(nonce());
                let state = nonce();
                let mut url =
                    url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
                url.query_pairs_mut().extend_pairs([
                    ("client_id", provider.client_id()),
                    ("redirect_uri", redirect.as_str()),
                    ("response_type", "code"),
                    ("scope", GOOGLE_SCOPE),
                    ("access_type", "offline"),
                    ("prompt", "consent"),
                    ("code_challenge_method", "S256"),
                    ("code_challenge", challenge(&verifier).as_str()),
                    ("state", state.as_str()),
                ]);
                receive_callback(
                    listener,
                    s.sync.cloud.clone(),
                    handle.clone(),
                    state.clone(),
                    cancellation.clone(),
                );
                (
                    Flow::Browser {
                        verifier,
                        redirect,
                        code: None,
                    },
                    url.to_string(),
                )
            }
        }
    };
    {
        let mut v = s.vault()?;
        v.ensure()?;
        if s.epoch.load(Ordering::SeqCst) != epoch {
            return Err("网盘登录已取消".into());
        }
    }
    s.sync
        .cloud
        .inner
        .lock()
        .map_err(|_| "网盘登录状态不可用")?
        .insert(
            handle.clone(),
            Pending {
                provider,
                epoch,
                expires: Instant::now() + Duration::from_secs(600),
                cancellation,
                flow,
            },
        );
    if app.opener().open_url(&url, None::<&str>).is_err() {
        s.sync.cloud.clear();
        return Err("无法打开系统浏览器，请检查默认浏览器设置".into());
    }
    Ok(started)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn receive_callback(
    listener: tokio::net::TcpListener,
    sessions: Sessions,
    handle: String,
    state: String,
    cancel: tokio_util::sync::CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let serve = async {
            loop {
                let Ok((mut socket, peer)) = listener.accept().await else {
                    break;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(Some(request)) = tokio::time::timeout(
                    Duration::from_secs(3),
                    read_callback_request(&mut socket),
                )
                .await
                else {
                    continue;
                };
                let target = std::str::from_utf8(&request)
                    .ok()
                    .and_then(|r| r.lines().next())
                    .and_then(|l| l.strip_prefix("GET "))
                    .and_then(|l| l.strip_suffix(" HTTP/1.1"));
                let code = target.and_then(|t| callback(t, &state));
                let accepted = if let Some(code) = code {
                    if let Ok(mut m) = sessions.inner.lock() {
                        if let Some(p) = m.get_mut(&handle) {
                            if let Flow::Browser { code: result, .. } = &mut p.flow {
                                *result = Some(Zeroizing::new(code));
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };
                let response = if accepted {
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nSteamGuard: return to the app."
                } else {
                    "HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nInvalid authorization callback."
                };
                let _ = socket.write_all(response.as_bytes()).await;
                if accepted {
                    break;
                }
            }
        };
        tokio::select! {_ = cancel.cancelled()=>{},_ = tokio::time::timeout(Duration::from_secs(600),serve)=>{}}
    });
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn read_callback_request(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Option<Zeroizing<Vec<u8>>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Zeroizing::new(Vec::new());
    let mut chunk = Zeroizing::new([0u8; 1024]);
    loop {
        let count = reader.read(chunk.as_mut()).await.ok()?;
        if count == 0 || bytes.len() + count > 8192 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            return Some(bytes);
        }
    }
}
#[cfg(any(desktop, test))]
fn callback(target: &str, state: &str) -> Option<String> {
    if !target.starts_with("/oauth/callback?") {
        return None;
    }
    let u = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let pairs = u.query_pairs().collect::<Vec<_>>();
    if pairs.iter().filter(|(k, _)| k == "state").count() != 1
        || pairs.iter().filter(|(k, _)| k == "code").count() != 1
        || pairs.iter().any(|(k, _)| k == "error")
    {
        return None;
    }
    if pairs.iter().find(|(k, _)| k == "state")?.1 != state {
        return None;
    }
    let code = pairs.iter().find(|(k, _)| k == "code")?.1.to_string();
    if code.is_empty() || code.len() > 8192 {
        None
    } else {
        Some(code)
    }
}

#[tauri::command]
pub fn cloud_auth_cancel(s: tauri::State<AppState>, handle: String) {
    if let Ok(mut m) = s.sync.cloud.inner.lock() {
        m.remove(&handle);
    }
}
#[tauri::command]
pub async fn cloud_auth_poll(
    s: tauri::State<'_, AppState>,
    handle: String,
    code: Option<String>,
) -> Result<Authorized, String> {
    let (settings, epoch) = {
        let mut v = s.vault()?;
        let d = v.ensure()?;
        (d.network.clone(), s.epoch.load(Ordering::SeqCst))
    };
    let manual = Zeroizing::new(code.unwrap_or_default());
    let (provider, fields) = {
        let mut m = s
            .sync
            .cloud
            .inner
            .lock()
            .map_err(|_| "网盘登录状态不可用")?;
        let p = m
            .get_mut(&handle)
            .filter(|p| p.epoch == epoch && p.expires > Instant::now())
            .ok_or("网盘登录已过期，请重新登录")?;
        let provider = p.provider;
        let pending = || Authorized {
            pending: true,
            handle: handle.clone(),
            endpoint: provider.endpoint().into(),
            username: provider.name().into(),
        };
        let fields: Vec<(String, String)> = match &mut p.flow {
            Flow::Ready(_) => {
                return Ok(Authorized {
                    pending: false,
                    ..pending()
                })
            }
            #[cfg(any(desktop, test))]
            Flow::Browser {
                verifier,
                redirect,
                code,
                ..
            } => {
                let Some(code) = code.as_ref() else {
                    return Ok(pending());
                };
                vec![
                    ("grant_type".into(), "authorization_code".into()),
                    ("code".into(), code.to_string()),
                    ("code_verifier".into(), verifier.to_string()),
                    ("redirect_uri".into(), redirect.clone()),
                ]
            }
            Flow::Manual { verifier } => {
                if manual.trim().is_empty() {
                    return Ok(pending());
                }
                if manual.len() > 8192 {
                    return Err("授权码过长".into());
                }
                vec![
                    ("grant_type".into(), "authorization_code".into()),
                    ("code".into(), manual.trim().to_string()),
                    ("code_verifier".into(), verifier.to_string()),
                ]
            }
            Flow::Device {
                code,
                interval,
                next,
            } => {
                if Instant::now() < *next {
                    return Ok(pending());
                }
                *next = Instant::now() + Duration::from_secs(*interval);
                vec![
                    (
                        "grant_type".into(),
                        "urn:ietf:params:oauth:grant-type:device_code".into(),
                    ),
                    ("device_code".into(), code.to_string()),
                ]
            }
        };
        (p.provider, Zeroizing::new(fields))
    };
    let c = network(&settings)?;
    let mut fields = fields;
    fields.push(("client_id".into(), provider.client_id().into()));
    if !provider.client_secret().is_empty() {
        fields.push(("client_secret".into(), provider.client_secret().into()));
    }
    let (ok, mut value) = json(
        c.post(provider.token_url())
            .form(&*fields)
            .send()
            .await
            .map_err(|_| "连接网盘登录服务失败")?,
    )
    .await?;
    if !ok {
        if value["error"] == "authorization_pending" || value["error"] == "slow_down" {
            if value["error"] == "slow_down" {
                if let Ok(mut m) = s.sync.cloud.inner.lock() {
                    if let Some(p) = m.get_mut(&handle) {
                        if let Flow::Device { interval, next, .. } = &mut p.flow {
                            *interval = (*interval + 5).min(60);
                            *next = Instant::now() + Duration::from_secs(*interval);
                        }
                    }
                }
            }
            return Ok(Authorized {
                pending: true,
                handle,
                endpoint: provider.endpoint().into(),
                username: provider.name().into(),
            });
        }
        return Err(login_error(&value));
    }
    let refresh =
        take_secret(&mut value, "refresh_token").ok_or("网盘未授予离线访问权限，请重新授权")?;
    if refresh.is_empty() || refresh.len() > 16 * 1024 {
        return Err("网盘登录凭据无效，请重新登录".into());
    }
    let payload = Zeroizing::new(
        serde_json::to_string(&Credentials {
            provider,
            refresh_token: refresh.to_string(),
            native_account_id: String::new(),
        })
        .map_err(|_| "无法保存网盘登录")?,
    );
    {
        let mut v = s.vault()?;
        v.ensure()?;
        if s.epoch.load(Ordering::SeqCst) != epoch {
            return Err("网盘登录已取消".into());
        }
    }
    let mut m = s
        .sync
        .cloud
        .inner
        .lock()
        .map_err(|_| "网盘登录状态不可用")?;
    let p = m.get_mut(&handle).ok_or("网盘登录已取消")?;
    p.flow = Flow::Ready(payload);
    Ok(Authorized {
        pending: false,
        handle,
        endpoint: provider.endpoint().into(),
        username: provider.name().into(),
    })
}

/// Refresh using the public native client, retaining rotated refresh tokens in the
/// encrypted vault before returning an operator. No OpenDAL token logging is enabled.
pub async fn operator(
    s: &AppState,
    endpoint: &str,
    password: &str,
    settings: &NetworkSettings,
) -> Result<(opendal::Operator, Zeroizing<String>), String> {
    let mut credentials = Credentials::parse(endpoint, password)?;
    let p = credentials.provider;
    if !credentials.native_account_id.is_empty() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let app = APP.get().ok_or("网盘登录服务尚未初始化")?;
            let epoch = s.epoch.load(Ordering::SeqCst);
            let session = app
                .cloud_auth()
                .token(&credentials.native_account_id)
                .await?;
            if session.account_id != credentials.native_account_id
                || session.access_token.is_empty()
            {
                return Err("网盘登录账号已变化，请重新登录".into());
            }
            {
                let mut v = s.vault()?;
                v.ensure()?;
                if s.epoch.load(Ordering::SeqCst) != epoch {
                    return Err("同步已取消，请解锁后重试".into());
                }
            }
            return Ok((
                storage::cloud_client(p, &session.access_token, "/", settings)?,
                Zeroizing::new(password.into()),
            ));
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        return Err("请在此设备重新登录网盘".into());
    }
    if !p.configured() {
        return Err("此网盘尚未配置 OAuth 客户端，请参阅接入配置文档".into());
    }
    let epoch = s.epoch.load(Ordering::SeqCst);
    let c = network(settings)?;
    let mut fields = Zeroizing::new(vec![
        ("grant_type".to_owned(), "refresh_token".to_owned()),
        ("refresh_token".into(), credentials.refresh_token.clone()),
        ("client_id".into(), p.client_id().into()),
    ]);
    if !p.client_secret().is_empty() {
        fields.push(("client_secret".into(), p.client_secret().into()));
    }
    let (ok, mut value) = json(
        c.post(p.token_url())
            .form(&*fields)
            .send()
            .await
            .map_err(|_| "连接网盘登录服务失败")?,
    )
    .await?;
    if !ok {
        return Err(login_error(&value));
    }
    let access = take_secret(&mut value, "access_token")
        .filter(|s| !s.is_empty() && s.len() <= 16 * 1024)
        .ok_or("网盘登录响应无效")?;
    if let Some(refresh) = take_secret(&mut value, "refresh_token") {
        if !refresh.is_empty() && refresh.len() <= 16 * 1024 {
            credentials.refresh_token.zeroize();
            credentials.refresh_token = refresh.to_string();
        }
    }
    let updated =
        Zeroizing::new(serde_json::to_string(&credentials).map_err(|_| "无法保存网盘登录")?);
    {
        let mut v = s.vault()?;
        let d = v.ensure()?;
        if s.epoch.load(Ordering::SeqCst) != epoch {
            return Err("同步已取消，请解锁后重试".into());
        }
        if d.sync
            .as_ref()
            .is_some_and(|c| c.endpoint == endpoint && c.password == password)
            && updated.as_str() != password
        {
            v.update(|d| {
                let c = d.sync.as_mut().ok_or("同步已断开")?;
                c.password.zeroize();
                c.password = updated.to_string();
                Ok(())
            })?;
        }
    }
    s.sync.cloud.replace(password, &updated);
    let root = if p == Provider::Onedrive {
        let (ok, value) = json(
            c.get("https://graph.microsoft.com/v1.0/me/drive/special/approot")
                .bearer_auth(access.as_str())
                .query(&[("$select", "name,parentReference")])
                .send()
                .await
                .map_err(|_| "无法读取网盘应用目录")?,
        )
        .await?;
        if !ok {
            return Err("无法读取网盘应用目录，请检查授权权限".into());
        }
        onedrive_root(&value)?
    } else {
        "/".into()
    };
    Ok((storage::cloud_client(p, &access, &root, settings)?, updated))
}

fn onedrive_root(value: &serde_json::Value) -> Result<String, String> {
    let name = value["name"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 255
                && !s.contains(['/', '\\'])
                && ![".", ".."].contains(s)
                && !s.chars().any(char::is_control)
        })
        .ok_or("网盘应用目录无效")?;
    // Special folders can be moved or renamed. Resolve their actual parent on
    // every connection instead of assuming the default /Apps location. Graph's
    // parentReference.path is percent-encoded; OpenDAL expects a decoded root.
    let parent = onedrive_parent_path(
        value["parentReference"]["path"]
            .as_str()
            .ok_or("网盘应用目录无效")?,
    )?;
    Ok(format!("{parent}/{name}/"))
}

pub(super) fn onedrive_parent_path(parent: &str) -> Result<String, String> {
    if parent.len() > 8192 {
        return Err("网盘应用目录无效".into());
    }
    let (prefix, path) = parent.split_once(':').ok_or("网盘应用目录无效")?;
    if !["/drive/root", "/me/drive/root"].contains(&prefix)
        && !prefix
            .strip_prefix("/drives/")
            .and_then(|v| v.strip_suffix("/root"))
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
    {
        return Err("网盘应用目录无效".into());
    }
    let mut root = String::new();
    if !path.is_empty() && path != "/" {
        let path = path.strip_prefix('/').ok_or("网盘应用目录无效")?;
        for part in path.split('/') {
            let bytes = part.as_bytes();
            if bytes.iter().enumerate().any(|(i, b)| {
                *b == b'%'
                    && !(bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                        && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit))
            }) {
                return Err("网盘应用目录无效".into());
            }
            let part = percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .map_err(|_| "网盘应用目录无效")?;
            if part.is_empty()
                || [".", ".."].contains(&part.as_ref())
                || part.contains(['/', '\\'])
                || part.chars().any(char::is_control)
            {
                return Err("网盘应用目录无效".into());
            }
            root.push('/');
            root.push_str(&part);
        }
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_rfc7636_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn callback_binds_state_and_rejects_duplicate_parameters() {
        assert_eq!(
            callback("/oauth/callback?code=abc%2Bdef&state=expected", "expected"),
            Some("abc+def".into())
        );
        for t in [
            "/oauth/callback?code=abc&state=wrong",
            "/oauth/callback?code=a&state=expected&state=expected",
            "/oauth/callback?code=a&code=b&state=expected",
            "/wrong?code=a&state=expected",
            "/oauth/callback?code=a&state=expected&error=access_denied",
        ] {
            assert!(callback(t, "expected").is_none());
        }
    }
    #[test]
    fn provider_credentials_are_strict_and_never_in_connection_endpoint() {
        let bytes = r#"{"provider":"dropbox","refreshToken":"synthetic-token"}"#;
        assert!(Credentials::parse(Provider::Dropbox.endpoint(), bytes).is_ok());
        assert!(Credentials::parse(Provider::Google.endpoint(), bytes).is_err());
        assert!(Credentials::parse(
            Provider::Dropbox.endpoint(),
            r#"{"provider":"dropbox","refreshToken":"x","accessToken":"x"}"#
        )
        .is_err());
        assert!(provider("steamguard-cloud://dropbox/extra").is_none());
    }
    #[test]
    fn auth_handles_expire_and_clear_on_lock() {
        let sessions = Sessions::default();
        let handle = uuid::Uuid::new_v4().to_string();
        sessions.inner.lock().unwrap().insert(
            handle.clone(),
            Pending {
                provider: Provider::Dropbox,
                epoch: 42,
                expires: Instant::now() + Duration::from_secs(60),
                cancellation: tokio_util::sync::CancellationToken::new(),
                flow: Flow::Ready(Zeroizing::new("synthetic-only".into())),
            },
        );
        assert!(sessions
            .resolve(Provider::Dropbox.endpoint(), &handle, 41)
            .is_err());
        assert_eq!(
            sessions
                .resolve(Provider::Dropbox.endpoint(), &handle, 42)
                .unwrap(),
            "synthetic-only"
        );
        sessions.clear();
        assert!(sessions
            .resolve(Provider::Dropbox.endpoint(), &handle, 42)
            .is_err());
    }
    #[test]
    fn native_google_credentials_cannot_mix_refresh_tokens_or_other_providers() {
        let native =
            r#"{"provider":"google","refreshToken":"","nativeAccountId":"synthetic-account"}"#;
        assert!(Credentials::parse(Provider::Google.endpoint(), native).is_ok());
        assert!(Credentials::parse(Provider::Dropbox.endpoint(), native).is_err());
        assert!(Credentials::parse(Provider::Google.endpoint(),r#"{"provider":"google","refreshToken":"unexpected","nativeAccountId":"synthetic-account"}"#).is_err());
    }
    #[test]
    fn onedrive_uses_the_returned_application_folder_without_path_escape() {
        assert_eq!(
            onedrive_root(&serde_json::json!({"name":"Authenticator", "parentReference":{"path":"/drive/root:/Apps"}})).unwrap(),
            "/Apps/Authenticator/"
        );
        for name in ["", ".", "..", "../Documents", "a/b", "a\\b"] {
            assert!(onedrive_root(&serde_json::json!({"name":name})).is_err());
        }
        assert_eq!(onedrive_root(&serde_json::json!({"name":"新名称", "parentReference":{"path":"/drive/root:/Moved%20folder/%E5%B7%A5%E4%BD%9C"}})).unwrap(), "/Moved folder/工作/新名称/");
        assert_eq!(onedrive_root(&serde_json::json!({"name":"a+b%folder", "parentReference":{"path":"/drives/drive-id/root:"}})).unwrap(), "/a+b%folder/");
        for path in [
            "https://other/root:/Apps",
            "/drive/root:relative",
            "/drive/root:/..",
            "/drive/root:/%2E%2E",
            "/drive/root:/a%2Fb",
            "/drive/root:/a%5Cb",
            "/drive/root:/a%00b",
            "/drive/root:/%FF",
            "/drive/root:/%QZ",
            "/drive/root:/a//b",
        ] {
            assert!(
                onedrive_root(&serde_json::json!({"name":"App", "parentReference":{"path":path}}))
                    .is_err(),
                "{path}"
            );
        }
    }
    #[tokio::test]
    async fn availability_is_bound_to_our_compiled_public_client_configuration() {
        let list = cloud_providers().await;
        assert_eq!(list.len(), 3);
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        assert_eq!(list[0].configured, Provider::Google.configured());
        assert_eq!(
            list[1].configured,
            !Provider::Onedrive.client_id().is_empty()
        );
        assert_eq!(
            list[2].configured,
            !Provider::Dropbox.client_id().is_empty()
        );
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test]
    async fn callback_reads_fragmented_headers_and_rejects_oversized_requests() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, mut reader) = tokio::io::duplex(64);
        let task = tokio::spawn(async move {
            writer
                .write_all(b"GET /oauth/callback?code=synthetic&state=expected HTTP/1.1\r\n")
                .await
                .unwrap();
            tokio::task::yield_now().await;
            writer.write_all(b"Host: 127.0.0.1\r\n\r\n").await.unwrap();
        });
        let bytes = read_callback_request(&mut reader).await.unwrap();
        assert!(bytes.ends_with(b"\r\n\r\n"));
        task.await.unwrap();
        let mut oversized = std::io::Cursor::new(vec![b'a'; 8193]);
        assert!(read_callback_request(&mut oversized).await.is_none());
    }
}
