use crate::models::Token;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub token: Token,
    pub deleted_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    #[serde(default)]
    pub trash: Vec<TrashEntry>,
    pub tokens: Vec<Token>,
    #[serde(default)]
    pub sessions: serde_json::Value,
    #[serde(default)]
    pub network: crate::network::NetworkSettings,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default = "default_backup_enabled")]
    pub auto_backup: bool,
    #[serde(default)]
    pub sync: Option<crate::sync::State>,
}
impl Default for VaultData {
    fn default() -> Self {
        Self {
            trash: vec![],
            tokens: vec![],
            sessions: serde_json::Value::Null,
            network: Default::default(),
            groups: vec![],
            auto_backup: true,
            sync: None,
        }
    }
}
impl VaultData {
    pub fn validate(&self) -> Result<(), String> {
        for token in &self.tokens {
            token.validate()?;
        }
        for entry in &self.trash {
            entry.token.validate()?;
        }
        if self.trash.len() > 1000 {
            return Err("回收站已满，请永久删除不再需要的令牌".into());
        }
        let names = self.group_names();
        if names.len() > 100
            || names
                .iter()
                .any(|g| g.trim().is_empty() || g.trim() != g || g.chars().count() > 40)
        {
            return Err("分组无效或超过 100 个".into());
        }
        if self
            .groups
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != self.groups.len()
        {
            return Err("备份含重复分组".into());
        }
        Ok(())
    }
    pub fn group_names(&self) -> Vec<String> {
        let mut groups = self.groups.clone();
        for token in &self.tokens {
            if let Some(group) = &token.group {
                if !groups.contains(group) {
                    groups.push(group.clone());
                }
            }
        }
        groups
    }
    pub fn manage_group(
        &mut self,
        action: &str,
        name: &str,
        next: Option<&str>,
    ) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 40 {
            return Err("分组名称需为 1–40 个字符".into());
        }
        self.groups = self.group_names();
        if action == "create" {
            if self.groups.contains(&name.to_owned()) {
                return Err("分组已存在".into());
            }
            if self.groups.len() >= 100 {
                return Err("最多创建 100 个分组".into());
            }
            self.groups.push(name.into());
            return Ok(());
        }
        if !self.groups.contains(&name.to_owned()) {
            return Err("分组不存在".into());
        }
        let replacement = if action == "rename" {
            let next = next.unwrap_or("").trim();
            if next.is_empty() || next.chars().count() > 40 {
                return Err("分组名称需为 1–40 个字符".into());
            }
            if next != name && self.groups.contains(&next.to_owned()) {
                return Err("分组已存在".into());
            }
            Some(next.to_owned())
        } else if action == "delete" {
            None
        } else {
            return Err("分组操作无效".into());
        };
        for token in &mut self.tokens {
            if token.group.as_deref() == Some(name) {
                token.group = replacement.clone();
            }
        }
        if let Some(next) = replacement {
            for group in &mut self.groups {
                if group == name {
                    *group = next.clone();
                }
            }
        } else {
            self.groups.retain(|group| group != name);
        }
        Ok(())
    }
    pub fn merge_import(
        &mut self,
        tokens: Vec<Token>,
        groups: Vec<String>,
    ) -> Result<usize, String> {
        // Reject identity conflicts before applying any metadata or groups.
        let mut checked = self.tokens.clone();
        for token in &tokens {
            if let Some(existing) = checked
                .iter_mut()
                .find(|e| e.kind == token.kind && e.secret == token.secret)
            {
                merge_metadata(existing, token)?;
            } else {
                if token.kind == "steam"
                    && crate::models::known_steam_id(token.steam_id.as_deref()).is_some()
                    && checked.iter().any(|e| {
                        e.kind == "steam"
                            && crate::models::known_steam_id(e.steam_id.as_deref())
                                == crate::models::known_steam_id(token.steam_id.as_deref())
                    })
                {
                    checked.iter_mut().for_each(Token::erase);
                    return Err("同一 Steam 账号存在不同密钥，请确认已失效令牌后再导入".into());
                }
                checked.push(token.clone());
            }
        }
        checked.iter_mut().for_each(Token::erase);
        for group in groups {
            if !self.groups.contains(&group) {
                self.groups.push(group);
            }
        }
        let mut count = 0;
        for mut token in tokens {
            token.hotp_read_only = false;
            if let Some(existing) = self
                .tokens
                .iter_mut()
                .find(|e| e.kind == token.kind && e.secret == token.secret)
            {
                merge_metadata(existing, &token)?;
                token.erase();
            } else {
                token.id = uuid::Uuid::new_v4().to_string();
                token.sort_order = self
                    .tokens
                    .iter()
                    .map(|t| t.sort_order)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1024);
                self.tokens.push(token);
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn merge_backup(&mut self, mut incoming: VaultData) -> Result<usize, String> {
        let groups = incoming.group_names();
        let tokens = std::mem::take(&mut incoming.tokens);
        wipe_json(&mut incoming.sessions);
        self.merge_import(tokens, groups)
    }
}
/// A duplicate may fill absent metadata; identity differences never overwrite silently.
pub fn merge_metadata(existing: &mut Token, incoming: &Token) -> Result<bool, String> {
    let before = Zeroizing::new(serde_json::to_vec(&*existing).map_err(|_| "无法检查令牌差异")?);
    if existing.kind == "steam" {
        let old = crate::models::known_steam_id(existing.steam_id.as_deref());
        let new = crate::models::known_steam_id(incoming.steam_id.as_deref());
        if old.is_some() && new.is_some() && old != new {
            return Err("重复 Steam 令牌的 SteamID 冲突".into());
        }
        if old.is_none() && new.is_some() {
            existing.steam_id = incoming.steam_id.clone();
        }
        for (target, source, label) in [
            (
                &mut existing.identity_secret,
                &incoming.identity_secret,
                "identity_secret",
            ),
            (&mut existing.device_id, &incoming.device_id, "device_id"),
        ] {
            if let Some(value) = source.as_ref().filter(|v| !v.trim().is_empty()) {
                if target
                    .as_ref()
                    .is_some_and(|old| !old.trim().is_empty() && old != value)
                {
                    return Err(format!("重复 Steam 令牌的 {label} 冲突"));
                }
                if target.as_ref().is_none_or(|old| old.trim().is_empty()) {
                    *target = Some(value.clone());
                }
            }
        }
        if existing.account_name.as_ref().is_none_or(|v| v.is_empty()) {
            existing.account_name = incoming.account_name.clone();
        }
        fn fill(
            target: &mut serde_json::Value,
            source: &serde_json::Value,
            field: &str,
        ) -> Result<(), String> {
            if target.is_null() || target.as_str().is_some_and(str::is_empty) {
                *target = source.clone();
                return Ok(());
            }
            if let (Some(a), Some(b)) = (target.as_object_mut(), source.as_object()) {
                for (key, value) in b {
                    let target = a.entry(key).or_insert(serde_json::Value::Null);
                    let normalized = key.to_ascii_lowercase().replace('_', "");
                    if normalized == "steamid"
                        && (target.as_u64() == Some(0)
                            || target
                                .as_str()
                                .is_some_and(|v| crate::models::known_steam_id(Some(v)).is_none()))
                    {
                        *target = serde_json::Value::Null;
                    }
                    fill(target, value, &normalized)?;
                }
            } else if !source.is_null() && target != source {
                // Session cookies/timestamps and unknown extension fields can change
                // between exports. Keep the current value; only identity-bearing
                // values are conflicts, never replace any existing opaque metadata.
                if [
                    "steamid",
                    "sharedsecret",
                    "identitysecret",
                    "deviceid",
                    "revocationcode",
                    "serialnumber",
                ]
                .contains(&field)
                {
                    return Err("重复 Steam 令牌的 steam_data 冲突".into());
                }
            }
            Ok(())
        }
        if let Some(source) = &incoming.steam_data {
            fill(
                existing.steam_data.get_or_insert(serde_json::Value::Null),
                source,
                "",
            )?;
        }
    }
    if existing.group.is_none() {
        existing.group = incoming.group.clone();
    }
    if existing.icon.is_none() {
        existing.icon = incoming.icon.clone();
    }
    if existing.kind == "hotp" {
        if existing.hotp_read_only && incoming.counter > existing.counter {
            return Err("此 HOTP 的主设备为其他设备，请先切换主设备".into());
        }
        existing.counter = existing.counter.max(incoming.counter);
    }
    Ok(before.as_slice()
        != Zeroizing::new(serde_json::to_vec(existing).map_err(|_| "无法检查令牌差异")?).as_slice())
}
fn default_backup_enabled() -> bool {
    true
}
pub fn wipe_json(v: &mut serde_json::Value) {
    use zeroize::Zeroize;
    match v {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(a) => a.iter_mut().for_each(wipe_json),
        serde_json::Value::Object(m) => m.values_mut().for_each(wipe_json),
        _ => {}
    }
}
pub struct RecoveryLease {
    dir: PathBuf,
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
}
impl RecoveryLease {
    pub fn checkpoint(&self, data: &VaultData) -> Result<PathBuf, String> {
        let bytes = encrypt(data, &self.key, &self.salt)?;
        fs::create_dir_all(&self.dir).map_err(|_| "无法创建恢复目录")?;
        let path = self
            .dir
            .join(format!("recovery-{}.sgvault", uuid::Uuid::new_v4()));
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        let mut f = opts
            .open(&path)
            .map_err(|_| "无法保存新令牌恢复副本，请立即释放存储空间")?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| "新令牌恢复副本写入失败")?;
        Ok(path)
    }
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "无法派生加密密钥")?;
    Ok(key)
}
fn encrypt<T: Serialize>(data: &T, key: &[u8; 32], salt: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let plain = Zeroizing::new(serde_json::to_vec(data).map_err(|_| "无法序列化令牌")?);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "加密密钥错误")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
        .map_err(|_| "加密失败")?;
    serde_json::to_vec(&Envelope {
        format: "SteamGuard Vault".into(),
        version: 1,
        kdf: "argon2id-v19-m19456-t2-p1".into(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| "无法写入加密备份".into())
}
pub fn decode(data: &[u8], password: &str) -> Result<VaultData, String> {
    let e = envelope(data)?;
    let salt = STANDARD.decode(&e.salt).map_err(|_| "备份盐值错误")?;
    decode_key(data, &*key(password, &salt)?, &salt)
}
fn envelope(data: &[u8]) -> Result<Envelope, String> {
    let e: Envelope = serde_json::from_slice(data).map_err(|_| "加密备份格式错误")?;
    if e.format != "SteamGuard Vault" || e.version != 1 || e.kdf != "argon2id-v19-m19456-t2-p1" {
        return Err("不支持的加密备份版本".into());
    }
    Ok(e)
}
fn decode_key(data: &[u8], key: &[u8; 32], expected_salt: &[u8]) -> Result<VaultData, String> {
    let e = envelope(data)?;
    let salt = STANDARD.decode(&e.salt).map_err(|_| "备份盐值错误")?;
    if salt != expected_salt {
        return Err("设备密钥与令牌库不匹配，请使用主密码解锁".into());
    }
    let nonce = STANDARD.decode(&e.nonce).map_err(|_| "备份随机数错误")?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("备份参数无效".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "密钥错误")?;
    let ciphertext = STANDARD.decode(&e.ciphertext).map_err(|_| "备份内容无效")?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
            .map_err(|_| "密码错误或备份已损坏")?,
    );
    let data: VaultData = serde_json::from_slice(&plain).map_err(|_| "备份内容无效")?;
    data.validate()?;
    Ok(data)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Portable<'a> {
    tokens: &'a [Token],
    sessions: &'a serde_json::Value,
    network: &'a crate::network::NetworkSettings,
    groups: &'a [String],
    auto_backup: bool,
}
impl<'a> From<&'a VaultData> for Portable<'a> {
    fn from(d: &'a VaultData) -> Self {
        Self {
            tokens: &d.tokens,
            sessions: &d.sessions,
            network: &d.network,
            groups: &d.groups,
            auto_backup: d.auto_backup,
        }
    }
}
pub fn backup(data: &VaultData, password: &str) -> Result<Vec<u8>, String> {
    data.validate()?;
    if password.chars().count() < 8 {
        return Err("备份密码至少需要 8 个字符".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt(&Portable::from(data), &*key(password, &salt)?, &salt)
}

pub struct Vault {
    pub path: PathBuf,
    pub data: Option<VaultData>,
    key: Option<Zeroizing<[u8; 32]>>,
    salt: [u8; 16],
    pub last_activity: u64,
    background_since: Option<std::time::Instant>,
    preview_key: Option<Zeroizing<[u8; 32]>>,
    pub backup_error: Option<String>,
    pub sync_actor: String,
    pub device_id: String,
    pub revision: String,
}
impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            data: None,
            key: None,
            salt: [0; 16],
            last_activity: 0,
            background_since: None,
            preview_key: None,
            backup_error: None,
            sync_actor: uuid::Uuid::new_v4().to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
            revision: String::new(),
        }
    }
    fn initialize_device(&mut self) -> Result<(), String> {
        let path = self
            .path
            .parent()
            .ok_or("存储目录无效")?
            .join("device-only/sync-device.json");
        if let Ok(bytes) = fs::read(&path) {
            let id: String = serde_json::from_slice(&bytes).map_err(|_| "设备标识无效")?;
            uuid::Uuid::parse_str(&id).map_err(|_| "设备标识无效")?;
            self.device_id = id;
        } else {
            crate::quick_access::write_private(
                &path,
                &serde_json::to_vec(&self.device_id).map_err(|_| "无法编码设备标识")?,
            )?;
        }
        Ok(())
    }
    fn bind_sync_device(&mut self) {
        let valid = self.initialize_device().is_ok();
        if let Some(data) = &mut self.data {
            if !valid
                || data
                    .sync
                    .as_ref()
                    .is_some_and(|s| s.device != self.device_id)
            {
                data.sync = None;
            }
            if data.sync.is_none() {
                for token in &mut data.tokens {
                    token.hotp_read_only = false;
                }
            }
        }
    }
    fn data_revision(data: &VaultData) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let sessions = data
            .sessions
            .as_object()
            .map(|m| m.keys().collect::<Vec<_>>())
            .unwrap_or_default();
        let bytes = Zeroizing::new(
            serde_json::to_vec(&(&data.tokens, &data.groups, sessions))
                .map_err(|_| "无法生成令牌版本")?,
        );
        Ok(format!("{:x}", Sha256::digest(&bytes)))
    }
    pub fn create(&mut self, password: &str) -> Result<(), String> {
        if self.path.exists() {
            return Err("令牌库已存在，请解锁".into());
        }
        if password.chars().count() < 8 {
            return Err("主密码至少需要 8 个字符".into());
        }
        self.initialize_device()?;
        OsRng.fill_bytes(&mut self.salt);
        self.key = Some(key(password, &self.salt)?);
        self.data = Some(VaultData::default());
        self.touch();
        if let Err(error) = self.save() {
            self.lock();
            return Err(error);
        }
        Ok(())
    }
    pub fn change_password(
        &mut self,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), String> {
        self.credential(current_password)?;
        if new_password.chars().count() < 8 {
            return Err("主密码至少需要 8 个字符".into());
        }
        // A failed replacement leaves the previous password and in-memory key intact.
        let mut next_salt = [0u8; 16];
        OsRng.fill_bytes(&mut next_salt);
        let next_key = key(new_password, &next_salt)?;
        let previous_key = self.key.replace(next_key);
        let previous_salt = std::mem::replace(&mut self.salt, next_salt);
        let result = self.save();
        if result.is_err() {
            self.key = previous_key;
            self.salt = previous_salt;
        }
        result
    }
    pub fn unlock(&mut self, password: &str) -> Result<(), String> {
        let bytes = fs::read(&self.path).map_err(|_| "无法读取令牌库")?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("令牌库过大".into());
        }
        let data = decode(&bytes, password)?;
        let e: Envelope = serde_json::from_slice(&bytes).map_err(|_| "令牌库格式错误")?;
        let salt = STANDARD.decode(&e.salt).map_err(|_| "盐值错误")?;
        self.salt.copy_from_slice(&salt);
        self.key = Some(key(password, &self.salt)?);
        self.data = Some(data);
        self.bind_sync_device();
        self.touch();
        self.recover(Some(password))?;
        self.revision = Self::data_revision(self.data.as_ref().ok_or("保险库已锁定")?)?;
        Ok(())
    }
    /// This credential stays between Rust and the device's protected native store.
    pub fn credential(&self, password: &str) -> Result<Zeroizing<String>, String> {
        let current = self.key.as_ref().ok_or("请先解锁保险库")?;
        let candidate = key(password, &self.salt)?;
        let mismatch = current
            .iter()
            .zip(candidate.iter())
            .fold(0u8, |a, (x, y)| a | (x ^ y));
        if mismatch != 0 {
            return Err("主密码错误".into());
        }
        Ok(Zeroizing::new(serde_json::json!({"key":STANDARD.encode(current.as_ref()), "salt":STANDARD.encode(self.salt)}).to_string()))
    }
    pub fn unlock_credential(&mut self, credential: &str) -> Result<(), String> {
        #[derive(Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
        #[serde(deny_unknown_fields)]
        struct Credential {
            key: String,
            salt: String,
        }
        let c: Credential = serde_json::from_str(credential).map_err(|_| "设备密钥格式错误")?;
        let k = crate::quick_access::read_key(&c.key)?;
        let salt = STANDARD.decode(&c.salt).map_err(|_| "设备密钥格式错误")?;
        if salt.len() != 16 {
            return Err("设备密钥格式错误".into());
        }
        let bytes = fs::read(&self.path).map_err(|_| "无法读取令牌库")?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("令牌库过大".into());
        }
        let data = decode_key(&bytes, &k, &salt)?;
        self.salt.copy_from_slice(&salt);
        self.key = Some(k);
        self.data = Some(data);
        self.bind_sync_device();
        self.touch();
        if let Err(error) = self.recover(None) {
            self.lock();
            return Err(error);
        }
        self.revision = Self::data_revision(self.data.as_ref().ok_or("保险库已锁定")?)?;
        Ok(())
    }
    pub fn preview_key(&mut self, key: Option<Zeroizing<[u8; 32]>>) -> Result<(), String> {
        self.preview_key = key;
        if let Some(key) = &self.preview_key {
            crate::quick_access::save_preview(
                &self.path,
                &self.data.as_ref().ok_or("请先解锁保险库")?.tokens,
                key,
            )?;
        } else {
            let path = crate::quick_access::preview_path(&self.path);
            if path.exists() {
                fs::remove_file(path).map_err(|_| "无法清除预览缓存")?;
            }
        }
        Ok(())
    }
    pub fn portable_encrypted(&self) -> Result<Vec<u8>, String> {
        let d = self.data.as_ref().ok_or("请先解锁保险库")?;
        encrypt(
            &Portable::from(d),
            self.key.as_ref().ok_or("保险库已锁定")?,
            &self.salt,
        )
    }
    pub fn lock(&mut self) {
        if let Some(d) = &mut self.data {
            for t in &mut d.tokens {
                t.erase()
            }
            for entry in &mut d.trash {
                entry.token.erase();
            }
            wipe_json(&mut d.sessions);
        }
        self.data = None;
        self.key = None;
        self.preview_key = None;
        self.background_since = None;
    }
    /// Native monotonic clock survives webview timer suspension and wall-clock changes.
    pub fn set_background(&mut self, hidden: bool) {
        if hidden {
            self.background_since
                .get_or_insert_with(std::time::Instant::now);
        } else {
            self.background_since = None;
        }
    }
    pub fn background_expired(&self) -> bool {
        self.background_since
            .is_some_and(|since| since.elapsed() >= std::time::Duration::from_secs(60))
    }
    pub fn touch(&mut self) {
        self.last_activity = crate::models::now();
    }
    pub fn ensure(&mut self) -> Result<&mut VaultData, String> {
        self.data
            .as_mut()
            .ok_or_else(|| "令牌库已锁定，请先解锁".into())
    }
    pub fn lease(&self) -> Result<RecoveryLease, String> {
        Ok(RecoveryLease {
            dir: self.path.parent().ok_or("令牌库目录无效")?.to_owned(),
            key: Zeroizing::new(**self.key.as_ref().ok_or("令牌库已锁定")?),
            salt: self.salt,
        })
    }
    fn recover(&mut self, password: Option<&str>) -> Result<(), String> {
        let dir = self.path.parent().ok_or("令牌库目录无效")?;
        let mut files = fs::read_dir(dir)
            .map_err(|_| "无法读取恢复目录")?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("recovery-"))
                    && p.extension().is_some_and(|x| x == "sgvault")
            })
            .collect::<Vec<_>>();
        // Apply older checkpoints first so a later transfer cannot be overwritten.
        files.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
        for path in files {
            let bytes = fs::read(&path).map_err(|_| "无法读取待恢复令牌")?;
            let recovered = match password {
                Some(p) => decode(&bytes, p),
                None => decode_key(&bytes, self.key.as_ref().ok_or("令牌库已锁定")?, &self.salt),
            }
            .map_err(|_| {
                "存在未恢复的 Steam 令牌，请保留 recovery 文件并使用其创建时的主密码导入"
            })?;
            let data = self.data.as_mut().ok_or("令牌库已锁定")?;
            for t in recovered.tokens {
                if let Some(old) = data
                    .tokens
                    .iter_mut()
                    .find(|x| x.id == t.id || t.steam_id.is_some() && x.steam_id == t.steam_id)
                {
                    old.erase();
                    *old = t;
                } else {
                    data.tokens.push(t)
                }
            }
            if let Some(sessions) = recovered.sessions.as_object() {
                if !data.sessions.is_object() {
                    data.sessions = serde_json::json!({})
                }
                for (k, v) in sessions {
                    data.sessions[k] = v.clone()
                }
            }
            let ids = data
                .tokens
                .iter()
                .map(|t| t.id.clone())
                .collect::<std::collections::HashSet<_>>();
            if let Some(sessions) = data.sessions.as_object_mut() {
                sessions.retain(|id, _| ids.contains(id));
            }
            self.save()?;
            fs::remove_file(path).map_err(|_| "令牌已恢复，但恢复副本清理失败")?;
        }
        Ok(())
    }
    /// Commit local changes only after the encrypted replacement reaches disk.
    pub fn update<T>(
        &mut self,
        change: impl FnOnce(&mut VaultData) -> Result<T, String>,
    ) -> Result<T, String> {
        let snapshot =
            Zeroizing::new(serde_json::to_vec(self.ensure()?).map_err(|_| "无法创建令牌库事务")?);
        let result = change(self.ensure()?).and_then(|value| {
            self.save()?;
            Ok(value)
        });
        if result.is_err() {
            let original = serde_json::from_slice(&snapshot).map_err(|_| "无法恢复令牌库事务")?;
            if let Some(current) = &mut self.data {
                for token in &mut current.tokens {
                    token.erase();
                }
                for entry in &mut current.trash {
                    entry.token.erase();
                }
                wipe_json(&mut current.sessions);
            }
            self.data = Some(original);
        } else {
            self.touch();
        }
        result
    }
    pub fn save(&mut self) -> Result<(), String> {
        let data = self.data.as_mut().ok_or("令牌库已锁定")?;
        crate::sync::record_local(data, &self.sync_actor)?;
        data.validate()?;
        let revision = Self::data_revision(data)?;
        let key = self.key.as_ref().ok_or("令牌库已锁定")?;
        let bytes = encrypt(data, key, &self.salt)?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("保险库达到大小限制，请导出备份，断开同步后创建新的同步库".into());
        }
        let dir = self.path.parent().ok_or("存储目录无效")?;
        fs::create_dir_all(dir).map_err(|_| "无法创建存储目录")?;
        let tmp = self.path.with_extension("tmp");
        // Write the replacement with owner-only permissions before it contains secrets.
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|_| "无法创建令牌库")?;
        use std::io::Write;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| "无法写入令牌库")?;
        let snapshots = if data.auto_backup {
            let current = Zeroizing::new(
                serde_json::to_vec(&Portable::from(&*data)).map_err(|_| "无法编码备份")?,
            );
            let mut old = fs::read(&self.path)
                .ok()
                .and_then(|bytes| decode_key(&bytes, key, &self.salt).ok());
            let previous = old
                .as_ref()
                .and_then(|d| serde_json::to_vec(&Portable::from(d)).ok())
                .map(Zeroizing::new);
            // Sync bookkeeping must not rotate away useful authenticator snapshots.
            let changed = previous.as_ref().map(|v| v.as_slice()) != Some(current.as_slice());
            let snapshots = if changed {
                Some((
                    encrypt(&Portable::from(&*data), key, &self.salt)?,
                    old.as_ref()
                        .and_then(|d| encrypt(&Portable::from(d), key, &self.salt).ok()),
                ))
            } else {
                None
            };
            if let Some(d) = &mut old {
                for token in &mut d.tokens {
                    token.erase();
                }
                wipe_json(&mut d.sessions);
            }
            snapshots
        } else {
            None
        };
        fs::rename(tmp, &self.path).map_err(|_| "无法保存令牌库")?;
        self.revision = revision;
        if let Some((portable, previous)) = snapshots {
            self.backup_error = crate::backup::record(
                &self.path,
                previous.as_deref(),
                &portable,
                crate::models::now(),
            )
            .err();
        } else if !data.auto_backup {
            self.backup_error = None;
        }
        if let Some(key) = &self.preview_key {
            // A preview failure must not lose a newly enrolled authenticator. Its
            // vault hash makes any previous snapshot unusable after this save.
            let _ = crate::quick_access::save_preview(&self.path, &data.tokens, key);
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_and_automatic_backups_exclude_sync_credentials_and_restored_devices_disconnect() {
        let dir =
            std::env::temp_dir().join(format!("steamguard-sync-backup-{}", uuid::Uuid::new_v4()));
        let mut v = Vault::new(dir.join("vault.sgvault"));
        v.create("synthetic-vault-password").unwrap();
        let device = v.device_id.clone();
        let (h, k) = crate::sync::create_header(
            &uuid::Uuid::new_v4().to_string(),
            "synthetic-sync-password",
        )
        .unwrap();
        v.update(|d| {
            d.tokens
                .push(Token::new("Fixture".into(), "totp".into(), vec![42; 20]));
            d.sync = Some(crate::sync::State::new(
                "https://example.invalid/dav/".into(),
                "fixture".into(),
                "private-dav-credential".into(),
                &h,
                &k,
                device,
            ));
            Ok(())
        })
        .unwrap();
        let exported = backup(v.data.as_ref().unwrap(), "synthetic-backup-password").unwrap();
        assert!(decode(&exported, "synthetic-backup-password")
            .unwrap()
            .sync
            .is_none());
        let portable = v.portable_encrypted().unwrap();
        assert!(decode(&portable, "synthetic-vault-password")
            .unwrap()
            .sync
            .is_none());
        let snapshots = crate::backup::list(&v.path).unwrap();
        let count = snapshots.len();
        v.update(|d| {
            d.sync.as_mut().unwrap().active = false;
            Ok(())
        })
        .unwrap();
        assert_eq!(crate::backup::list(&v.path).unwrap().len(), count);
        for entry in snapshots {
            let bytes = crate::backup::read(&v.path, &entry.name).unwrap();
            assert!(decode(&bytes, "synthetic-vault-password")
                .unwrap()
                .sync
                .is_none());
        }
        v.lock();
        v.unlock("synthetic-vault-password").unwrap();
        assert!(v.data.as_ref().unwrap().sync.is_some());
        let restored_dir = dir.join("restored");
        std::fs::create_dir_all(&restored_dir).unwrap();
        let restored = restored_dir.join("vault.sgvault");
        std::fs::copy(&v.path, &restored).unwrap();
        let mut other = Vault::new(restored);
        other.unlock("synthetic-vault-password").unwrap();
        assert!(other.data.as_ref().unwrap().sync.is_none());
        assert_eq!(other.data.as_ref().unwrap().tokens.len(), 1);
        v.lock();
        other.lock();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn old_vault_without_network_preferences_remains_compatible() {
        let data: VaultData = serde_json::from_str(r#"{"tokens":[],"sessions":null}"#).unwrap();
        assert!(data.network.mode == crate::network::ProxyMode::System);
        assert!(data.network.proxy_url.is_empty());
    }
    #[test]
    fn interrupted_enrollment_recovers_after_unlock() {
        let dir = std::env::temp_dir().join(format!("steamguard-test-{}", uuid::Uuid::new_v4()));
        let mut v = Vault::new(dir.join("vault.sgvault"));
        v.create("fixture password").unwrap();
        let lease = v.lease().unwrap();
        v.lock();
        let checkpoint = lease
            .checkpoint(&VaultData {
                tokens: vec![Token::new(
                    "recovery fixture".into(),
                    "steam".into(),
                    vec![1; 20],
                )],
                sessions: serde_json::Value::Null,
                ..Default::default()
            })
            .unwrap();
        assert!(checkpoint.exists());
        v.unlock("fixture password").unwrap();
        assert_eq!(v.ensure().unwrap().tokens.len(), 1);
        assert!(!checkpoint.exists());
        v.lock();
        v.unlock("fixture password").unwrap();
        assert_eq!(v.ensure().unwrap().tokens.len(), 1);
        v.lock();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_save_rolls_back_local_changes() {
        let dir = std::env::temp_dir().join(format!("steamguard-test-{}", uuid::Uuid::new_v4()));
        let mut v = Vault::new(dir.join("vault.sgvault"));
        v.create("fixture password").unwrap();
        v.update(|d| {
            d.tokens
                .push(Token::new("original".into(), "hotp".into(), vec![1; 20]));
            Ok(())
        })
        .unwrap();
        // A directory at the temporary file path deterministically prevents writes.
        fs::create_dir(v.path.with_extension("tmp")).unwrap();
        assert!(v
            .update(|d| {
                d.tokens[0].counter += 1;
                d.tokens[0].name = "changed".into();
                d.sessions = serde_json::json!({"fixture":"session"});
                Ok(())
            })
            .is_err());
        let d = v.ensure().unwrap();
        assert_eq!(d.tokens[0].counter, 0);
        assert_eq!(d.tokens[0].name, "original");
        assert!(d.sessions.is_null());
        v.lock();
        v.unlock("fixture password").unwrap();
        assert_eq!(v.ensure().unwrap().tokens[0].counter, 0);
        v.lock();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_creation_does_not_leave_vault_unlocked() {
        let dir = std::env::temp_dir().join(format!("steamguard-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut v = Vault::new(dir.join("vault.sgvault"));
        fs::create_dir(v.path.with_extension("tmp")).unwrap();
        assert!(v.create("fixture password").is_err());
        assert!(v.data.is_none() && v.key.is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "manual isolated native UI fixture, requires STEAMGUARD_QA_DIR"]
    fn native_ui_fixture() {
        let dir = std::path::PathBuf::from(std::env::var("STEAMGUARD_QA_DIR").unwrap());
        assert_eq!(dir.file_name().unwrap(), "com.kasen.steamguard.qa");
        let path = dir.join("vault.sgvault");
        assert!(!path.exists(), "refusing to replace an existing QA vault");
        let mut v = Vault::new(path);
        v.create("synthetic-native-qa-password").unwrap();
        v.update(|d| {
            for (name, issuer, kind, brand, secret) in [
                ("Google · demo@example.test", "Google", "totp", "google", 1),
                ("GitHub · demo", "GitHub", "totp", "github", 2),
                ("Steam · demo", "Steam", "steam", "steam", 3),
            ] {
                let mut token = Token::new(name.into(), kind.into(), vec![secret; 20]);
                token.issuer = issuer.into();
                token.icon = Some(format!("brand:{brand}"));
                d.tokens.push(token);
            }
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn avatars_survive_encrypted_backup_and_merge_without_overwriting_existing_choice() {
        let mut token = Token::new("avatar".into(), "totp".into(), vec![3; 20]);
        token.icon = Some("brand:github".into());
        let data = VaultData {
            tokens: vec![token.clone()],
            ..Default::default()
        };
        let encrypted = backup(&data, "synthetic-password").unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("brand:github"));
        let restored = decode(&encrypted, "synthetic-password").unwrap();
        assert_eq!(restored.tokens[0].icon, token.icon);
        token.icon = None;
        let mut existing = VaultData {
            tokens: vec![token],
            ..Default::default()
        };
        assert_eq!(existing.merge_backup(restored).unwrap(), 0);
        assert_eq!(existing.tokens[0].icon.as_deref(), Some("brand:github"));
        existing.tokens[0].icon = Some("brand:google".into());
        existing.merge_import(data.tokens, vec![]).unwrap();
        assert_eq!(existing.tokens[0].icon.as_deref(), Some("brand:google"));
    }
    #[test]
    fn encrypted_roundtrip_rejects_password_and_tamper() {
        let d = VaultData {
            tokens: vec![Token::new("fixture".into(), "totp".into(), vec![1; 20])],
            sessions: serde_json::Value::Null,
            ..Default::default()
        };
        let b = backup(&d, "fixture password").unwrap();
        assert!(!String::from_utf8_lossy(&b).contains("fixture"));
        assert_eq!(decode(&b, "fixture password").unwrap().tokens.len(), 1);
        assert!(decode(&b, "wrong").is_err());
        let mut e: serde_json::Value = serde_json::from_slice(&b).unwrap();
        e["ciphertext"] = serde_json::Value::String(STANDARD.encode([0; 32]));
        assert!(decode(&serde_json::to_vec(&e).unwrap(), "fixture password").is_err());
    }
    #[test]
    fn device_credential_unlocks_saved_changes_and_recovery_but_not_another_vault() {
        let dir = std::env::temp_dir().join(format!("steamguard-device-{}", uuid::Uuid::new_v4()));
        let mut v = Vault::new(dir.join("vault.sgvault"));
        v.create("fixture password").unwrap();
        assert!(v.credential("wrong password").is_err());
        let credential = v.credential("fixture password").unwrap();
        let preview_key = crate::quick_access::new_key();
        v.preview_key(Some(preview_key)).unwrap();
        let lease = v.lease().unwrap();
        v.update(|d| {
            d.tokens
                .push(Token::new("original".into(), "totp".into(), vec![1; 20]));
            Ok(())
        })
        .unwrap();
        let recovered = VaultData {
            tokens: vec![Token::new("recovered".into(), "steam".into(), vec![2; 20])],
            ..Default::default()
        };
        lease.checkpoint(&recovered).unwrap();
        v.lock();
        v.unlock_credential(&credential).unwrap();
        assert_eq!(v.ensure().unwrap().tokens.len(), 2);
        v.lock();
        let mut other = Vault::new(dir.join("other.sgvault"));
        other.create("fixture password").unwrap();
        other.lock();
        assert!(other.unlock_credential(&credential).is_err());
        assert!(other.data.is_none());
        v.unlock("fixture password").unwrap();
        assert_eq!(v.ensure().unwrap().tokens.len(), 2);
        v.lock();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn groups_roundtrip_rename_delete_and_merge_preserves_current_tokens_and_hotp() {
        let mut d = VaultData::default();
        d.manage_group("create", "邮箱", None).unwrap();
        d.manage_group("create", "空分组", None).unwrap();
        let mut hotp = Token::new("fixture".into(), "hotp".into(), vec![1; 20]);
        hotp.group = Some("邮箱".into());
        hotp.counter = 20;
        d.tokens.push(hotp.clone());
        assert!(d.manage_group("create", "邮箱", None).is_err());
        assert!(d.manage_group("rename", "邮箱", Some("空分组")).is_err());
        d.manage_group("rename", "邮箱", Some("工作")).unwrap();
        assert_eq!(d.tokens[0].group.as_deref(), Some("工作"));
        let encoded = backup(&d, "fixture password").unwrap();
        let mut decoded = decode(&encoded, "fixture password").unwrap();
        assert_eq!(decoded.groups, vec!["工作", "空分组"]);
        hotp.counter = 10;
        hotp.group = Some("恢复组".into());
        let source = VaultData {
            tokens: vec![
                hotp,
                Token::new("another".into(), "totp".into(), vec![2; 20]),
            ],
            groups: vec!["恢复组".into(), "空备份组".into()],
            sessions: serde_json::json!({"fixture":"do-not-restore-session"}),
            ..Default::default()
        };
        assert_eq!(decoded.merge_backup(source).unwrap(), 1);
        assert_eq!(decoded.tokens[0].counter, 20);
        assert!(decoded.sessions.is_null());
        assert!(decoded.groups.contains(&"空备份组".into()));
        decoded.manage_group("delete", "工作", None).unwrap();
        assert!(decoded.tokens[0].group.is_none());
        assert_eq!(decoded.tokens.len(), 2);
        let old: VaultData = serde_json::from_str(r#"{"tokens":[],"sessions":null}"#).unwrap();
        assert!(old.auto_backup && old.groups.is_empty());
    }
    #[test]
    fn backup_failure_keeps_committed_vault_and_is_reported() {
        let dir = std::env::temp_dir().join(format!(
            "steamguard-backup-failure-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("backups"), b"block backup directory").unwrap();
        let mut v = Vault::new(dir.join("vault.sgvault"));
        v.create("fixture password").unwrap();
        assert!(v.backup_error.is_some());
        v.update(|d| {
            d.tokens
                .push(Token::new("fixture".into(), "totp".into(), vec![1; 20]));
            Ok(())
        })
        .unwrap();
        assert!(v.backup_error.is_some());
        v.lock();
        v.unlock("fixture password").unwrap();
        assert_eq!(v.ensure().unwrap().tokens.len(), 1);
        v.lock();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn backup_merge_does_not_reintroduce_old_secret_for_existing_steam_account() {
        let mut current = Token::new("current".into(), "steam".into(), vec![1; 20]);
        current.steam_id = Some("123".into());
        let mut old = Token::new("old revoked secret".into(), "steam".into(), vec![2; 20]);
        old.steam_id = Some("123".into());
        let mut target = VaultData {
            tokens: vec![current],
            ..Default::default()
        };
        assert!(target
            .merge_backup(VaultData {
                tokens: vec![old],
                ..Default::default()
            })
            .is_err());
        assert_eq!(target.tokens.len(), 1);
        assert_eq!(target.tokens[0].secret, vec![1; 20]);
    }
    #[test]
    fn import_existing_tokens_restores_groups_and_never_saves_an_invalid_merged_vault() {
        let mut token = Token::new("fixture".into(), "hotp".into(), vec![1; 20]);
        token.counter = 30;
        let mut existing = VaultData {
            tokens: vec![token.clone()],
            ..Default::default()
        };
        token.group = Some("恢复分组".into());
        token.counter = 10;
        assert_eq!(
            existing
                .merge_import(vec![token], vec!["恢复分组".into(), "空分组".into()])
                .unwrap(),
            0
        );
        assert_eq!(existing.tokens.len(), 1);
        assert_eq!(existing.tokens[0].group.as_deref(), Some("恢复分组"));
        assert_eq!(existing.tokens[0].counter, 30);
        existing.validate().unwrap();
        let dir =
            std::env::temp_dir().join(format!("steamguard-group-limit-{}", uuid::Uuid::new_v4()));
        let mut vault = Vault::new(dir.join("vault.sgvault"));
        vault.create("fixture password").unwrap();
        assert!(vault
            .update(|d| {
                d.groups = (0..101).map(|i| format!("group-{i}")).collect();
                Ok(())
            })
            .is_err());
        assert!(vault.ensure().unwrap().groups.is_empty());
        vault.lock();
        vault.unlock("fixture password").unwrap();
        assert!(vault.ensure().unwrap().groups.is_empty());
        vault.lock();
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    #[test]
    fn duplicate_steam_enriches_missing_identity_and_rejects_conflicts_atomically() {
        let mut old = Token::new("existing".into(), "steam".into(), vec![3; 20]);
        old.steam_id = Some("0".into());
        old.steam_data = Some(serde_json::json!({"steamid":"0","existing":"keep"}));
        let mut incoming = old.clone();
        incoming.steam_id = Some("123456789".into());
        incoming.identity_secret = Some("synthetic-identity".into());
        incoming.device_id = Some("android:fixture".into());
        incoming.steam_data =
            Some(serde_json::json!({"steamid":"123456789","revocation_code":"synthetic-revoke"}));
        let mut data = VaultData {
            tokens: vec![old],
            ..Default::default()
        };
        assert_eq!(
            data.merge_import(vec![incoming.clone()], vec![]).unwrap(),
            0
        );
        assert_eq!(data.tokens[0].steam_id, incoming.steam_id);
        assert_eq!(data.tokens[0].identity_secret, incoming.identity_secret);
        assert_eq!(
            data.tokens[0].steam_data.as_ref().unwrap()["existing"],
            "keep"
        );
        let before = serde_json::to_vec(&data).unwrap();
        incoming.device_id = Some("android:different".into());
        assert!(data
            .merge_import(vec![incoming], vec!["must-not-commit".into()])
            .is_err());
        assert_eq!(serde_json::to_vec(&data).unwrap(), before);
    }
    #[test]
    fn password_rotation_commits_atomically_and_invalidates_old_device_credentials() {
        let dir =
            std::env::temp_dir().join(format!("steamguard-password-{}", uuid::Uuid::new_v4()));
        let mut vault = Vault::new(dir.join("vault.sgvault"));
        vault.create("original password").unwrap();
        let credential = vault.credential("original password").unwrap();
        assert!(vault
            .change_password("wrong password", "replacement password")
            .is_err());
        std::fs::create_dir(vault.path.with_extension("tmp")).unwrap();
        assert!(vault
            .change_password("original password", "replacement password")
            .is_err());
        vault.credential("original password").unwrap();
        std::fs::remove_dir(vault.path.with_extension("tmp")).unwrap();
        vault
            .change_password("original password", "replacement password")
            .unwrap();
        vault.lock();
        assert!(vault.unlock("original password").is_err());
        assert!(vault.unlock_credential(&credential).is_err());
        vault.unlock("replacement password").unwrap();
        vault.lock();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn native_background_timeout_is_monotonic_and_does_not_extend_on_repeat_events() {
        let mut vault = Vault::new(std::env::temp_dir().join("unused-background-vault"));
        assert!(!vault.background_expired());
        vault.set_background(true);
        let original = vault.background_since;
        vault.set_background(true);
        assert_eq!(vault.background_since, original);
        vault.background_since =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(61));
        assert!(vault.background_expired());
        vault.touch();
        assert!(vault.background_expired());
        vault.lock();
        assert!(!vault.background_expired());
        vault.set_background(true);
        vault.set_background(false);
        assert!(!vault.background_expired());
    }
    #[test]
    fn duplicate_steam_export_keeps_current_session_and_fills_identity_without_false_conflicts() {
        let mut old = Token::new("current label".into(), "steam".into(), vec![4; 20]);
        old.steam_data = Some(
            serde_json::json!({"Session":{"SteamID":"0","AccessToken":"current-session"},"extension":"current"}),
        );
        let mut incoming = old.clone();
        incoming.steam_id = Some("76561198000000001".into());
        incoming.identity_secret = Some("synthetic-identity".into());
        incoming.steam_data = Some(
            serde_json::json!({"Session":{"SteamID":"76561198000000001","AccessToken":"older-session","RefreshToken":"synthetic-refresh"},"extension":"old","revocation_code":"synthetic-revoke"}),
        );
        assert!(merge_metadata(&mut old, &incoming).unwrap());
        let metadata = old.steam_data.as_ref().unwrap();
        assert_eq!(metadata["Session"]["AccessToken"], "current-session");
        assert_eq!(metadata["Session"]["SteamID"], "76561198000000001");
        assert_eq!(metadata["extension"], "current");
        assert_eq!(metadata["revocation_code"], "synthetic-revoke");
        incoming.steam_data.as_mut().unwrap()["revocation_code"] = "different-revoke".into();
        assert!(merge_metadata(&mut old, &incoming).is_err());
        old.erase();
        incoming.erase();
    }
}
