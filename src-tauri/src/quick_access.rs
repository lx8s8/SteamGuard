//! Optional device-bound access. Preview never opens the vault or restores Steam sessions.
use crate::{
    models::{Token, TokenView},
    otp,
};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const AAD: &[u8] = b"SteamGuard read-only preview v1";
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub preview_enabled: bool,
    pub biometric_enabled: bool,
}
pub struct QuickAccess {
    path: PathBuf,
    preferences: Mutex<Preferences>,
    preview: Mutex<Option<Snapshot>>,
    busy: AtomicBool,
}
pub struct AccessLease<'a>(&'a AtomicBool);
impl Drop for AccessLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl QuickAccess {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join("quick-access.json");
        let preferences = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            preferences: Mutex::new(preferences),
            preview: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }
    pub fn operation(&self) -> Result<AccessLease<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "设备认证正在进行，请稍候")?;
        Ok(AccessLease(&self.busy))
    }
    pub fn preferences(&self) -> Result<Preferences, String> {
        Ok(self
            .preferences
            .lock()
            .map_err(|_| "快捷设置不可用")?
            .clone())
    }
    pub fn set(&self, slot: &str, enabled: bool) -> Result<(), String> {
        let mut prefs = self.preferences.lock().map_err(|_| "快捷设置不可用")?;
        let mut next = prefs.clone();
        match slot {
            "preview" => next.preview_enabled = enabled,
            "biometric" => next.biometric_enabled = enabled,
            _ => return Err("未知的解锁选项".into()),
        }
        write_private(
            &self.path,
            &serde_json::to_vec(&next).map_err(|_| "无法保存快捷设置")?,
        )?;
        *prefs = next;
        Ok(())
    }
    pub fn active(&self) -> bool {
        self.preview.lock().is_ok_and(|p| p.is_some())
    }
    pub fn clear(&self) {
        if let Ok(mut p) = self.preview.lock() {
            *p = None;
        }
    }
    pub fn enter(&self, snapshot: Snapshot) -> Result<(), String> {
        *self.preview.lock().map_err(|_| "预览不可用")? = Some(snapshot);
        Ok(())
    }
    pub fn tokens(&self, vault_path: &Path, now: u64) -> Result<Vec<TokenView>, String> {
        let mut preview = self.preview.lock().map_err(|_| "预览不可用")?;
        let snapshot = preview.as_ref().ok_or("请先进入令牌预览")?;
        if !self.preferences()?.preview_enabled || snapshot.vault_hash != vault_hash(vault_path)? {
            *preview = None;
            return Err("令牌库已更新，请解锁后刷新预览".into());
        }
        snapshot
            .tokens
            .iter()
            .map(|t| {
                let mut token = t.token();
                let code = otp::code(&token, now);
                token.erase();
                Ok(TokenView {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    issuer: t.issuer.clone(),
                    kind: t.kind.clone(),
                    code: code?,
                    period: t.period,
                    remaining: if t.kind == "hotp" {
                        0
                    } else {
                        t.period - now % t.period
                    },
                    algorithm: t.algorithm.clone(),
                    digits: t.digits,
                    counter: t.counter,
                    steam_id: None,
                    account_name: None,
                    logged_in: false,
                    has_identity_secret: false,
                    enrollment_pending: false,
                })
            })
            .collect()
    }
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewToken {
    id: String,
    name: String,
    issuer: String,
    kind: String,
    secret: Vec<u8>,
    algorithm: String,
    digits: u32,
    period: u64,
    counter: u64,
}
impl PreviewToken {
    fn from(t: &Token) -> Self {
        Self {
            id: t.id.clone(),
            name: t.name.clone(),
            issuer: t.issuer.clone(),
            kind: t.kind.clone(),
            secret: t.secret.clone(),
            algorithm: t.algorithm.clone(),
            digits: t.digits,
            period: t.period,
            counter: t.counter,
        }
    }
    fn token(&self) -> Token {
        let mut t = Token::new(self.name.clone(), self.kind.clone(), self.secret.clone());
        t.id = self.id.clone();
        t.issuer = self.issuer.clone();
        t.algorithm = self.algorithm.clone();
        t.digits = self.digits;
        t.period = self.period;
        t.counter = self.counter;
        t
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    vault_hash: String,
    tokens: Vec<PreviewToken>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}
pub fn preview_path(vault_path: &Path) -> PathBuf {
    vault_path.with_file_name("preview.encrypted")
}
fn vault_hash(path: &Path) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(|_| "无法读取令牌库")?)
    ))
}
pub fn read_key(value: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let raw = Zeroizing::new(STANDARD.decode(value).map_err(|_| "设备密钥无效")?);
    let mut key = Zeroizing::new([0u8; 32]);
    if raw.len() != 32 {
        return Err("设备密钥无效".into());
    }
    key.copy_from_slice(&raw);
    Ok(key)
}
pub fn new_key() -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(key.as_mut());
    key
}
pub fn save_preview(path: &Path, tokens: &[Token], key: &[u8; 32]) -> Result<(), String> {
    let snapshot = Snapshot {
        vault_hash: vault_hash(path)?,
        tokens: tokens.iter().map(PreviewToken::from).collect(),
    };
    let plain = Zeroizing::new(serde_json::to_vec(&snapshot).map_err(|_| "无法生成预览")?);
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "预览密钥无效")?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: AAD,
            },
        )
        .map_err(|_| "无法加密预览")?;
    let bytes = serde_json::to_vec(&Envelope {
        version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(encrypted),
    })
    .map_err(|_| "无法保存预览")?;
    write_private(&preview_path(path), &bytes)
}
pub fn load_preview(path: &Path, key: &[u8; 32]) -> Result<Snapshot, String> {
    let bytes = fs::read(preview_path(path)).map_err(|_| "预览尚未就绪，请使用主密码解锁后重试")?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("预览过大".into());
    }
    let e: Envelope = serde_json::from_slice(&bytes).map_err(|_| "预览格式无效")?;
    let nonce = STANDARD.decode(e.nonce).map_err(|_| "预览格式无效")?;
    if e.version != 1 || nonce.len() != 12 {
        return Err("预览版本无效".into());
    }
    let ciphertext = STANDARD.decode(e.ciphertext).map_err(|_| "预览格式无效")?;
    let plain = Zeroizing::new(
        Aes256Gcm::new_from_slice(key)
            .map_err(|_| "预览密钥无效")?
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: AAD,
                },
            )
            .map_err(|_| "预览密钥已失效，请用主密码解锁")?,
    );
    let snapshot: Snapshot = serde_json::from_slice(&plain).map_err(|_| "预览内容无效")?;
    if snapshot.vault_hash != vault_hash(path)? {
        return Err("令牌库已更新，请使用主密码解锁以刷新预览".into());
    }
    for t in &snapshot.tokens {
        let mut token = t.token();
        let result = token.validate();
        token.erase();
        result?;
    }
    Ok(snapshot)
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(path.parent().ok_or("存储目录无效")?).map_err(|_| "无法创建存储目录")?;
    let tmp = path.with_extension("pending");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|_| "无法保存本机设置")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "本机设置写入失败")?;
    fs::rename(tmp, path).map_err(|_| "无法替换本机设置".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_is_read_only_minimal_encrypted_and_rejects_stale_vault() {
        let dir = std::env::temp_dir().join(format!("steamguard-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.sgvault");
        fs::write(&path, b"synthetic vault").unwrap();
        let mut token = Token::new("fixture".into(), "steam".into(), vec![1; 20]);
        token.identity_secret = Some("PRIVATE_CONFIRMATION_KEY".into());
        token.steam_data = Some(serde_json::json!({"revocation_code":"PRIVATE_RECOVERY_CODE"}));
        let key = new_key();
        save_preview(&path, &[token], &key).unwrap();
        let file = fs::read(preview_path(&path)).unwrap();
        assert!(!String::from_utf8_lossy(&file).contains("fixture"));
        let snapshot = load_preview(&path, &key).unwrap();
        let json = Zeroizing::new(serde_json::to_string(&snapshot).unwrap());
        assert!(
            !json.contains("PRIVATE_")
                && !json.contains("identitySecret")
                && !json.contains("steamData")
        );
        assert!(load_preview(&path, &[9; 32]).is_err());
        let q = QuickAccess::new(&dir);
        q.set("preview", true).unwrap();
        q.enter(snapshot).unwrap();
        let views = q.tokens(&path, 1_700_000_000).unwrap();
        assert_eq!(views.len(), 1);
        assert!(!views[0].logged_in && !views[0].has_identity_secret);
        fs::write(&path, b"new vault version").unwrap();
        assert!(q.tokens(&path, 1_700_000_000).is_err());
        assert!(!q.active());
        assert!(load_preview(&path, &key).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
