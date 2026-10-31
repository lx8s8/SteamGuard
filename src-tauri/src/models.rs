use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub name: String,
    pub issuer: String,
    #[serde(default)]
    pub group: Option<String>,
    pub kind: String,
    pub secret: Vec<u8>,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
    pub counter: u64,
    pub steam_id: Option<String>,
    pub account_name: Option<String>,
    pub identity_secret: Option<String>,
    pub device_id: Option<String>,
    pub steam_data: Option<serde_json::Value>,
}
impl Token {
    pub fn new(name: String, kind: String, secret: Vec<u8>) -> Self {
        let steam = kind == "steam";
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            issuer: if steam { "Steam".into() } else { String::new() },
            kind,
            secret,
            group: None,
            algorithm: "SHA1".into(),
            digits: if steam { 5 } else { 6 },
            period: 30,
            counter: 0,
            steam_id: None,
            account_name: None,
            identity_secret: None,
            device_id: None,
            steam_data: None,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self
            .group
            .as_ref()
            .is_some_and(|g| g.trim().is_empty() || g.trim() != g || g.chars().count() > 40)
        {
            return Err("分组名称需为 1–40 个字符".into());
        }
        if self.secret.is_empty() || self.secret.len() > 4096 {
            return Err("令牌密钥为空或过长".into());
        }
        if !["steam", "totp", "hotp", "battlenet"].contains(&self.kind.as_str()) {
            return Err("不支持的令牌类型".into());
        }
        if !(1..=86400).contains(&self.period) || !(4..=10).contains(&self.digits) {
            return Err("令牌周期或位数无效".into());
        }
        if !["SHA1", "SHA256", "SHA512"].contains(&self.algorithm.as_str()) {
            return Err("不支持的 HMAC 算法".into());
        }
        Ok(())
    }
    pub fn erase(&mut self) {
        use zeroize::Zeroize;
        fn wipe(v: &mut serde_json::Value) {
            match v {
                serde_json::Value::String(s) => s.zeroize(),
                serde_json::Value::Array(a) => a.iter_mut().for_each(wipe),
                serde_json::Value::Object(m) => m.values_mut().for_each(wipe),
                _ => {}
            }
        }
        self.secret.zeroize();
        if let Some(s) = &mut self.identity_secret {
            s.zeroize()
        };
        if let Some(v) = &mut self.steam_data {
            wipe(v)
        };
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    pub group: Option<String>,
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub kind: String,
    pub code: String,
    pub period: u64,
    pub remaining: u64,
    pub algorithm: String,
    pub digits: u32,
    pub counter: u64,
    pub steam_id: Option<String>,
    pub account_name: Option<String>,
    pub logged_in: bool,
    pub has_identity_secret: bool,
    pub enrollment_pending: bool,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Legacy backups use 0/empty SteamID to mean unknown, never a different account.
pub fn known_steam_id(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.bytes().all(|b| b == b'0'))
}
