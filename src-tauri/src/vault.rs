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

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    pub tokens: Vec<Token>,
    #[serde(default)]
    pub sessions: serde_json::Value,
    #[serde(default)]
    pub network: crate::network::NetworkSettings,
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
fn encrypt(data: &VaultData, key: &[u8; 32], salt: &[u8]) -> Result<Vec<u8>, String> {
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
    for token in &data.tokens {
        token.validate()?;
    }
    Ok(data)
}
pub fn backup(data: &VaultData, password: &str) -> Result<Vec<u8>, String> {
    if password.chars().count() < 8 {
        return Err("备份密码至少需要 8 个字符".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt(data, &*key(password, &salt)?, &salt)
}

pub struct Vault {
    pub path: PathBuf,
    pub data: Option<VaultData>,
    key: Option<Zeroizing<[u8; 32]>>,
    salt: [u8; 16],
    pub last_activity: u64,
    preview_key: Option<Zeroizing<[u8; 32]>>,
}
impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            data: None,
            key: None,
            salt: [0; 16],
            last_activity: 0,
            preview_key: None,
        }
    }
    pub fn create(&mut self, password: &str) -> Result<(), String> {
        if self.path.exists() {
            return Err("令牌库已存在，请解锁".into());
        }
        if password.chars().count() < 8 {
            return Err("主密码至少需要 8 个字符".into());
        }
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
        self.touch();
        self.recover(Some(password))?;
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
        self.touch();
        if let Err(error) = self.recover(None) {
            self.lock();
            return Err(error);
        }
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
    pub fn lock(&mut self) {
        if let Some(d) = &mut self.data {
            for t in &mut d.tokens {
                t.erase()
            }
            wipe_json(&mut d.sessions);
        }
        self.data = None;
        self.key = None;
        self.preview_key = None;
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
                wipe_json(&mut current.sessions);
            }
            self.data = Some(original);
        } else {
            self.touch();
        }
        result
    }
    pub fn save(&self) -> Result<(), String> {
        let data = self.data.as_ref().ok_or("令牌库已锁定")?;
        let key = self.key.as_ref().ok_or("令牌库已锁定")?;
        let bytes = encrypt(data, key, &self.salt)?;
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
        fs::rename(tmp, &self.path).map_err(|_| "无法保存令牌库")?;
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
}
