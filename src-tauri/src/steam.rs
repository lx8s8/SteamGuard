//! Steam mobile authentication and confirmations. Adapted from the protocols used
//! by SteamKit, steam-session and WattToolkit; credentials remain in Rust.
use crate::network::{NetworkClient, NetworkSettings};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use hmac::{Hmac, Mac};
use prost::Message;
use rand::{rngs::OsRng, RngCore};
use reqwest::header;
use rsa::{BigUint, Pkcs1v15Encrypt, RsaPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, ZeroizeOnDrop};

const MOBILE_COOKIE: &str = "mobileClient=android; mobileClientVersion=777777%203.10.3";
const API: &str = "https://api.steampowered.com";
const COMMUNITY: &str = "https://steamcommunity.com";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardOption {
    pub confirmation_type: u32,
    pub associated_message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub status: String,
    pub steam_id: Option<String>,
    pub username: Option<String>,
    pub guards: Vec<GuardOption>,
    /// Milliseconds. Callers must respect this interval before polling again.
    pub poll_interval: u64,
    pub qr_url: Option<String>,
    pub message: Option<String>,
    pub guard_submitted: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub id: String,
    pub nonce: String,
    pub kind: u32,
    pub type_name: String,
    pub headline: String,
    pub summary: Vec<String>,
    pub creation_time: u64,
    pub icon: String,
}

/// Contains credentials: serialize only into the encrypted native vault.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SteamSession {
    pub steam_id: String,
    pub account_name: String,
    pub access_token: String,
    pub refresh_token: String,
    pub session_id: String,
    #[serde(default)]
    pub local_guard_verified: bool,
}

/// Returned only to native commands, which must save this into the encrypted vault.
/// Never serialize shared_secret or identity_secret into a webview response.
pub struct EnrollmentSecret {
    pub shared_secret: Vec<u8>,
    pub identity_secret: Vec<u8>,
    pub steam_id: String,
    pub account_name: String,
    pub serial_number: String,
    pub revocation_code: String,
    pub device_id: String,
    pub token_gid: String,
    pub server_time: u64,
    pub phone_number_hint: String,
}

#[derive(Clone)]
struct Pending {
    generation: u64,
    client_id: u64,
    request_id: Vec<u8>,
    steam_id: Option<String>,
    expected_id: Option<String>,
    username: Option<String>,
    guards: Vec<GuardOption>,
    interval: u64,
    qr_url: Option<String>,
    created: Instant,
    last_poll: Option<Instant>,
    message: Option<String>,
    guard_submitted: bool,
    local_guard_verified: bool,
}
impl Pending {
    fn status(&self) -> LoginStatus {
        LoginStatus {
            status: if !self.guard_submitted
                && self
                    .guards
                    .iter()
                    .any(|g| [2, 3].contains(&g.confirmation_type))
            {
                "guard"
            } else {
                "pending"
            }
            .into(),
            steam_id: self.steam_id.clone(),
            username: self.username.clone(),
            guards: self.guards.clone(),
            poll_interval: self.interval,
            qr_url: self.qr_url.clone(),
            message: self.message.clone(),
            guard_submitted: self.guard_submitted,
        }
    }
}

enum ApiFailure {
    Other(String),
    Steam { result: u32, operation: String },
}
impl From<String> for ApiFailure {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}
impl ApiFailure {
    fn message(self) -> String {
        match self {
            Self::Other(message) => message,
            Self::Steam { result, operation } => format!(
                "{operation}失败：{}（EResult {result}）",
                steam_error(result)
            ),
        }
    }
    fn guard_retry(&self) -> bool {
        matches!(
            self,
            Self::Steam {
                result: 65 | 71 | 85 | 88 | 89 | 93,
                ..
            }
        )
    }
}

pub struct SteamService {
    #[cfg(test)]
    api_base: String,
    lifecycle: Mutex<()>,
    generations: Mutex<HashMap<String, u64>>,
    next_generation: AtomicU64,
    client: NetworkClient,
    pending: Mutex<HashMap<String, Pending>>,
    sessions: Mutex<HashMap<String, SteamSession>>,
    confirmations: Mutex<HashMap<String, Vec<Confirmation>>>,
    reviewed_qr: Mutex<HashMap<String, (String, u64, Instant)>>,
}

impl SteamService {
    pub fn new() -> Result<Self, String> {
        let client = NetworkClient::new()?;
        Ok(Self {
            #[cfg(test)]
            api_base: API.into(),
            lifecycle: Mutex::new(()),
            generations: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
            client,
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            confirmations: Mutex::new(HashMap::new()),
            reviewed_qr: Mutex::new(HashMap::new()),
        })
    }

    pub fn network_settings(&self) -> NetworkSettings {
        self.client.settings()
    }
    pub fn configure_network(&self, settings: NetworkSettings) -> Result<(), String> {
        self.client.configure(settings)
    }

    pub async fn network_diagnostics(&self) -> Result<NetworkReport, String> {
        let settings = self.client.settings();
        // Re-read desktop system proxy settings after the user changes their VPN/proxy.
        self.client.configure(settings.clone())?;
        let started = Instant::now();
        let rsa: Result<RsaKeyResponse, String> = self
            .api(
                "Authentication",
                "GetPasswordRSAPublicKey",
                RsaKeyRequest {
                    account_name: "steamguard_protocol_probe".into(),
                },
                None,
            )
            .await;
        let mut checks = vec![NetworkCheck::from_result(
            "Steam 认证接口",
            started,
            rsa.and_then(|r| {
                if r.modulus.is_empty() {
                    Err("Steam 未返回登录公钥".into())
                } else {
                    Ok(())
                }
            }),
        )];
        if checks[0].ok {
            let started = Instant::now();
            let time = self.server_time().await.map(|_| ());
            checks.push(NetworkCheck::from_result("Steam 时间校准", started, time));
        }
        let started = Instant::now();
        let community = match self
            .client
            .get(COMMUNITY)
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() || r.status().is_redirection() => Ok(()),
            Ok(r) => Err(format!("Steam 社区返回 HTTP {}", r.status().as_u16())),
            Err(e) => Err(network_error(e, "访问 Steam 社区")),
        };
        checks.push(NetworkCheck::from_result("Steam 社区", started, community));
        Ok(NetworkReport {
            platform: std::env::consts::OS.into(),
            mode: settings.mode,
            checks,
        })
    }

    pub fn is_logged_in(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }
    pub fn logout(&self, id: &str) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.generations.lock().unwrap().remove(id);
        self.sessions.lock().unwrap().remove(id);
        self.pending.lock().unwrap().remove(id);
        self.confirmations.lock().unwrap().remove(id);
        self.reviewed_qr.lock().unwrap().remove(id);
    }
    pub fn clear(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.generations.lock().unwrap().clear();
        self.sessions.lock().unwrap().clear();
        self.pending.lock().unwrap().clear();
        self.confirmations.lock().unwrap().clear();
        self.reviewed_qr.lock().unwrap().clear();
    }
    pub fn export_session(&self, id: &str) -> Option<SteamSession> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    pub fn restore_session(
        &self,
        id: &str,
        session: SteamSession,
        expected_id: Option<&str>,
    ) -> Result<(), String> {
        check_identity(&session.steam_id, expected_id)?;
        check_mobile_token(&session.access_token, &session.steam_id)?;
        let _lifecycle = self.lifecycle.lock().unwrap();
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        self.generations
            .lock()
            .unwrap()
            .insert(id.into(), generation);
        self.pending.lock().unwrap().remove(id);
        self.sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), session);
        Ok(())
    }

    fn start_challenge(&self, id: &str) -> u64 {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        self.generations
            .lock()
            .unwrap()
            .insert(id.into(), generation);
        self.pending.lock().unwrap().remove(id);
        self.sessions.lock().unwrap().remove(id);
        self.confirmations.lock().unwrap().remove(id);
        self.reviewed_qr.lock().unwrap().remove(id);
        generation
    }

    fn generation(&self, id: &str) -> Result<u64, String> {
        self.generations
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .ok_or_else(|| "Steam 登录已取消".into())
    }

    fn ensure_generation(&self, id: &str, generation: u64) -> Result<(), String> {
        if self.generation(id)? != generation {
            return Err("Steam 登录已取消或已被新的登录替换".into());
        }
        Ok(())
    }

    fn install_pending(&self, id: &str, pending: Pending) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_generation(id, pending.generation)?;
        self.pending.lock().unwrap().insert(id.into(), pending);
        Ok(())
    }

    fn api_base(&self) -> &str {
        #[cfg(test)]
        {
            &self.api_base
        }
        #[cfg(not(test))]
        {
            API
        }
    }
    async fn api<Req: Message, Res: Message + Default>(
        &self,
        service: &str,
        method: &str,
        request: Req,
        access: Option<&str>,
    ) -> Result<Res, String> {
        self.api_detailed(service, method, request, access)
            .await
            .map_err(ApiFailure::message)
    }
    async fn api_detailed<Req: Message, Res: Message + Default>(
        &self,
        service: &str,
        method: &str,
        request: Req,
        access: Option<&str>,
    ) -> Result<Res, ApiFailure> {
        let url = format!("{}/I{service}Service/{method}/v1/", self.api_base());
        let encoded = STANDARD.encode(request.encode_to_vec());
        let mut req = if method == "GetPasswordRSAPublicKey" {
            self.client.get(url).query(&[
                ("input_protobuf_encoded", encoded.as_str()),
                ("origin", "SteamMobile"),
            ])
        } else {
            self.client
                .post(url)
                .form(&[("input_protobuf_encoded", encoded.as_str())])
        }
        .header(header::COOKIE, MOBILE_COOKIE)
        .query(&[("format", "protobuf")]);
        if let Some(token) = access {
            req = req.query(&[("access_token", token)]);
        }
        let response = req
            .send()
            .await
            .map_err(|error| network_error(error, &format!("{service}.{method}")))?;
        if !response.status().is_success() {
            return Err(format!(
                "{}失败（Steam HTTP {}）",
                operation_label(method),
                response.status().as_u16()
            )
            .into());
        }
        if let Some(result) = response
            .headers()
            .get("x-eresult")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok())
        {
            if result != 1 {
                return Err(ApiFailure::Steam {
                    result,
                    operation: operation_label(method).into(),
                });
            }
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Steam 响应读取失败".to_string())?;
        Res::decode(bytes).map_err(|_| ApiFailure::Other("Steam 返回了无法识别的协议数据".into()))
    }

    pub async fn begin_login(
        &self,
        id: &str,
        username: &str,
        password: &str,
        expected_steam_id: Option<&str>,
        automatic_guard: Option<&crate::models::Token>,
    ) -> Result<LoginStatus, String> {
        if username.trim().is_empty() || password.is_empty() {
            return Err("请输入 Steam 登录名和密码".into());
        }
        let generation = self.start_challenge(id);
        let key: RsaKeyResponse = self
            .api(
                "Authentication",
                "GetPasswordRSAPublicKey",
                RsaKeyRequest {
                    account_name: username.trim().into(),
                },
                None,
            )
            .await?;
        let modulus =
            BigUint::parse_bytes(key.modulus.as_bytes(), 16).ok_or("Steam RSA 密钥无效")?;
        let exponent =
            BigUint::parse_bytes(key.exponent.as_bytes(), 16).ok_or("Steam RSA 密钥无效")?;
        self.ensure_generation(id, generation)?;
        let rsa = RsaPublicKey::new(modulus, exponent).map_err(|_| "Steam RSA 密钥无效")?;
        let encrypted = rsa
            .encrypt(&mut OsRng, Pkcs1v15Encrypt, password.as_bytes())
            .map_err(|_| "Steam 密码加密失败")?;
        let begin: BeginCredentialsResponse = self
            .api(
                "Authentication",
                "BeginAuthSessionViaCredentials",
                BeginCredentialsRequest {
                    device_friendly_name: "SteamGuard".into(),
                    platform_type: 3,
                    account_name: username.trim().into(),
                    encrypted_password: STANDARD.encode(encrypted),
                    encryption_timestamp: key.timestamp,
                    remember_login: true,
                    persistence: 1,
                    website_id: "Mobile".into(),
                    device_details: Some(DeviceDetails::mobile()),
                },
                None,
            )
            .await?;
        if begin.steam_id == 0 || begin.client_id == 0 || begin.request_id.is_empty() {
            return Err("Steam 登录会话不完整，请重试".into());
        }
        let steam_id = begin.steam_id.to_string();
        // Do not submit this authenticator's automatic code until the remote account matches.
        check_identity(&steam_id, expected_steam_id)?;
        let pending = Pending {
            generation,
            client_id: begin.client_id,
            request_id: begin.request_id,
            steam_id: Some(steam_id),
            expected_id: expected_steam_id.map(String::from),
            username: Some(username.trim().to_string()),
            guards: begin.allowed.into_iter().map(GuardOption::from).collect(),
            interval: poll_interval(begin.interval),
            qr_url: None,
            created: Instant::now(),
            last_poll: None,
            message: None,
            guard_submitted: false,
            local_guard_verified: false,
        };
        let result = pending.status();
        let can_auto = automatic_guard.is_some_and(|token| {
            crate::models::known_steam_id(expected_steam_id).is_some()
                || token
                    .account_name
                    .as_deref()
                    .is_some_and(|name| name.trim().eq_ignore_ascii_case(username.trim()))
        }) && pending
            .guards
            .iter()
            .any(|guard| guard.confirmation_type == 3);
        self.install_pending(id, pending)?;
        if can_auto {
            if let Some(token) = automatic_guard {
                return match self
                    .submit_local_guard_for(id, token, Some(generation))
                    .await
                {
                    Ok(status) => Ok(status),
                    Err(error) => self.guard_retry_status(
                        id,
                        generation,
                        format!("自动令牌验证未完成：{error}。可以在此继续验证。"),
                    ),
                };
            }
        }
        Ok(result)
    }

    pub async fn begin_qr(
        &self,
        id: &str,
        expected_steam_id: Option<&str>,
    ) -> Result<LoginStatus, String> {
        let generation = self.start_challenge(id);
        let result: BeginQrResponse = self
            .api(
                "Authentication",
                "BeginAuthSessionViaQR",
                BeginQrRequest {
                    device_friendly_name: "SteamGuard".into(),
                    platform_type: 3,
                    website_id: "Mobile".into(),
                    device_details: Some(DeviceDetails::mobile()),
                },
                None,
            )
            .await?;
        if result.client_id == 0 || result.request_id.is_empty() {
            return Err("Steam 二维码会话不完整".into());
        }
        parse_qr_url(&result.challenge_url)?;
        let pending = Pending {
            generation,
            client_id: result.client_id,
            request_id: result.request_id,
            steam_id: None,
            expected_id: expected_steam_id.map(String::from),
            username: None,
            guards: result.allowed.into_iter().map(GuardOption::from).collect(),
            interval: poll_interval(result.interval),
            qr_url: Some(result.challenge_url),
            created: Instant::now(),
            last_poll: None,
            message: None,
            guard_submitted: false,
            local_guard_verified: false,
        };
        let status = pending.status();
        self.install_pending(id, pending)?;
        Ok(status)
    }

    pub async fn submit_guard(
        &self,
        id: &str,
        code: &str,
        code_type: u32,
        token: Option<&crate::models::Token>,
    ) -> Result<LoginStatus, String> {
        let pending = self.pending_for(id)?;
        let mut local = false;
        if let Some(token) = token {
            if token.kind != "steam" {
                return Err("请选择 Steam 令牌".into());
            }
            check_identity(
                pending
                    .steam_id
                    .as_deref()
                    .ok_or("请使用手机批准二维码登录")?,
                token.steam_id.as_deref(),
            )?;
            if code_type == 3 {
                let now = self
                    .server_time()
                    .await
                    .unwrap_or_else(|_| crate::models::now());
                local = [now.saturating_sub(30), now, now.saturating_add(30)]
                    .iter()
                    .any(|&time| {
                        crate::otp::code(token, time)
                            .is_ok_and(|current| current.eq_ignore_ascii_case(code.trim()))
                    });
            }
        }
        self.submit_guard_for(id, code, code_type, Some(pending.generation), local)
            .await
    }
    pub async fn submit_local_guard(
        &self,
        id: &str,
        token: &crate::models::Token,
    ) -> Result<LoginStatus, String> {
        self.submit_local_guard_for(id, token, None).await
    }
    async fn submit_local_guard_for(
        &self,
        id: &str,
        token: &crate::models::Token,
        expected_generation: Option<u64>,
    ) -> Result<LoginStatus, String> {
        if token.kind != "steam" {
            return Err("请选择 Steam 令牌".into());
        }
        let pending = self.pending_for(id)?;
        if expected_generation.is_some_and(|g| g != pending.generation) {
            return Err("Steam 登录已被替换，请重新验证".into());
        }
        check_identity(
            pending
                .steam_id
                .as_deref()
                .ok_or("二维码登录请在 Steam 手机应用中批准")?,
            token.steam_id.as_deref(),
        )?;
        // Generate after RSA/auth-session requests, using Steam time rather than a
        // code captured before a slow proxy request or from an unsynchronized PC.
        let now = self.server_time().await?;
        let code = zeroize::Zeroizing::new(crate::otp::code(token, now)?);
        self.submit_guard_for(id, &code, 3, Some(pending.generation), true)
            .await
    }
    fn guard_retry_status(
        &self,
        id: &str,
        generation: u64,
        message: String,
    ) -> Result<LoginStatus, String> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_generation(id, generation)?;
        let mut all = self.pending.lock().unwrap();
        let pending = all.get_mut(id).ok_or("请重新开始 Steam 登录")?;
        pending.message = Some(message);
        pending.guard_submitted = false;
        Ok(pending.status())
    }
    async fn submit_guard_for(
        &self,
        id: &str,
        code: &str,
        code_type: u32,
        expected_generation: Option<u64>,
        local: bool,
    ) -> Result<LoginStatus, String> {
        if ![2, 3].contains(&code_type) {
            return Err("不支持的 Steam 验证码类型".into());
        }
        if code.trim().is_empty() || code.len() > 20 {
            return Err("请输入有效的 Steam 验证码".into());
        }
        let pending = self.pending_for(id)?;
        if expected_generation.is_some_and(|g| g != pending.generation) {
            return Err("Steam 登录已被替换，请重新验证".into());
        }
        self.ensure_generation(id, pending.generation)?;
        if !pending
            .guards
            .iter()
            .any(|g| g.confirmation_type == code_type)
        {
            return Err("当前登录会话不支持此验证方式".into());
        }
        let steam_id = pending
            .steam_id
            .as_deref()
            .and_then(|s| s.parse().ok())
            .ok_or("二维码登录请使用 Steam 手机 App 扫描确认")?;
        let response: Result<Empty, ApiFailure> = self
            .api_detailed(
                "Authentication",
                "UpdateAuthSessionWithSteamGuardCode",
                UpdateGuardRequest {
                    client_id: pending.client_id,
                    steam_id,
                    code: code.trim().to_uppercase(),
                    code_type,
                },
                None,
            )
            .await;
        if let Err(error) = response {
            if error.guard_retry() {
                return self.guard_retry_status(id, pending.generation, error.message());
            }
            return Err(error.message());
        }
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(id, pending.generation)?;
            let mut all = self.pending.lock().unwrap();
            let current = all.get_mut(id).ok_or("登录会话已结束，请重新登录")?;
            current.message = None;
            current.guard_submitted = true;
            current.local_guard_verified |= local;
        }
        // Keep the same challenge. Retrying a login would invalidate emailed codes.
        self.ensure_generation(id, pending.generation)?;
        self.poll_login_for(id, Some(pending.generation)).await
    }

    fn pending_for(&self, id: &str) -> Result<Pending, String> {
        let mut all = self.pending.lock().unwrap();
        if all
            .get(id)
            .is_some_and(|p| p.created.elapsed() > Duration::from_secs(180))
        {
            all.remove(id);
            return Err("Steam 登录已超时，请重新登录".into());
        }
        all.get(id)
            .cloned()
            .ok_or_else(|| "请先开始 Steam 登录".into())
    }

    pub async fn poll_login(&self, id: &str) -> Result<LoginStatus, String> {
        self.poll_login_for(id, None).await
    }

    async fn poll_login_for(
        &self,
        id: &str,
        expected_generation: Option<u64>,
    ) -> Result<LoginStatus, String> {
        let pending = self.pending_for(id)?;
        if expected_generation.is_some_and(|g| g != pending.generation) {
            return Err("Steam 登录已被替换，请重新验证".into());
        }
        self.ensure_generation(id, pending.generation)?;
        if pending
            .last_poll
            .is_some_and(|t| t.elapsed() < Duration::from_millis(pending.interval))
        {
            return Ok(pending.status());
        }
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(id, pending.generation)?;
            if let Some(p) = self.pending.lock().unwrap().get_mut(id) {
                p.last_poll = Some(Instant::now());
            }
        }
        let response: Result<PollResponse, ApiFailure> = self
            .api_detailed(
                "Authentication",
                "PollAuthSessionStatus",
                PollRequest {
                    client_id: pending.client_id,
                    request_id: pending.request_id.clone(),
                },
                None,
            )
            .await;
        let result = match response {
            Ok(result) => result,
            Err(error) if error.guard_retry() => {
                return self.guard_retry_status(id, pending.generation, error.message())
            }
            Err(error) => return Err(error.message()),
        };
        if result.access_token.is_empty() && result.refresh_token.is_empty() {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(id, pending.generation)?;
            let mut all = self.pending.lock().unwrap();
            if let Some(p) = all.get_mut(id) {
                if result.new_client_id != 0 {
                    p.client_id = result.new_client_id;
                }
                if !result.new_challenge_url.is_empty() {
                    parse_qr_url(&result.new_challenge_url)?;
                    p.qr_url = Some(result.new_challenge_url);
                }
                return Ok(p.status());
            }
            return Err("登录已取消".into());
        }
        let payload = jwt_payload(if !result.access_token.is_empty() {
            &result.access_token
        } else {
            &result.refresh_token
        })?;
        let steam_id = payload["sub"]
            .as_str()
            .ok_or("Steam 登录状态缺少账号标识")?
            .to_string();
        check_identity(&steam_id, pending.expected_id.as_deref())?;
        check_identity(&steam_id, pending.steam_id.as_deref())?;
        let mut session = SteamSession {
            steam_id: steam_id.clone(),
            account_name: if result.account_name.is_empty() {
                pending.username.unwrap_or_default()
            } else {
                result.account_name
            },
            access_token: result.access_token,
            refresh_token: result.refresh_token,
            session_id: random_hex(12),
            local_guard_verified: false,
        };
        if session.access_token.is_empty() {
            self.refresh_session(&mut session).await?;
        }
        check_mobile_token(&session.access_token, &steam_id)?;
        let username = session.account_name.clone();
        // The challenge generation and session insertion share the cancellation lock.
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_generation(id, pending.generation)?;
        let completed = self
            .pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or("登录已取消")?;
        session.local_guard_verified = completed.local_guard_verified;
        self.sessions.lock().unwrap().insert(id.into(), session);
        Ok(LoginStatus {
            status: "authenticated".into(),
            steam_id: Some(steam_id),
            username: Some(username),
            guards: vec![],
            poll_interval: pending.interval,
            qr_url: None,
            message: None,
            guard_submitted: true,
        })
    }

    async fn refresh_session(&self, session: &mut SteamSession) -> Result<(), String> {
        if session.refresh_token.is_empty() {
            return Err("Steam 登录已过期，请重新登录".into());
        }
        let response: AccessTokenResponse = self
            .api(
                "Authentication",
                "GenerateAccessTokenForApp",
                AccessTokenRequest {
                    refresh_token: session.refresh_token.clone(),
                    steam_id: session.steam_id.parse().map_err(|_| "SteamID 无效")?,
                    renewal_type: 0,
                },
                None,
            )
            .await?;
        check_mobile_token(&response.access_token, &session.steam_id)?;
        session.access_token = response.access_token;
        if !response.refresh_token.is_empty() {
            session.refresh_token = response.refresh_token;
        }
        Ok(())
    }

    async fn session(&self, id: &str, expected: Option<&str>) -> Result<SteamSession, String> {
        let generation = self.generation(id)?;
        let mut session = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("请先登录此令牌的 Steam 账号")?;
        check_identity(&session.steam_id, expected)?;
        let payload = jwt_payload(&session.access_token)?;
        if payload["exp"].as_u64().unwrap_or(0) <= unix_time() + 60 {
            self.refresh_session(&mut session).await?;
            // Do not overwrite a newer session or resurrect one after cancellation.
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(id, generation)?;
            let mut all = self.sessions.lock().unwrap();
            if !all.contains_key(id) {
                return Err("Steam 登录已取消".into());
            }
            all.insert(id.into(), session.clone());
        }
        self.ensure_generation(id, generation)?;
        Ok(session)
    }

    pub async fn confirmations(
        &self,
        id: &str,
        identity_secret: &str,
        device_id: &str,
        expected_steam_id: Option<&str>,
    ) -> Result<Vec<Confirmation>, String> {
        let generation = self.generation(id)?;
        let session = self.session(id, expected_steam_id).await?;
        let now = self.server_time().await?;
        let params =
            confirmation_params(identity_secret, device_id, &session.steam_id, now, "list")?;
        let response = self
            .client
            .get(format!("{COMMUNITY}/mobileconf/getlist"))
            .header(header::COOKIE, session_cookie(&session))
            .query(&params)
            .send()
            .await
            .map_err(|e| network_error(e, "读取 Steam 交易确认"))?;
        let body = community_json(response).await?;
        ensure_success(&body)?;
        let items = body["conf"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|row| Confirmation {
                        id: string_value(&row["id"]),
                        nonce: string_value(&row["nonce"]),
                        kind: row["type"].as_u64().unwrap_or(0) as u32,
                        type_name: row["type_name"].as_str().unwrap_or("Steam 确认").into(),
                        headline: row["headline"].as_str().unwrap_or_default().into(),
                        summary: row["summary"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        creation_time: row["creation_time"].as_u64().unwrap_or(0),
                        icon: safe_icon(row["icon"].as_str().unwrap_or_default()),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if items.iter().any(|x| x.id.is_empty() || x.nonce.is_empty()) {
            return Err("Steam 确认数据不完整，请刷新后重试".into());
        }
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_generation(id, generation)?;
        self.confirmations
            .lock()
            .unwrap()
            .insert(id.into(), items.clone());
        Ok(items)
    }

    #[allow(clippy::too_many_arguments)] // Explicit account, device and reviewed-row bindings.
    pub async fn act_confirmation(
        &self,
        token_id: &str,
        identity_secret: &str,
        device_id: &str,
        expected_steam_id: Option<&str>,
        id: &str,
        nonce: &str,
        accept: bool,
    ) -> Result<(), String> {
        let generation = self.generation(token_id)?;
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(token_id, generation)?;
            let mut cached = self.confirmations.lock().unwrap();
            let items = cached
                .get_mut(token_id)
                .ok_or("确认记录已变化，请刷新并核对后重试")?;
            let index = items
                .iter()
                .position(|x| x.id == id && x.nonce == nonce)
                .ok_or("确认记录已变化，请刷新并核对后重试")?;
            items.remove(index);
        }
        let session = self.session(token_id, expected_steam_id).await?;
        let tag = if accept { "allow" } else { "cancel" };
        let now = self.server_time().await?;
        let mut params =
            confirmation_params(identity_secret, device_id, &session.steam_id, now, tag)?;
        params.extend([
            ("op".into(), tag.into()),
            ("cid".into(), id.into()),
            ("ck".into(), nonce.into()),
        ]);
        self.ensure_generation(token_id, generation)?;
        let response = self
            .client
            .get(format!("{COMMUNITY}/mobileconf/ajaxop"))
            .header(header::COOKIE, session_cookie(&session))
            .query(&params)
            .send()
            .await
            .map_err(|_| "Steam 确认请求失败；请刷新核对结果后再操作")?;
        let body = community_json(response).await?;
        ensure_success(&body)?;
        Ok(())
    }

    fn time_request(&self) -> reqwest::RequestBuilder {
        self.client
            .post(format!(
                "{}/ITwoFactorService/QueryTime/v1/",
                self.api_base()
            ))
            // Steam's HTTP frontend rejects a body-less POST with HTTP 411.
            .form(&[("steamid", "0")])
    }

    pub async fn server_time(&self) -> Result<u64, String> {
        let response = self
            .time_request()
            .send()
            .await
            .map_err(|e| network_error(e, "校准 Steam 时间"))?;
        let value = community_json(response).await?;
        let time = value["response"]["server_time"]
            .as_u64()
            .or_else(|| {
                value["response"]["server_time"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
            })
            .ok_or("Steam 时间响应无效")?;
        Ok(time)
    }

    pub async fn market_listings(&self, id: &str, start: u32, count: u32) -> Result<Value, String> {
        let session = self.session(id, None).await?;
        let response = self
            .client
            .get(format!("{COMMUNITY}/market/mylistings"))
            .header(header::COOKIE, session_cookie(&session))
            .query(&[
                ("norender", "1".to_string()),
                ("start", start.to_string()),
                ("count", count.clamp(1, 100).to_string()),
            ])
            .send()
            .await
            .map_err(|e| network_error(e, "读取市场挂单"))?;
        let body = community_json(response).await?;
        ensure_success(&body)?;
        let listinginfo = body.get("listinginfo").or_else(|| body.get("listings"));
        let rows: Vec<&Value> = match listinginfo {
            Some(Value::Array(a)) => a.iter().collect(),
            Some(Value::Object(m)) => m.values().collect(),
            _ => vec![],
        };
        let items: Vec<Value> = rows.into_iter().map(|row| {
            let asset = &row["asset"];
            let appid = string_value(&asset["appid"]);
            let contextid = string_value(&asset["contextid"]);
            let assetid = string_value(&asset["id"]);
            let detail = &body["assets"][&appid][&contextid][&assetid];
            let name = detail["market_hash_name"].as_str().or_else(|| detail["name"].as_str()).unwrap_or("Steam 市场物品");
            let icon = detail["icon_url"].as_str().unwrap_or_default();
            let listing_id = string_value(&row["listingid"]);
            json!({"id":listing_id,"name":name,"price":row["price"].as_i64().map(|x|format!("{:.2}",x as f64/100.)).unwrap_or_default(),
                "icon":if icon.is_empty(){String::new()}else{format!("https://community.fastly.steamstatic.com/economy/image/{icon}")},"status":"在售",
                "url":market_url(&appid,name)})
        }).collect();
        Ok(
            json!({"total":body["num_active_listings"].as_u64().or_else(||body["total_count"].as_u64()).unwrap_or(items.len() as u64),"items":items}),
        )
    }

    pub async fn market_search(
        &self,
        query: &str,
        start: u32,
        count: u32,
    ) -> Result<Value, String> {
        let response = self
            .client
            .get(format!("{COMMUNITY}/market/search/render/"))
            .query(&[
                ("query", query.to_string()),
                ("start", start.to_string()),
                ("count", count.clamp(1, 100).to_string()),
                ("norender", "1".into()),
                ("sort_column", "popular".into()),
                ("sort_dir", "desc".into()),
                ("search_descriptions", "0".into()),
            ])
            .send()
            .await
            .map_err(|e| network_error(e, "搜索 Steam 市场"))?;
        let body = community_json(response).await?;
        ensure_success(&body)?;
        let items: Vec<Value> = body["results"].as_array().into_iter().flatten().map(|row| {
            let appid = string_value(&row["asset_description"]["appid"]);
            let name = row["hash_name"].as_str().or_else(||row["name"].as_str()).unwrap_or_default();
            let icon = row["asset_description"]["icon_url"].as_str().unwrap_or_default();
            json!({"id":format!("{appid}:{name}"),"name":row["name"].as_str().unwrap_or(name),"price":row["sell_price_text"].as_str().unwrap_or_default(),
                "icon":if icon.is_empty(){String::new()}else{format!("https://community.fastly.steamstatic.com/economy/image/{icon}")},"status":format!("{} 件在售",row["sell_listings"].as_u64().unwrap_or(0)),"url":market_url(&appid,name)})
        }).collect();
        Ok(
            json!({"total":body["total_count"].as_u64().unwrap_or(items.len() as u64),"items":items}),
        )
    }

    /// Read-only metadata to display before the user approves a scanned Steam QR login.
    pub async fn qr_login_info(
        &self,
        id: &str,
        qr_url: &str,
        expected: Option<&str>,
    ) -> Result<Value, String> {
        let (_, client_id) = parse_qr_url(qr_url)?;
        let generation = self.generation(id)?;
        let session = self.session(id, expected).await?;
        let info: QrInfoResponse = self
            .api(
                "Authentication",
                "GetAuthSessionInfo",
                QrInfoRequest { client_id },
                Some(&session.access_token),
            )
            .await?;
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_generation(id, generation)?;
        self.reviewed_qr
            .lock()
            .unwrap()
            .insert(id.into(), (qr_url.into(), generation, Instant::now()));
        Ok(
            json!({"ip":info.ip,"city":info.city,"state":info.state,"country":info.country,"deviceFriendlyName":info.device_name,"platformType":info.platform_type,"locationMismatch":info.location_mismatch,"highUsageLogin":info.high_usage_login}),
        )
    }

    pub async fn approve_qr_login(
        &self,
        id: &str,
        qr_url: &str,
        shared_secret: &[u8],
        expected: Option<&str>,
        accept: bool,
    ) -> Result<(), String> {
        let (version, client_id) = parse_qr_url(qr_url)?;
        let generation = self.generation(id)?;
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.ensure_generation(id, generation)?;
            let reviewed = self
                .reviewed_qr
                .lock()
                .unwrap()
                .remove(id)
                .ok_or("请先读取并核对二维码登录信息")?;
            if reviewed.0 != qr_url
                || reviewed.1 != generation
                || reviewed.2.elapsed() > Duration::from_secs(120)
            {
                return Err("二维码登录信息已过期，请重新读取核对".into());
            }
        }
        let session = self.session(id, expected).await?;
        let steam_id: u64 = session.steam_id.parse().map_err(|_| "SteamID 无效")?;
        let signature = qr_signature(shared_secret, version, client_id, steam_id)?;
        let _: Empty = self
            .api(
                "Authentication",
                "UpdateAuthSessionWithMobileConfirmation",
                ApproveQrRequest {
                    version: version as u32,
                    client_id,
                    steam_id,
                    signature,
                    confirm: accept,
                    persistence: 1,
                },
                Some(&session.access_token),
            )
            .await?;
        Ok(())
    }

    /// First step of attaching a new authenticator. Caller must persist the returned
    /// recovery material before asking for SMS activation. Never call automatically.
    pub async fn begin_enrollment(
        &self,
        id: &str,
        expected: Option<&str>,
    ) -> Result<EnrollmentSecret, String> {
        let session = self.session(id, expected).await?;
        let device_id = device_id_for(&session.steam_id);
        let server_time = self.server_time().await?;
        let result: AddAuthenticatorResponse = self
            .api(
                "TwoFactor",
                "AddAuthenticator",
                AddAuthenticatorRequest {
                    steam_id: session.steam_id.parse().map_err(|_| "SteamID 无效")?,
                    authenticator_time: server_time,
                    authenticator_type: 1,
                    device_identifier: device_id.clone(),
                    version: 1,
                },
                Some(&session.access_token),
            )
            .await?;
        enrollment_result(result, &session, device_id)
    }

    pub async fn finalize_enrollment(
        &self,
        id: &str,
        shared_secret: &[u8],
        sms_code: &str,
        expected: Option<&str>,
    ) -> Result<(), String> {
        if shared_secret.is_empty() || sms_code.trim().is_empty() {
            return Err("请输入短信激活码".into());
        }
        let session = self.session(id, expected).await?;
        let server_time = self.server_time().await?;
        let token =
            crate::models::Token::new(String::new(), "steam".into(), shared_secret.to_vec());
        let authenticator_code = crate::otp::code(&token, server_time)?;
        let result: FinalizeAuthenticatorResponse = self
            .api(
                "TwoFactor",
                "FinalizeAddAuthenticator",
                FinalizeAuthenticatorRequest {
                    steam_id: session.steam_id.parse().map_err(|_| "SteamID 无效")?,
                    authenticator_code,
                    authenticator_time: server_time,
                    activation_code: sms_code.trim().into(),
                    validate_sms_code: true,
                },
                Some(&session.access_token),
            )
            .await?;
        if !result.success {
            return Err(format!(
                "Steam 令牌激活失败（状态 {}），请核对短信验证码后重试",
                result.status
            ));
        }
        Ok(())
    }

    /// Starts Steam's SMS challenge for transferring an existing mobile authenticator.
    pub async fn begin_transfer(&self, id: &str, expected: Option<&str>) -> Result<(), String> {
        let session = self.session(id, expected).await?;
        let result: TransferStartResponse = self
            .api(
                "TwoFactor",
                "RemoveAuthenticatorViaChallengeStart",
                Empty {},
                Some(&session.access_token),
            )
            .await?;
        if !result.success {
            return Err("Steam 无法发送转移验证码，请确认账号已绑定可用手机".into());
        }
        Ok(())
    }

    /// Replaces the remote token only after a user provides the SMS challenge.
    /// Caller must atomically persist the returned token before reporting success.
    pub async fn finish_transfer(
        &self,
        id: &str,
        sms_code: &str,
        expected: Option<&str>,
    ) -> Result<EnrollmentSecret, String> {
        if sms_code.trim().is_empty() {
            return Err("请输入 Steam 短信验证码".into());
        }
        let session = self.session(id, expected).await?;
        let result: TransferResponse = self
            .api(
                "TwoFactor",
                "RemoveAuthenticatorViaChallengeContinue",
                TransferRequest {
                    sms_code: sms_code.trim().into(),
                    generate_new_token: true,
                    version: 1,
                },
                Some(&session.access_token),
            )
            .await?;
        if !result.success {
            return Err("Steam 令牌转移失败，请核对短信验证码".into());
        }
        let replacement = result
            .replacement
            .ok_or("Steam 未返回替换令牌，请检查账号状态后重试")?;
        if replacement.steam_id != 0 {
            check_identity(&replacement.steam_id.to_string(), Some(&session.steam_id))?;
        }
        enrollment_result(
            AddAuthenticatorResponse {
                shared_secret: replacement.shared_secret,
                serial_number: replacement.serial_number,
                revocation_code: replacement.revocation_code,
                server_time: replacement.server_time,
                account_name: replacement.account_name,
                token_gid: replacement.token_gid,
                identity_secret: replacement.identity_secret,
                status: replacement.status,
                phone_number_hint: String::new(),
                confirm_type: 0,
            },
            &session,
            device_id_for(&session.steam_id),
        )
    }

    /// Removes the remote authenticator; local deletion is a separate operation.
    pub async fn remove_authenticator(
        &self,
        id: &str,
        revocation_code: &str,
        expected: Option<&str>,
    ) -> Result<(), String> {
        if revocation_code.trim().is_empty() {
            return Err("请输入 Steam 恢复代码".into());
        }
        let session = self.session(id, expected).await?;
        let result: RemoveAuthenticatorResponse = self
            .api(
                "TwoFactor",
                "RemoveAuthenticator",
                RemoveAuthenticatorRequest {
                    revocation_code: revocation_code.trim().into(),
                    revocation_reason: 1,
                    steamguard_scheme: 1,
                    remove_all_cookies: true,
                },
                Some(&session.access_token),
            )
            .await?;
        if !result.success {
            return Err(format!(
                "Steam 令牌解绑失败，剩余尝试次数 {}",
                result.attempts_remaining
            ));
        }
        self.logout(id);
        Ok(())
    }
}

fn network_error(error: reqwest::Error, operation: &str) -> String {
    // Classify locally; never put URLs (which can contain access tokens), request
    // bodies, passwords or raw proxy errors into the webview or a diagnostic log.
    let mut chain = String::new();
    let mut cause: Option<&dyn std::error::Error> = Some(&error);
    while let Some(current) = cause {
        chain.push_str(&current.to_string().to_lowercase());
        chain.push(' ');
        cause = current.source();
    }
    let reason = if error.is_timeout() {
        "请求超时"
    } else if chain.contains("certificate")
        || chain.contains("unknownissuer")
        || chain.contains("certnotvalid")
    {
        "TLS 证书校验失败"
    } else if chain.contains("dns")
        || chain.contains("name resolution")
        || chain.contains("nodename")
        || chain.contains("failed to lookup")
    {
        "域名解析失败"
    } else if chain.contains("proxy") || chain.contains("socks") {
        "代理连接失败"
    } else if error.is_connect() {
        "无法建立网络连接"
    } else {
        "连接中断或响应读取失败"
    };
    format!(
        "连接 Steam 失败（{}：{reason}），请检查当前网络或代理",
        operation_label(operation)
    )
}

fn operation_label(operation: &str) -> &str {
    match operation.rsplit('.').next().unwrap_or(operation) {
        "GetPasswordRSAPublicKey" => "获取登录公钥",
        "BeginAuthSessionViaCredentials" => "提交账号密码",
        "BeginAuthSessionViaQR" => "获取登录二维码",
        "UpdateAuthSessionWithSteamGuardCode" => "提交登录验证码",
        "PollAuthSessionStatus" => "查询登录结果",
        "GenerateAccessTokenForApp" => "续期登录会话",
        _ => operation,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheck {
    name: String,
    ok: bool,
    latency_ms: u64,
    error: Option<String>,
}
impl NetworkCheck {
    fn from_result(name: &str, start: Instant, result: Result<(), String>) -> Self {
        Self {
            name: name.into(),
            ok: result.is_ok(),
            latency_ms: start.elapsed().as_millis() as u64,
            error: result.err(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkReport {
    platform: String,
    mode: crate::network::ProxyMode,
    checks: Vec<NetworkCheck>,
}

fn enrollment_result(
    result: AddAuthenticatorResponse,
    session: &SteamSession,
    device_id: String,
) -> Result<EnrollmentSecret, String> {
    if result.shared_secret.is_empty() || result.identity_secret.is_empty() {
        return Err(format!(
            "Steam 未返回完整令牌（状态 {}）；账号可能已有令牌或需要先绑定手机号",
            result.status
        ));
    }
    Ok(EnrollmentSecret {
        shared_secret: result.shared_secret,
        identity_secret: result.identity_secret,
        steam_id: session.steam_id.clone(),
        account_name: if result.account_name.is_empty() {
            session.account_name.clone()
        } else {
            result.account_name
        },
        serial_number: result.serial_number.to_string(),
        revocation_code: result.revocation_code,
        device_id,
        token_gid: result.token_gid,
        server_time: result.server_time,
        phone_number_hint: result.phone_number_hint,
    })
}

fn poll_interval(seconds: f32) -> u64 {
    if seconds.is_finite() {
        (seconds.clamp(1., 30.) * 1000.) as u64
    } else {
        5000
    }
}
fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0; bytes];
    OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn check_identity(actual: &str, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = crate::models::known_steam_id(expected) {
        if actual.trim() != expected {
            let suffix = |id: &str| {
                id.chars()
                    .rev()
                    .take(6)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            };
            return Err(format!("登录账号与所选令牌不一致（令牌 SteamID 尾号 {}，登录账号尾号 {}）。请使用此令牌对应的 Steam 登录账户，或选择正确的令牌。", suffix(expected), suffix(actual)));
        }
    }
    Ok(())
}
fn jwt_payload(token: &str) -> Result<Value, String> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return Err("Steam 登录凭证格式无效".into());
    }
    let payload = parts[1];
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "Steam 登录凭证格式无效")?;
    serde_json::from_slice(&bytes).map_err(|_| "Steam 登录凭证格式无效".into())
}
fn check_mobile_token(token: &str, steam_id: &str) -> Result<(), String> {
    let value = jwt_payload(token)?;
    check_identity(value["sub"].as_str().unwrap_or_default(), Some(steam_id))?;
    let audience = value["aud"]
        .as_array()
        .ok_or("Steam 登录凭证缺少用途信息")?;
    if !audience.iter().any(|a| a == "mobile") || audience.iter().any(|a| a == "derive") {
        return Err("此登录凭证不支持 Steam 手机交易确认，请重新登录".into());
    }
    Ok(())
}
fn session_cookie(session: &SteamSession) -> String {
    format!("{MOBILE_COOKIE}; steamLoginSecure={}%7C%7C{}; sessionid={}; Steam_Language=schinese; timezoneOffset=28800,0",session.steam_id,session.access_token,session.session_id)
}
fn string_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn safe_icon(value: &str) -> String {
    url::Url::parse(value)
        .ok()
        .filter(|u| {
            u.scheme() == "https"
                && u.host_str().is_some_and(|h| {
                    h == "steamcommunity.com"
                        || h.ends_with(".steamstatic.com")
                        || h.ends_with(".steamcommunity.com")
                        || h.ends_with(".akamaihd.net")
                })
        })
        .map(|u| u.to_string())
        .unwrap_or_default()
}
fn market_url(appid: &str, name: &str) -> String {
    let mut url = url::Url::parse("https://steamcommunity.com/market/listings/").unwrap();
    if let Ok(mut path) = url.path_segments_mut() {
        path.pop_if_empty().push(appid).push(name);
    }
    url.to_string()
}
async fn community_json(response: reqwest::Response) -> Result<Value, String> {
    if response.status().is_redirection()
        || response.status().as_u16() == 401
        || response.status().as_u16() == 403
    {
        return Err("Steam 登录已失效或访问被拒绝，请重新登录后重试".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Steam 服务返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "Steam 返回了非预期数据，登录状态可能已经过期".into())
}
fn ensure_success(body: &Value) -> Result<(), String> {
    if body["needauth"] == true {
        return Err("Steam 登录已过期，请重新登录".into());
    }
    if body["success"] == true || body["success"] == 1 {
        Ok(())
    } else {
        Err(body["message"]
            .as_str()
            .or_else(|| body["detail"].as_str())
            .unwrap_or("Steam 未能完成请求，请稍后刷新重试")
            .chars()
            .take(300)
            .collect())
    }
}
fn steam_error(result: u32) -> String {
    match result {
        5 => "Steam 登录名或密码错误".into(),
        15 => "Steam 拒绝访问，请重新登录".into(),
        65 => "邮箱验证码不匹配，请输入当前登录邮件中的验证码".into(),
        71 => "邮箱验证码已过期，请重新登录获取新邮件".into(),
        84 => "Steam 请求过于频繁，请稍后重试".into(),
        85 => "Steam 要求手机双重验证，请完成当前登录的验证码或手机批准".into(),
        87 => "Steam 暂时限制登录，请稍后再试".into(),
        88 => "Steam 令牌验证码不匹配，请校准时间后重试；若令牌已转移，请导入最新令牌".into(),
        89 => "Steam 短信激活码不匹配，请核对短信".into(),
        93 => "Steam 时间不同步，请校准时间后重试".into(),
        _ => format!("Steam 请求失败（EResult {result}）"),
    }
}

pub fn confirmation_key(secret: &str, time: u64, tag: &str) -> Result<String, String> {
    let key = STANDARD
        .decode(secret)
        .map_err(|_| "令牌的 identity_secret 不是有效 Base64")?;
    if key.is_empty() {
        return Err("此令牌缺少交易确认密钥，请导入完整 maFile 或 MPO 备份".into());
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).map_err(|_| "交易确认密钥无效")?;
    mac.update(&time.to_be_bytes());
    mac.update(&tag.as_bytes()[..tag.len().min(32)]);
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}
fn confirmation_params(
    secret: &str,
    device: &str,
    steam_id: &str,
    time: u64,
    tag: &str,
) -> Result<Vec<(String, String)>, String> {
    let device = if device.is_empty() {
        device_id_for(steam_id)
    } else {
        device.to_string()
    };
    Ok(vec![
        ("p".into(), device),
        ("a".into(), steam_id.into()),
        ("k".into(), confirmation_key(secret, time, tag)?),
        ("t".into(), time.to_string()),
        ("m".into(), "react".into()),
        ("tag".into(), tag.into()),
    ])
}
pub fn device_id_for(steam_id: &str) -> String {
    let digest = Sha1::digest(steam_id.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "android:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
fn parse_qr_url(value: &str) -> Result<(u16, u64), String> {
    let url = url::Url::parse(value).map_err(|_| "无效的 Steam 登录二维码")?;
    if url.scheme() != "https"
        || url.host_str() != Some("s.team")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("只支持 https://s.team/q/ 格式的 Steam 登录二维码".into());
    }
    let path: Vec<_> = url
        .path_segments()
        .ok_or("无效的 Steam 登录二维码")?
        .collect();
    if path.len() != 3 || path[0] != "q" {
        return Err("无效的 Steam 登录二维码".into());
    }
    let version = path[1].parse().map_err(|_| "Steam 二维码版本无效")?;
    let client = path[2].parse().map_err(|_| "Steam 二维码会话无效")?;
    Ok((version, client))
}
fn qr_signature(
    secret: &[u8],
    version: u16,
    client: u64,
    steam_id: u64,
) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| "Steam 令牌密钥无效")?;
    mac.update(&version.to_le_bytes());
    mac.update(&client.to_le_bytes());
    mac.update(&steam_id.to_le_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

// Minimal protobuf definitions mirror Valve's steammessages_auth.steamclient.proto.
#[derive(Clone, PartialEq, Message)]
struct Empty {}
#[derive(Clone, PartialEq, Message)]
struct RsaKeyRequest {
    #[prost(string, tag = "1")]
    account_name: String,
}
#[derive(Clone, PartialEq, Message)]
struct RsaKeyResponse {
    #[prost(string, tag = "1")]
    modulus: String,
    #[prost(string, tag = "2")]
    exponent: String,
    #[prost(uint64, tag = "3")]
    timestamp: u64,
}
#[derive(Clone, PartialEq, Message)]
struct DeviceDetails {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(uint32, tag = "2")]
    platform: u32,
    #[prost(int32, tag = "3")]
    os: i32,
    #[prost(uint32, tag = "4")]
    device_type: u32,
    #[prost(uint32, tag = "7")]
    app_type: u32,
}
impl DeviceDetails {
    fn mobile() -> Self {
        Self {
            name: "SteamGuard".into(),
            platform: 3,
            os: -500,
            device_type: 528,
            app_type: 1,
        }
    }
}
#[derive(Clone, PartialEq, Message)]
struct BeginCredentialsRequest {
    #[prost(string, tag = "1")]
    device_friendly_name: String,
    #[prost(uint32, tag = "6")]
    platform_type: u32,
    #[prost(string, tag = "2")]
    account_name: String,
    #[prost(string, tag = "3")]
    encrypted_password: String,
    #[prost(uint64, tag = "4")]
    encryption_timestamp: u64,
    #[prost(bool, tag = "5")]
    remember_login: bool,
    #[prost(uint32, tag = "7")]
    persistence: u32,
    #[prost(string, tag = "8")]
    website_id: String,
    #[prost(message, optional, tag = "9")]
    device_details: Option<DeviceDetails>,
}
#[derive(Clone, PartialEq, Message)]
struct AllowedConfirmation {
    #[prost(uint32, tag = "1")]
    confirmation_type: u32,
    #[prost(string, tag = "2")]
    message: String,
}
impl From<AllowedConfirmation> for GuardOption {
    fn from(value: AllowedConfirmation) -> Self {
        Self {
            confirmation_type: value.confirmation_type,
            associated_message: value.message,
        }
    }
}
#[derive(Clone, PartialEq, Message)]
struct BeginCredentialsResponse {
    #[prost(uint64, tag = "1")]
    client_id: u64,
    #[prost(bytes, tag = "2")]
    request_id: Vec<u8>,
    #[prost(float, tag = "3")]
    interval: f32,
    #[prost(message, repeated, tag = "4")]
    allowed: Vec<AllowedConfirmation>,
    #[prost(uint64, tag = "5")]
    steam_id: u64,
}
#[derive(Clone, PartialEq, Message)]
struct BeginQrRequest {
    #[prost(string, tag = "1")]
    device_friendly_name: String,
    #[prost(uint32, tag = "2")]
    platform_type: u32,
    #[prost(string, tag = "4")]
    website_id: String,
    #[prost(message, optional, tag = "3")]
    device_details: Option<DeviceDetails>,
}
#[derive(Clone, PartialEq, Message)]
struct BeginQrResponse {
    #[prost(uint64, tag = "1")]
    client_id: u64,
    #[prost(string, tag = "2")]
    challenge_url: String,
    #[prost(bytes, tag = "3")]
    request_id: Vec<u8>,
    #[prost(float, tag = "4")]
    interval: f32,
    #[prost(message, repeated, tag = "5")]
    allowed: Vec<AllowedConfirmation>,
}
#[derive(Clone, PartialEq, Message)]
struct UpdateGuardRequest {
    #[prost(uint64, tag = "1")]
    client_id: u64,
    #[prost(fixed64, tag = "2")]
    steam_id: u64,
    #[prost(string, tag = "3")]
    code: String,
    #[prost(uint32, tag = "4")]
    code_type: u32,
}
#[derive(Clone, PartialEq, Message)]
struct PollRequest {
    #[prost(uint64, tag = "1")]
    client_id: u64,
    #[prost(bytes, tag = "2")]
    request_id: Vec<u8>,
}
#[derive(Clone, PartialEq, Message)]
struct PollResponse {
    #[prost(uint64, tag = "1")]
    new_client_id: u64,
    #[prost(string, tag = "2")]
    new_challenge_url: String,
    #[prost(string, tag = "3")]
    refresh_token: String,
    #[prost(string, tag = "4")]
    access_token: String,
    #[prost(string, tag = "6")]
    account_name: String,
}
#[derive(Clone, PartialEq, Message)]
struct AccessTokenRequest {
    #[prost(string, tag = "1")]
    refresh_token: String,
    #[prost(fixed64, tag = "2")]
    steam_id: u64,
    #[prost(uint32, tag = "3")]
    renewal_type: u32,
}
#[derive(Clone, PartialEq, Message)]
struct AccessTokenResponse {
    #[prost(string, tag = "1")]
    access_token: String,
    #[prost(string, tag = "2")]
    refresh_token: String,
}
#[derive(Clone, PartialEq, Message)]
struct QrInfoRequest {
    #[prost(uint64, tag = "1")]
    client_id: u64,
}
#[derive(Clone, PartialEq, Message)]
struct QrInfoResponse {
    #[prost(string, tag = "1")]
    ip: String,
    #[prost(string, tag = "3")]
    city: String,
    #[prost(string, tag = "4")]
    state: String,
    #[prost(string, tag = "5")]
    country: String,
    #[prost(uint32, tag = "6")]
    platform_type: u32,
    #[prost(string, tag = "7")]
    device_name: String,
    #[prost(bool, tag = "10")]
    location_mismatch: bool,
    #[prost(bool, tag = "11")]
    high_usage_login: bool,
}
#[derive(Clone, PartialEq, Message)]
struct ApproveQrRequest {
    #[prost(uint32, tag = "1")]
    version: u32,
    #[prost(uint64, tag = "2")]
    client_id: u64,
    #[prost(fixed64, tag = "3")]
    steam_id: u64,
    #[prost(bytes, tag = "4")]
    signature: Vec<u8>,
    #[prost(bool, tag = "5")]
    confirm: bool,
    #[prost(uint32, tag = "6")]
    persistence: u32,
}
#[derive(Clone, PartialEq, Message)]
struct AddAuthenticatorRequest {
    #[prost(fixed64, tag = "1")]
    steam_id: u64,
    #[prost(uint64, tag = "2")]
    authenticator_time: u64,
    #[prost(uint32, tag = "4")]
    authenticator_type: u32,
    #[prost(string, tag = "5")]
    device_identifier: String,
    #[prost(uint32, tag = "8")]
    version: u32,
}
#[derive(Clone, PartialEq, Message)]
struct AddAuthenticatorResponse {
    #[prost(bytes, tag = "1")]
    shared_secret: Vec<u8>,
    #[prost(fixed64, tag = "2")]
    serial_number: u64,
    #[prost(string, tag = "3")]
    revocation_code: String,
    #[prost(uint64, tag = "5")]
    server_time: u64,
    #[prost(string, tag = "6")]
    account_name: String,
    #[prost(string, tag = "7")]
    token_gid: String,
    #[prost(bytes, tag = "8")]
    identity_secret: Vec<u8>,
    #[prost(int32, tag = "10")]
    status: i32,
    #[prost(string, tag = "11")]
    phone_number_hint: String,
    #[prost(int32, tag = "12")]
    confirm_type: i32,
}
#[derive(Clone, PartialEq, Message)]
struct FinalizeAuthenticatorRequest {
    #[prost(fixed64, tag = "1")]
    steam_id: u64,
    #[prost(string, tag = "2")]
    authenticator_code: String,
    #[prost(uint64, tag = "3")]
    authenticator_time: u64,
    #[prost(string, tag = "4")]
    activation_code: String,
    #[prost(bool, tag = "6")]
    validate_sms_code: bool,
}
#[derive(Clone, PartialEq, Message)]
struct FinalizeAuthenticatorResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(int32, tag = "4")]
    status: i32,
}
#[derive(Clone, PartialEq, Message)]
struct TransferStartResponse {
    #[prost(bool, tag = "1")]
    success: bool,
}
#[derive(Clone, PartialEq, Message)]
struct TransferRequest {
    #[prost(string, tag = "1")]
    sms_code: String,
    #[prost(bool, tag = "2")]
    generate_new_token: bool,
    #[prost(uint32, tag = "3")]
    version: u32,
}
#[derive(Clone, PartialEq, Message)]
struct TransferResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(message, optional, tag = "2")]
    replacement: Option<ReplacementToken>,
}
#[derive(Clone, PartialEq, Message)]
struct ReplacementToken {
    #[prost(bytes, tag = "1")]
    shared_secret: Vec<u8>,
    #[prost(fixed64, tag = "2")]
    serial_number: u64,
    #[prost(string, tag = "3")]
    revocation_code: String,
    #[prost(uint64, tag = "5")]
    server_time: u64,
    #[prost(string, tag = "6")]
    account_name: String,
    #[prost(string, tag = "7")]
    token_gid: String,
    #[prost(bytes, tag = "8")]
    identity_secret: Vec<u8>,
    #[prost(int32, tag = "10")]
    status: i32,
    // Tag 11 is uint32 steamguard_scheme, unlike AddAuthenticator's string phone hint.
    #[prost(fixed64, tag = "12")]
    steam_id: u64,
}
#[derive(Clone, PartialEq, Message)]
struct RemoveAuthenticatorRequest {
    #[prost(string, tag = "2")]
    revocation_code: String,
    #[prost(uint32, tag = "5")]
    revocation_reason: u32,
    #[prost(uint32, tag = "6")]
    steamguard_scheme: u32,
    #[prost(bool, tag = "7")]
    remove_all_cookies: bool,
}
#[derive(Clone, PartialEq, Message)]
struct RemoveAuthenticatorResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(uint32, tag = "5")]
    attempts_remaining: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn time_query_has_a_real_form_body_for_steam_http_frontend() {
        let service = SteamService::new().unwrap();
        let request = service.time_request().build().unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/x-www-form-urlencoded"
        );
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        assert!(
            !body.is_empty(),
            "Steam returns HTTP 411 for a body-less time request"
        );
        assert!(url::form_urlencoded::parse(body).any(|(k, v)| k == "steamid" && v == "0"));
    }
    #[test]
    fn connection_errors_do_not_expose_session_query_parameters() {
        tauri::async_runtime::block_on(async {
            let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = socket.local_addr().unwrap().port();
            drop(socket);
            let error = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap()
                .get(format!(
                    "http://127.0.0.1:{port}/?access_token=private-session-fixture"
                ))
                .send()
                .await
                .expect_err("Closed port must refuse connection");
            let message = network_error(error, "获取 Steam 登录公钥");
            // Windows may reach the request deadline while retrying a refused
            // loopback connection; Unix usually reports the refusal immediately.
            assert!(message.contains("无法建立网络连接") || message.contains("请求超时"));
            assert!(message.contains("获取 Steam 登录公钥"));
            assert!(
                !message.contains("access_token") && !message.contains("private-session-fixture")
            );
        });
    }
    #[test]
    #[ignore = "Read-only network diagnostic against public Steam endpoints; no account input"]
    fn live_network_diagnostics_probe() {
        tauri::async_runtime::block_on(async {
            let service = SteamService::new().unwrap();
            let report = service.network_diagnostics().await.unwrap();
            println!("{}", serde_json::to_string(&report).unwrap());
            assert!(
                report.checks.iter().all(|c| c.ok),
                "Public Steam connectivity diagnostic failed"
            );
        });
    }
    #[test]
    fn protobuf_guard_request_uses_fixed64_steamid() {
        let message = UpdateGuardRequest {
            client_id: 123,
            steam_id: 0x0102030405060708,
            code: "ABCDE".into(),
            code_type: 3,
        };
        assert_eq!(
            message.encode_to_vec(),
            vec![8, 123, 17, 8, 7, 6, 5, 4, 3, 2, 1, 26, 5, b'A', b'B', b'C', b'D', b'E', 32, 3]
        );
    }
    #[test]
    fn protobuf_rsa_response_decodes_wire_fixture() {
        let fixture = [10, 4, b'a', b'b', b'c', b'd', 18, 2, b'0', b'3', 24, 123];
        let response = RsaKeyResponse::decode(fixture.as_slice()).unwrap();
        assert_eq!(response.modulus, "abcd");
        assert_eq!(response.exponent, "03");
        assert_eq!(response.timestamp, 123);
    }
    #[test]
    #[ignore = "Explicit read-only network probe; no user credentials or transaction requests"]
    fn live_read_only_rsa_protocol_probe() {
        tauri::async_runtime::block_on(async {
            let service = SteamService::new().unwrap();
            let response: RsaKeyResponse = service
                .api(
                    "Authentication",
                    "GetPasswordRSAPublicKey",
                    RsaKeyRequest {
                        account_name: "steamguard_protocol_probe".into(),
                    },
                    None,
                )
                .await
                .unwrap();
            assert!(!response.modulus.is_empty());
            assert!(!response.exponent.is_empty());
            assert!(response.timestamp > 0);
        });
    }
    #[test]
    #[ignore = "Explicit account-owner login test: credentials from hidden terminal stdin, never logs secrets or performs transactions"]
    fn live_credentials_login_probe() {
        use std::io::{self, IsTerminal};
        use zeroize::Zeroizing;
        if !io::stdin().is_terminal() {
            println!("Explicit owner login probe requires an interactive terminal; skipped.");
            return;
        }
        let username = Zeroizing::new(
            rpassword::prompt_password("Steam account (hidden input): ")
                .expect("Read account from terminal"),
        );
        let password = Zeroizing::new(
            rpassword::prompt_password("Steam password (hidden input): ")
                .expect("Read password from terminal"),
        );
        tauri::async_runtime::block_on(async {
            let service = SteamService::new().unwrap();
            let tokens = std::env::var("WATT_TEST_MPO")
                .ok()
                .map(|path| {
                    let bytes = Zeroizing::new(
                        std::fs::read(path).expect("Read private local authenticator backup"),
                    );
                    crate::import::parse_import(&bytes, None, "private.mpo")
                        .expect("Decode private local authenticator backup")
                })
                .unwrap_or_default();
            let token = tokens.iter().find(|t| {
                t.kind == "steam"
                    && t.account_name
                        .as_deref()
                        .is_some_and(|n| n.eq_ignore_ascii_case(username.trim()))
            });
            let expected = token.and_then(|t| t.steam_id.as_deref());
            let result = service
                .begin_login(
                    "private-login-probe",
                    username.trim(),
                    password.trim_end_matches(['\r', '\n']),
                    expected,
                    token,
                )
                .await;
            let mut status = match result {
                Ok(s) => s,
                Err(e) => panic!("Login probe: {e}"),
            };
            println!("\nCredential exchange status: {}", status.status);
            println!(
                "Available guard types: {:?}",
                status
                    .guards
                    .iter()
                    .map(|g| g.confirmation_type)
                    .collect::<Vec<_>>()
            );
            if status.status != "authenticated" && token.is_none() {
                println!(
                    "Additional Steam Guard approval required; no transaction actions performed."
                );
                service.clear();
                return;
            }
            for _ in 0..6 {
                if status.status == "authenticated" {
                    break;
                }
                std::thread::sleep(Duration::from_millis(status.poll_interval.max(1000)));
                status = service
                    .poll_login("private-login-probe")
                    .await
                    .expect("Steam login polling failed");
            }
            assert!(
                status.status == "authenticated",
                "Steam authentication did not complete"
            );
            let session = service
                .export_session("private-login-probe")
                .expect("Authenticated session missing");
            check_mobile_token(&session.access_token, &session.steam_id)
                .expect("Invalid mobile session");
            println!("Authenticated mobile session verified; tokens remain in native memory only.");
            if let Some(t) = token {
                if let (Some(identity), Some(device)) = (&t.identity_secret, &t.device_id) {
                    let rows = service
                        .confirmations("private-login-probe", identity, device, expected)
                        .await
                        .expect("Read-only mobile confirmation query failed");
                    println!("Read-only mobile confirmation query succeeded ({} rows); no approvals or transactions sent.",rows.len());
                }
            }
            if let Some(token) = token {
                struct PrivateDirectory(std::path::PathBuf);
                impl Drop for PrivateDirectory {
                    fn drop(&mut self) {
                        let _ = std::fs::remove_dir_all(&self.0);
                    }
                }
                let directory = PrivateDirectory(
                    std::env::temp_dir()
                        .join(format!("steamguard-private-test-{}", uuid::Uuid::new_v4())),
                );
                std::fs::create_dir(&directory.0).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&directory.0, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                let password = zeroize::Zeroizing::new(random_hex(32));
                let mut vault = crate::vault::Vault::new(directory.0.join("vault.sgvault"));
                vault.create(&password).unwrap();
                vault
                    .update(|data| {
                        data.tokens.push(token.clone());
                        Ok(())
                    })
                    .unwrap();
                let persistence = SteamService::new().unwrap();
                persistence
                    .restore_session(&token.id, session.clone(), token.steam_id.as_deref())
                    .unwrap();
                let state = crate::AppState {
                    vault: Mutex::new(vault),
                    previews: Mutex::new(HashMap::new()),
                    steam: persistence,
                    epoch: AtomicU64::new(0),
                    time_offset: std::sync::atomic::AtomicI64::new(0),
                    sync: crate::sync::Controller::default(),
                };
                state
                    .save_session(&token.id, 0)
                    .expect("Native account binding failed");
                let mut vault = state.vault.lock().unwrap();
                assert!(
                    vault.ensure().unwrap().tokens[0].steam_id.as_deref()
                        == Some(session.steam_id.as_str())
                );
                vault.lock();
                vault.unlock(&password).unwrap();
                assert!(
                    vault.ensure().unwrap().tokens[0].steam_id.as_deref()
                        == Some(session.steam_id.as_str())
                );
                vault.lock();
                state.steam.clear();
                println!("Native account binding and encrypted save/unlock verified; temporary private files removed.");
            }
            service.clear();
        });
    }
    #[test]
    fn protobuf_enrollment_confirm_type_and_qr_metadata_decode_current_wire_types() {
        // AddAuthenticator tag 12 is varint confirm_type, not fixed64 SteamID.
        let enrollment =
            AddAuthenticatorResponse::decode([10, 2, 1, 2, 66, 2, 3, 4, 96, 2].as_slice()).unwrap();
        assert_eq!(enrollment.confirm_type, 2);
        assert_eq!(enrollment.shared_secret, vec![1, 2]);
        // QR country=5, platform=6, device=7, mismatch=10, high_usage=11.
        let qr = QrInfoResponse::decode(
            [42, 2, b'C', b'N', 48, 2, 58, 2, b'P', b'C', 80, 1, 88, 1].as_slice(),
        )
        .unwrap();
        assert_eq!(qr.country, "CN");
        assert_eq!(qr.platform_type, 2);
        assert_eq!(qr.device_name, "PC");
        assert!(qr.location_mismatch && qr.high_usage_login);
    }

    #[test]
    fn cancelled_or_replaced_challenges_cannot_install_late_results() {
        let service = SteamService::new().unwrap();
        let first = service.start_challenge("fixture");
        let second = service.start_challenge("fixture");
        let pending = |generation| Pending {
            generation,
            client_id: 1,
            request_id: vec![1],
            steam_id: None,
            expected_id: None,
            username: None,
            guards: vec![],
            interval: 1000,
            qr_url: None,
            created: Instant::now(),
            last_poll: None,
            message: None,
            guard_submitted: false,
            local_guard_verified: false,
        };
        assert!(service.install_pending("fixture", pending(first)).is_err());
        service.install_pending("fixture", pending(second)).unwrap();
        service.logout("fixture");
        assert!(service.install_pending("fixture", pending(second)).is_err());
        let third = service.start_challenge("fixture");
        service.clear();
        assert!(service.install_pending("fixture", pending(third)).is_err());
    }

    #[test]
    fn confirmation_signature_matches_independent_fixture() {
        assert_eq!(
            confirmation_key("aWRlbnRpdHlfc2VjcmV0", 1700000000, "conf").unwrap(),
            "0RzKffpsmnSrO53hJgOxzYpuNh8="
        );
    }
    #[test]
    fn qr_signature_matches_independent_fixture() {
        let hex: String = qr_signature(b"shared_secret", 1, 123, 76561198000000001)
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            hex,
            "a537eabcb0f09401ddc696f977bedd5ef77a93b5d85bc9a2da8241724fb50347"
        );
    }
    #[test]
    fn guard_error_codes_and_unknown_identity_are_consistent() {
        assert!(steam_error(88).contains("不匹配"));
        assert!(!steam_error(88).contains("需要双重验证"));
        assert!(steam_error(85).contains("双重验证"));
        assert!(steam_error(71).contains("过期"));
        for id in [None, Some("0"), Some(""), Some(" 0 ")] {
            assert!(check_identity("123", id).is_ok());
        }
        assert!(check_identity("123", Some("124")).is_err());
    }

    #[test]
    fn guard_failure_keeps_challenge_and_local_retry_uses_fresh_server_time() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let mut token = crate::models::Token::new(
            "synthetic".into(),
            "steam".into(),
            b"12345678901234567890".to_vec(),
        );
        token.steam_id = Some("0".into());
        token.account_name = Some("fixture".into());
        let first_time = 1_700_000_000;
        let second_time = first_time + 60;
        let first_code = crate::otp::code(&token, first_time).unwrap();
        let second_code = crate::otp::code(&token, second_time).unwrap();
        assert_ne!(first_code, second_code);
        let server = std::thread::spawn(move || {
            let routes = [
                "GetPasswordRSAPublicKey",
                "BeginAuthSessionViaCredentials",
                "QueryTime",
                "UpdateAuthSessionWithSteamGuardCode",
                "QueryTime",
                "UpdateAuthSessionWithSteamGuardCode",
                "PollAuthSessionStatus",
            ];
            for (index, route) in routes.iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let body_at;
                loop {
                    let mut chunk = [0; 4096];
                    let len = stream.read(&mut chunk).unwrap();
                    assert!(len > 0);
                    bytes.extend_from_slice(&chunk[..len]);
                    if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        body_at = at + 4;
                        break;
                    }
                }
                let headers = String::from_utf8_lossy(&bytes[..body_at]).to_string();
                assert!(headers.lines().next().unwrap().contains(route));
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < body_at + length {
                    let mut chunk = [0; 4096];
                    let len = stream.read(&mut chunk).unwrap();
                    assert!(len > 0);
                    bytes.extend_from_slice(&chunk[..len]);
                }
                let form =
                    url::form_urlencoded::parse(&bytes[body_at..]).collect::<HashMap<_, _>>();
                let (result, response) = match index {
                    0 => (
                        1,
                        RsaKeyResponse {
                            modulus: format!("c{}1", "a".repeat(510)),
                            exponent: "010001".into(),
                            timestamp: 1,
                        }
                        .encode_to_vec(),
                    ),
                    1 => (
                        1,
                        BeginCredentialsResponse {
                            client_id: 1,
                            request_id: vec![1],
                            interval: 1.0,
                            steam_id: 123,
                            allowed: vec![AllowedConfirmation {
                                confirmation_type: 3,
                                message: "".into(),
                            }],
                        }
                        .encode_to_vec(),
                    ),
                    2 | 4 => (
                        1,
                        format!(
                            "{{\"response\":{{\"server_time\":{}}}}}",
                            if index == 2 { first_time } else { second_time }
                        )
                        .into_bytes(),
                    ),
                    3 | 5 => {
                        let payload = STANDARD
                            .decode(form["input_protobuf_encoded"].as_bytes())
                            .unwrap();
                        let update = UpdateGuardRequest::decode(payload.as_slice()).unwrap();
                        assert_eq!(update.client_id, 1);
                        assert_eq!(update.steam_id, 123);
                        assert_eq!(update.code_type, 3);
                        assert_eq!(
                            update.code,
                            if index == 3 {
                                &first_code
                            } else {
                                &second_code
                            }
                            .as_str()
                        );
                        (if index == 3 { 88 } else { 1 }, vec![])
                    }
                    _ => {
                        let access = format!(
                            "a.{}.b",
                            URL_SAFE_NO_PAD.encode(br#"{"sub":"123","aud":["mobile"]}"#)
                        );
                        (
                            1,
                            PollResponse {
                                access_token: access,
                                refresh_token: "synthetic-refresh".into(),
                                account_name: "fixture".into(),
                                ..Default::default()
                            }
                            .encode_to_vec(),
                        )
                    }
                };
                let header = format!("HTTP/1.1 200 OK\r\nx-eresult: {result}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
                stream.write_all(header.as_bytes()).unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            let mut service = SteamService::new().unwrap();
            service.api_base = address;
            service.client = NetworkClient::local_test_client();
            let first = service
                .begin_login(
                    "fixture",
                    "fixture",
                    "synthetic-password",
                    Some("0"),
                    Some(&token),
                )
                .await
                .unwrap();
            assert_eq!(first.status, "guard");
            assert!(first.message.unwrap().contains("EResult 88"));
            assert!(!first.guard_submitted);
            assert!(!service.is_logged_in("fixture"));
            let second = service.submit_local_guard("fixture", &token).await.unwrap();
            assert_eq!(second.status, "authenticated");
            assert!(
                service
                    .export_session("fixture")
                    .unwrap()
                    .local_guard_verified
            );
            service.clear();
        });
        server.join().unwrap();
    }
    #[test]
    fn rejects_cross_account_binding() {
        assert!(check_identity("76561198000000001", Some("76561198000000002")).is_err());
    }
    #[test]
    fn qr_url_requires_exact_trusted_host() {
        assert!(parse_qr_url("https://s.team.evil.invalid/q/1/123").is_err());
        assert!(parse_qr_url("https://evil.invalid@ s.team/q/1/123").is_err());
        assert_eq!(parse_qr_url("https://s.team/q/1/123").unwrap(), (1, 123));
    }
    #[test]
    fn mobile_token_rejects_refresh_and_other_accounts() {
        let value = json!({"sub":"123","aud":["mobile","derive"]});
        let token = format!(
            "a.{}.b",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        );
        assert!(check_mobile_token(&token, "123").is_err());
        assert!(check_mobile_token(&token, "124").is_err());
    }
    #[test]
    fn market_path_is_encoded() {
        assert!(market_url("730", "A/B ?#").contains("A%2FB%20%3F%23"));
    }
}
