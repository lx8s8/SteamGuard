use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryCode {
    pub id: String,
    pub code: String,
    #[serde(default)]
    pub used: bool,
}
impl RecoveryCode {
    pub fn erase(&mut self) {
        use zeroize::Zeroize;
        self.code.zeroize();
    }
}
impl Drop for RecoveryCode {
    fn drop(&mut self) {
        self.erase();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub sort_order: u64,
    pub issuer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    pub kind: String,
    pub secret: Vec<u8>,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
    pub counter: u64,
    #[serde(default)]
    pub hotp_read_only: bool,
    pub steam_id: Option<String>,
    pub account_name: Option<String>,
    pub identity_secret: Option<String>,
    pub device_id: Option<String>,
    pub steam_data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery_codes: Vec<RecoveryCode>,
}
impl Token {
    pub fn new(name: String, kind: String, secret: Vec<u8>) -> Self {
        let steam = kind == "steam";
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            pinned: false,
            sort_order: 0,
            issuer: if steam { "Steam".into() } else { String::new() },
            kind,
            secret,
            icon: None,
            group: None,
            algorithm: "SHA1".into(),
            digits: if steam { 5 } else { 6 },
            period: 30,
            counter: 0,
            hotp_read_only: false,
            steam_id: None,
            account_name: None,
            identity_secret: None,
            device_id: None,
            steam_data: None,
            notes: String::new(),
            recovery_codes: vec![],
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_private_details()?;
        if let Some(icon) = &self.icon {
            crate::avatar::validate(icon)?;
        }
        if self
            .group
            .as_ref()
            .is_some_and(|g| g.trim().is_empty() || g.trim() != g || g.chars().count() > 40)
        {
            return Err("分组名称需为 1–40 个字符".into());
        }
        self.validate_otp()
    }
    pub fn validate_private_details(&self) -> Result<(), String> {
        if self.notes.chars().count() > 4096 || self.notes.contains('\0') {
            return Err("备注最多 4096 个字符，不能包含空字符".into());
        }
        if self.recovery_codes.len() > 100 {
            return Err("每个令牌最多保存 100 个备用恢复码".into());
        }
        let mut ids = std::collections::HashSet::new();
        let mut codes = std::collections::HashSet::new();
        for item in &self.recovery_codes {
            if uuid::Uuid::parse_str(&item.id)
                .ok()
                .is_none_or(|id| id.to_string() != item.id)
                || !ids.insert(&item.id)
                || !codes.insert(&item.code)
                || item.code.is_empty()
                || item.code.trim() != item.code
                || item.code.chars().count() > 256
                || item.code.chars().any(char::is_control)
            {
                return Err("备用恢复码为空、重复或格式无效".into());
            }
        }
        Ok(())
    }
    /// Authentication on the timer path validates only the OTP parameters.
    /// Artwork and grouping were validated on load and transaction commit.
    pub fn validate_otp(&self) -> Result<(), String> {
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
        self.notes.zeroize();
        self.recovery_codes.iter_mut().for_each(RecoveryCode::erase);
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
    pub pinned: bool,
    pub hotp_read_only: bool,
    pub group: Option<String>,
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub icon: Option<String>,
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
