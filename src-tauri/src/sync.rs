//! End-to-end encrypted WebDAV sync. OpenDAL transports opaque checkpoints;
//! Automerge retains causal history and concurrent values. No Steam session is uploaded.
use crate::{models::Token, vault::VaultData};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use automerge::{transaction::Transactable, ActorId, AutoCommit, ReadDoc, ROOT};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use zeroize::{Zeroize, Zeroizing};

pub mod commands;
pub mod storage;
const MAX_DOCUMENT: usize = 16 * 1024 * 1024;
const MAX_KEYS: usize = 80_000;
const KDF: &str = "argon2id-v19-m19456-t2-p1";
const FORMAT: &str = "SteamGuard Sync";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    pub library: String,
    pub salt: String,
    pub key: String,
    pub device: String,
    pub doc: String,
    pub baseline: BTreeMap<String, String>,
    pub active: bool,
    pub uploaded_heads: String,
    pub last_success: u64,
}
impl Drop for State {
    fn drop(&mut self) {
        self.password.zeroize();
        self.key.zeroize();
        self.doc.zeroize();
        for v in self.baseline.values_mut() {
            v.zeroize();
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    format: String,
    version: u8,
    pub library: String,
    kdf: String,
    pub salt: String,
    check: Envelope,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}
fn aad(library: &str, purpose: &str) -> String {
    format!("SteamGuard Sync/v1/{library}/{purpose}")
}
fn seal(key: &[u8; 32], library: &str, purpose: &str, bytes: &[u8]) -> Result<Envelope, String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "同步密钥无效")?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: bytes,
                aad: aad(library, purpose).as_bytes(),
            },
        )
        .map_err(|_| "同步数据加密失败")?;
    Ok(Envelope {
        version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}
fn open(
    key: &[u8; 32],
    library: &str,
    purpose: &str,
    envelope: &Envelope,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| "同步文件随机数无效")?;
    if envelope.version != 1 || nonce.len() != 12 || envelope.ciphertext.len() > MAX_DOCUMENT * 2 {
        return Err("同步文件版本或大小无效".into());
    }
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| "同步文件格式无效")?;
    Ok(Zeroizing::new(
        Aes256Gcm::new_from_slice(key)
            .map_err(|_| "同步密钥无效")?
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad(library, purpose).as_bytes(),
                },
            )
            .map_err(|_| "同步密码错误，或云端文件已损坏")?,
    ))
}
fn derive(password: &str, salt: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let salt = STANDARD.decode(salt).map_err(|_| "同步库参数无效")?;
    if salt.len() != 16 {
        return Err("同步库参数无效".into());
    }
    let mut key = Zeroizing::new([0u8; 32]);
    argon2::Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, key.as_mut())
        .map_err(|_| "无法派生同步密钥")?;
    Ok(key)
}
pub fn create_header(
    library: &str,
    password: &str,
) -> Result<(Header, Zeroizing<[u8; 32]>), String> {
    if password.chars().count() < 12 {
        return Err("同步密码至少 12 个字符，请与网盘应用密码区分并妥善保管".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let salt = STANDARD.encode(salt);
    let key = derive(password, &salt)?;
    let check = seal(
        &key,
        library,
        "header",
        b"SteamGuard encrypted sync key verification",
    )?;
    Ok((
        Header {
            format: FORMAT.into(),
            version: 1,
            library: library.into(),
            kdf: KDF.into(),
            salt,
            check,
        },
        key,
    ))
}
pub fn join_header(
    bytes: &[u8],
    library: &str,
    password: &str,
) -> Result<(Header, Zeroizing<[u8; 32]>), String> {
    if bytes.len() > 16 * 1024 {
        return Err("同步库信息过大".into());
    }
    let header: Header = serde_json::from_slice(bytes).map_err(|_| "同步库格式无效")?;
    if header.format != FORMAT
        || header.version != 1
        || header.kdf != KDF
        || header.library != library
    {
        return Err("不支持的同步库版本或编号".into());
    }
    let key = derive(password, &header.salt)?;
    let plain = open(&key, library, "header", &header.check)?;
    if plain.as_slice() != b"SteamGuard encrypted sync key verification" {
        return Err("同步库校验失败".into());
    }
    Ok((header, key))
}
fn mac(key: &[u8; 32], domain: &str, value: &[u8]) -> String {
    let mut h = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("fixed HMAC key");
    h.update(domain.as_bytes());
    h.update(&[0]);
    h.update(value);
    format!("{:x}", h.finalize().into_bytes())
}
pub fn identity(key: &[u8; 32], token: &Token) -> String {
    mac(key, &token.kind, &token.secret)
}
fn pending(token: &Token) -> bool {
    token
        .steam_data
        .as_ref()
        .is_some_and(|v| v["steamguard_pending"].as_bool() == Some(true))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Core {
    kind: String,
    issuer: String,
    secret: Vec<u8>,
    algorithm: String,
    digits: u32,
    period: u64,
    steam_id: Option<String>,
    account_name: Option<String>,
    identity_secret: Option<String>,
    device_id: Option<String>,
    steam_data: Option<serde_json::Value>,
}
impl Drop for Core {
    fn drop(&mut self) {
        self.secret.zeroize();
        if let Some(v) = &mut self.identity_secret {
            v.zeroize();
        }
        if let Some(v) = &mut self.steam_data {
            crate::vault::wipe_json(v);
        }
    }
}
impl Core {
    fn from(t: &Token) -> Self {
        let mut fields = serde_json::Map::new();
        if let Some(data) = &t.steam_data {
            for key in [
                "serial_number",
                "revocation_code",
                "token_gid",
                "steamguard_pending",
                "serial",
            ] {
                if let Some(v) = data.get(key) {
                    fields.insert(key.into(), v.clone());
                }
            }
        }
        Self {
            kind: t.kind.clone(),
            issuer: t.issuer.clone(),
            secret: t.secret.clone(),
            algorithm: t.algorithm.clone(),
            digits: t.digits,
            period: t.period,
            steam_id: t.steam_id.clone(),
            account_name: t.account_name.clone(),
            identity_secret: t.identity_secret.clone(),
            device_id: t.device_id.clone(),
            steam_data: if fields.is_empty() {
                None
            } else {
                Some(fields.into())
            },
        }
    }
    fn token(&self) -> Token {
        let mut t = Token::new(String::new(), self.kind.clone(), self.secret.clone());
        t.issuer = self.issuer.clone();
        t.algorithm = self.algorithm.clone();
        t.digits = self.digits;
        t.period = self.period;
        t.steam_id = self.steam_id.clone();
        t.account_name = self.account_name.clone();
        t.identity_secret = self.identity_secret.clone();
        t.device_id = self.device_id.clone();
        t.steam_data = self.steam_data.clone();
        t
    }
}
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "无法编码同步数据".into())
}
fn values(doc: &AutoCommit, key: &str) -> Result<Vec<(String, String)>, String> {
    let items = doc.get_all(ROOT, key).map_err(|_| "无法读取同步版本")?;
    let mut seen = BTreeSet::new();
    let mut out = vec![];
    for (value, id) in items {
        let value = value.as_str().ok_or("同步字段类型无效")?.to_owned();
        if seen.insert(value.clone()) {
            out.push((id.to_string(), value));
        }
    }
    Ok(out)
}
fn one(doc: &AutoCommit, key: &str) -> Result<Option<String>, String> {
    let v = values(doc, key)?;
    Ok(if v.len() == 1 {
        Some(v[0].1.clone())
    } else {
        None
    })
}
fn put(doc: &mut AutoCommit, key: &str, value: &str) -> Result<(), String> {
    doc.put(ROOT, key, value)
        .map_err(|_| "无法记录同步变更".into())
}
fn group_key(key: &[u8; 32], name: &str) -> String {
    format!("g/{}", mac(key, "group", name.as_bytes()))
}
fn load(state: &State, actor: &str) -> Result<AutoCommit, String> {
    let bytes = Zeroizing::new(
        STANDARD
            .decode(&state.doc)
            .map_err(|_| "本机同步记录无效")?,
    );
    let mut doc = if bytes.is_empty() {
        AutoCommit::new()
    } else {
        AutoCommit::load(&bytes).map_err(|_| "本机同步历史已损坏")?
    };
    doc.set_actor(ActorId::from(actor.as_bytes()));
    Ok(doc)
}
fn heads(doc: &mut AutoCommit) -> String {
    let mut changes = doc.get_heads();
    changes.sort();
    format!(
        "{:x}",
        Sha256::digest(changes.iter().flat_map(|h| h.0).collect::<Vec<_>>())
    )
}

fn project(
    data: &VaultData,
    state: &State,
    doc: &AutoCommit,
    key: &[u8; 32],
) -> Result<BTreeMap<String, String>, String> {
    let mut current = BTreeMap::new();
    for group in data.group_names() {
        current.insert(group_key(key, &group), json(&Some(group))?);
    }
    for token in &data.tokens {
        if pending(token) {
            continue;
        }
        let prefix = format!("t/{}/", identity(key, token));
        current.insert(format!("{prefix}alive"), "true".into());
        current.insert(format!("{prefix}core"), json(&Core::from(token))?);
        current.insert(format!("{prefix}name"), json(&token.name)?);
        current.insert(format!("{prefix}group"), json(&token.group)?);
        current.insert(format!("{prefix}counter"), json(&token.counter)?);
        if token.kind == "hotp" {
            let owner = one(doc, &format!("{prefix}owner"))?.unwrap_or(json(&state.device)?);
            current.insert(format!("{prefix}owner"), owner);
        }
    }
    Ok(current)
}
pub fn record_local(data: &mut VaultData, actor: &str) -> Result<(), String> {
    let Some(mut state) = data.sync.take() else {
        return Ok(());
    };
    let result = (|| {
        let key = crate::quick_access::read_key(&state.key)?;
        let mut doc = load(&state, actor)?;
        let current = project(data, &state, &doc, &key)?;
        for (key, value) in &current {
            if state.baseline.get(key) != Some(value) {
                put(&mut doc, key, value)?;
            }
        }
        for key in state.baseline.keys().filter(|k| !current.contains_key(*k)) {
            if key.starts_with("g/") {
                put(&mut doc, key, "null")?;
            } else if key.ends_with("/alive") {
                put(&mut doc, key, "false")?;
            }
        }
        state.baseline = current;
        state.doc = STANDARD.encode(doc.save());
        Ok(())
    })();
    data.sync = Some(state);
    result
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub local: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub name: String,
    pub field: String,
    pub choices: Vec<Choice>,
}
fn safe_label(field: &str, value: &str) -> String {
    match field {
        "alive" => {
            if value == "true" {
                "保留令牌".into()
            } else {
                "删除令牌".into()
            }
        }
        "core" => serde_json::from_str::<Core>(value)
            .map(|c| {
                format!(
                    "{} · SteamID {}",
                    c.kind,
                    c.steam_id
                        .as_deref()
                        .unwrap_or("未关联")
                        .chars()
                        .rev()
                        .take(6)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )
            })
            .unwrap_or_else(|_| "无效令牌版本".into()),
        "counter" => "计数版本".into(),
        "owner" => "HOTP 主设备版本".into(),
        _ => serde_json::from_str::<Option<String>>(value)
            .ok()
            .flatten()
            .unwrap_or_else(|| "未分组 / 删除分组".into()),
    }
}
fn inspect(doc: &AutoCommit, baseline: &BTreeMap<String, String>) -> Result<Vec<Conflict>, String> {
    let mut conflicts = vec![];
    for key in doc.keys(ROOT) {
        let field = key.rsplit('/').next().unwrap_or("");
        if field == "counter" {
            continue;
        }
        if key.starts_with("t/") && field != "alive" {
            let prefix = key.rsplit_once('/').ok_or("同步字段无效")?.0;
            if one(doc, &format!("{prefix}/alive"))?.as_deref() == Some("false") {
                continue;
            }
        }
        let variants = values(doc, &key)?;
        if variants.len() > 1 {
            let name = if key.starts_with("t/") {
                let prefix = key.rsplit_once('/').unwrap().0;
                one(doc, &format!("{prefix}/name"))?
                    .and_then(|s| serde_json::from_str::<String>(&s).ok())
                    .unwrap_or_else(|| "令牌".into())
            } else {
                "分组".into()
            };
            let label = if key.starts_with("g/") {
                "分组状态"
            } else {
                match field {
                    "name" => "显示名称",
                    "group" => "所属分组",
                    "core" => "令牌数据",
                    "alive" => "保留或删除",
                    "owner" => "HOTP 主设备",
                    _ => return Err("同步字段无效".into()),
                }
            };
            conflicts.push(Conflict {
                id: key.clone(),
                name,
                field: label.into(),
                choices: variants
                    .into_iter()
                    .map(|(id, v)| Choice {
                        id,
                        label: safe_label(field, &v),
                        local: baseline.get(&key) == Some(&v),
                    })
                    .collect(),
            });
        }
    }
    Ok(conflicts)
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && (!b.is_ascii_alphabetic() || b.is_ascii_lowercase()))
}
fn validate_document(doc: &AutoCommit) -> Result<(), String> {
    if doc.keys(ROOT).count() > MAX_KEYS {
        return Err("同步库记录过多".into());
    }
    for key in doc.keys(ROOT) {
        let parts = key.split('/').collect::<Vec<_>>();
        if !(parts.len() == 2 && parts[0] == "g" && valid_id(parts[1])
            || parts.len() == 3
                && parts[0] == "t"
                && valid_id(parts[1])
                && ["alive", "core", "name", "group", "counter", "owner"].contains(&parts[2]))
        {
            return Err("同步库含不支持的字段".into());
        }
        for (_, value) in values(doc, &key)? {
            if value.len() > 128 * 1024 {
                return Err("同步记录过大".into());
            }
        }
    }
    Ok(())
}
/// Apply only conflict-free token records. Conflicting records remain in the local view.
fn materialize(
    data: &mut VaultData,
    state: &mut State,
    doc: &mut AutoCommit,
) -> Result<Vec<String>, String> {
    validate_document(doc)?;
    let key = crate::quick_access::read_key(&state.key)?;
    let conflicts = inspect(doc, &state.baseline)?;
    let blocked = conflicts
        .iter()
        .map(|c| {
            c.id.rsplit_once('/')
                .map(|p| p.0)
                .unwrap_or(&c.id)
                .to_owned()
        })
        .collect::<BTreeSet<_>>();
    let mut groups = vec![];
    let mut deleted_groups = BTreeSet::new();
    for property in doc
        .keys(ROOT)
        .filter(|k| k.starts_with("g/"))
        .collect::<Vec<_>>()
    {
        if let Some(v) = one(doc, &property)? {
            let name: Option<String> = serde_json::from_str(&v).map_err(|_| "同步分组格式无效")?;
            if let Some(name) = name {
                if group_key(&key, &name) != property
                    || name.trim() != name
                    || name.is_empty()
                    || name.chars().count() > 40
                {
                    return Err("同步分组校验失败".into());
                }
                if !groups.contains(&name) {
                    groups.push(name);
                }
            } else {
                deleted_groups.insert(property);
            }
        } else {
            for name in data.group_names() {
                if group_key(&key, &name) == property && !groups.contains(&name) {
                    groups.push(name);
                }
            }
        }
    }
    let mut current = BTreeMap::new();
    let mut result = vec![];
    for token in &data.tokens {
        if pending(token) {
            result.push(token.clone());
        } else {
            current.insert(identity(&key, token), token.clone());
        }
    }
    let ids = doc
        .keys(ROOT)
        .filter_map(|k| {
            k.strip_prefix("t/")
                .and_then(|p| p.split_once('/'))
                .map(|p| p.0.to_owned())
        })
        .collect::<BTreeSet<_>>();
    let mut logout = vec![];
    for id in ids {
        let prefix = format!("t/{id}");
        if blocked.contains(&prefix) {
            if let Some(t) = current.remove(&id) {
                result.push(t);
            }
            continue;
        }
        let alive = one(doc, &format!("{prefix}/alive"))?.ok_or("同步令牌缺少状态")?;
        if alive == "false" {
            if let Some(mut old) = current.remove(&id) {
                logout.push(old.id.clone());
                old.erase();
            }
            continue;
        }
        if alive != "true" {
            return Err("同步令牌状态无效".into());
        }
        let core: Core = serde_json::from_str(
            &one(doc, &format!("{prefix}/core"))?.ok_or("同步令牌数据不完整")?,
        )
        .map_err(|_| "同步令牌数据无效")?;
        let mut token = core.token();
        token.name =
            serde_json::from_str(&one(doc, &format!("{prefix}/name"))?.ok_or("同步令牌名称缺失")?)
                .map_err(|_| "同步名称无效")?;
        token.group =
            serde_json::from_str(&one(doc, &format!("{prefix}/group"))?.ok_or("同步分组缺失")?)
                .map_err(|_| "同步分组无效")?;
        token.counter = values(doc, &format!("{prefix}/counter"))?
            .iter()
            .map(|(_, v)| v.parse::<u64>().map_err(|_| "同步计数无效"))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(0);
        if identity(&key, &token) != id || token.name.is_empty() || token.name.chars().count() > 120
        {
            token.erase();
            return Err("同步令牌身份校验失败".into());
        }
        token.validate()?;
        if let Some(group) = &token.group {
            if deleted_groups.contains(&group_key(&key, group)) {
                token.group = None;
                put(doc, &format!("{prefix}/group"), "null")?;
            }
        }
        if let Some(mut old) = current.remove(&id) {
            token.id = old.id.clone();
            if old.steam_id != token.steam_id
                || old.identity_secret != token.identity_secret
                || old.device_id != token.device_id
            {
                logout.push(old.id.clone());
            }
            old.erase();
        }
        token.hotp_read_only = token.kind == "hotp"
            && one(doc, &format!("{prefix}/owner"))?
                .and_then(|v| serde_json::from_str::<String>(&v).ok())
                .as_deref()
                != Some(state.device.as_str());
        result.push(token);
    }
    // Local-only pending enrollment is preserved. Non-pending records must have
    // been captured by record_local before merging; refusing avoids silent loss.
    if !current.is_empty() {
        for t in current.values_mut() {
            t.erase();
        }
        return Err("本机令牌尚未记录到同步历史，请重试".into());
    }
    for t in &mut result {
        t.hotp_read_only = t.kind == "hotp"
            && one(doc, &format!("t/{}/owner", identity(&key, t)))?
                .and_then(|v| serde_json::from_str::<String>(&v).ok())
                .as_deref()
                != Some(state.device.as_str());
    }
    let mut seen_steam = BTreeMap::new();
    for token in &result {
        if token.kind == "steam" {
            if let Some(id) = crate::models::known_steam_id(token.steam_id.as_deref()) {
                if let Some(previous) = seen_steam.insert(id, identity(&key, token)) {
                    if previous != identity(&key, token) {
                        return Err(
                            "同步中出现同一 Steam 账号的不同令牌，请在原设备删除已失效令牌后重试"
                                .into(),
                        );
                    }
                }
            }
        }
    }
    for token in &mut data.tokens {
        token.erase();
    }
    data.tokens = result;
    data.groups = groups;
    if let Some(sessions) = data.sessions.as_object_mut() {
        for id in &logout {
            if let Some(mut value) = sessions.remove(id) {
                crate::vault::wipe_json(&mut value);
            }
        }
        sessions.retain(|id, _| data.tokens.iter().any(|t| &t.id == id));
    }
    data.validate()?;
    state.baseline = project(data, state, doc, &key)?;
    state.doc = STANDARD.encode(doc.save());
    Ok(logout)
}
impl State {
    pub fn new(
        endpoint: String,
        username: String,
        password: String,
        header: &Header,
        key: &[u8; 32],
        device: String,
    ) -> Self {
        Self {
            endpoint,
            username,
            password,
            library: header.library.clone(),
            salt: header.salt.clone(),
            key: STANDARD.encode(key),
            device,
            doc: String::new(),
            baseline: BTreeMap::new(),
            active: true,
            uploaded_heads: String::new(),
            last_success: 0,
        }
    }
    pub fn verify_header(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 16384 {
            return Err("同步库信息过大".into());
        }
        let header: Header = serde_json::from_slice(bytes).map_err(|_| "同步库信息无效")?;
        if header.format != FORMAT
            || header.version != 1
            || header.kdf != KDF
            || header.library != self.library
            || header.salt != self.salt
        {
            return Err("同步库参数已变化，请重新连接".into());
        }
        let key = crate::quick_access::read_key(&self.key)?;
        let plain = open(&key, &self.library, "header", &header.check)?;
        if plain.as_slice() != b"SteamGuard encrypted sync key verification" {
            return Err("同步库校验失败".into());
        }
        Ok(())
    }
    pub fn head_hash(&self, actor: &str) -> Result<String, String> {
        Ok(heads(&mut load(self, actor)?))
    }
    pub fn conflicts(&self) -> Result<Vec<Conflict>, String> {
        let doc = load(self, "read-only")?;
        inspect(&doc, &self.baseline)
    }
    pub fn dirty(&self) -> Result<bool, String> {
        let mut doc = load(self, "read-only")?;
        Ok(heads(&mut doc) != self.uploaded_heads)
    }
    pub fn checkpoint(&self, actor: &str) -> Result<Vec<u8>, String> {
        let key = crate::quick_access::read_key(&self.key)?;
        let mut doc = load(self, actor)?;
        let bytes = Zeroizing::new(doc.save());
        if bytes.len() > MAX_DOCUMENT {
            return Err("同步文档过大".into());
        }
        serde_json::to_vec(&seal(&key, &self.library, "state", &bytes)?)
            .map_err(|_| "无法编码加密同步文件".into())
    }
    pub fn merge_bytes(&mut self, bytes: &[u8], actor: &str) -> Result<(), String> {
        if bytes.len() > MAX_DOCUMENT * 2 {
            return Err("云端同步文件过大".into());
        }
        let envelope: Envelope =
            serde_json::from_slice(bytes).map_err(|_| "云端文件不是有效同步文件")?;
        let key = crate::quick_access::read_key(&self.key)?;
        let plain = open(&key, &self.library, "state", &envelope)?;
        if plain.len() > MAX_DOCUMENT {
            return Err("同步文档过大".into());
        }
        let mut remote = AutoCommit::load(&plain).map_err(|_| "云端同步历史已损坏")?;
        validate_document(&remote)?;
        let mut local = load(self, actor)?;
        local.merge(&mut remote).map_err(|_| "无法合并同步历史")?;
        self.doc = STANDARD.encode(local.save());
        Ok(())
    }
}
pub fn apply(data: &mut VaultData, actor: &str) -> Result<Vec<String>, String> {
    let Some(mut state) = data.sync.take() else {
        return Err("尚未连接同步库".into());
    };
    let mut doc = load(&state, actor)?;
    let result = materialize(data, &mut state, &mut doc);
    data.sync = Some(state);
    result
}
pub fn resolve(
    data: &mut VaultData,
    actor: &str,
    id: &str,
    choice: &str,
) -> Result<Vec<String>, String> {
    let state = data.sync.as_mut().ok_or("尚未连接同步库")?;
    let mut doc = load(state, actor)?;
    if !inspect(&doc, &state.baseline)?.iter().any(|c| c.id == id) {
        return Err("冲突已变化，请刷新".into());
    }
    let value = values(&doc, id)?
        .into_iter()
        .find(|(op, _)| op == choice)
        .ok_or("所选版本已变化")?
        .1;
    put(&mut doc, id, &value)?;
    state.doc = STANDARD.encode(doc.save());
    apply(data, actor)
}
pub fn hotp_allowed(data: &VaultData, token: &Token, device: &str) -> bool {
    if token.kind != "hotp" {
        return true;
    }
    let Some(state) = &data.sync else { return true };
    let Ok(key) = crate::quick_access::read_key(&state.key) else {
        return false;
    };
    let Ok(doc) = load(state, "read-only") else {
        return false;
    };
    one(&doc, &format!("t/{}/owner", identity(&key, token)))
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<String>(&v).ok())
        .as_deref()
        == Some(device)
}
pub fn claim_hotp(
    data: &mut VaultData,
    actor: &str,
    token_id: &str,
    device: &str,
) -> Result<(), String> {
    let token = data
        .tokens
        .iter()
        .find(|t| t.id == token_id && t.kind == "hotp")
        .ok_or("HOTP 令牌不存在")?;
    let state = data.sync.as_mut().ok_or("尚未连接同步库")?;
    let key = crate::quick_access::read_key(&state.key)?;
    let mut doc = load(state, actor)?;
    put(
        &mut doc,
        &format!("t/{}/owner", identity(&key, token)),
        &json(&device)?,
    )?;
    state.doc = STANDARD.encode(doc.save());
    Ok(())
}
#[derive(Default)]
pub struct Controller {
    busy: AtomicBool,
    token: Mutex<Option<tokio_util::sync::CancellationToken>>,
    pub result: Mutex<(u64, Option<String>)>,
}
pub struct Lease<'a> {
    owner: &'a Controller,
    pub cancellation: tokio_util::sync::CancellationToken,
}
impl Controller {
    pub fn begin(&self) -> Result<Lease<'_>, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("正在同步，请稍候".into());
        }
        let token = tokio_util::sync::CancellationToken::new();
        *self.token.lock().map_err(|_| "同步状态不可用")? = Some(token.clone());
        Ok(Lease {
            owner: self,
            cancellation: token,
        })
    }
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        if let Ok(t) = self.token.lock() {
            if let Some(t) = t.as_ref() {
                t.cancel();
            }
        }
    }
    pub fn finish(&self, result: &Result<(), String>) {
        if let Ok(mut status) = self.result.lock() {
            match result {
                Ok(()) => *status = (crate::models::now(), None),
                Err(e) => status.1 = Some(e.clone()),
            }
        }
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut token) = self.owner.token.lock() {
            *token = None;
        }
        self.owner.busy.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(device: &str) -> State {
        State::new(
            "https://example.invalid/dav/".into(),
            "fixture".into(),
            "synthetic-app-password".into(),
            &Header {
                format: FORMAT.into(),
                version: 1,
                library: "2971a71b-042c-4f28-b8ae-3c02b713f0f0".into(),
                kdf: KDF.into(),
                salt: STANDARD.encode([1u8; 16]),
                check: Envelope {
                    version: 1,
                    nonce: String::new(),
                    ciphertext: String::new(),
                },
            },
            &[42u8; 32],
            device.into(),
        )
    }
    fn first() -> VaultData {
        let mut token = Token::new(
            "Original".into(),
            "totp".into(),
            b"synthetic-secret-only".to_vec(),
        );
        token.issuer = "Example".into();
        let mut d = VaultData {
            tokens: vec![token],
            sync: Some(config("device-a")),
            ..Default::default()
        };
        record_local(&mut d, "actor-a").unwrap();
        d
    }
    fn copy(a: &VaultData) -> VaultData {
        let mut d = VaultData {
            sync: Some(config("device-b")),
            ..Default::default()
        };
        receive(a, &mut d, "actor-b");
        d
    }
    fn receive(a: &VaultData, b: &mut VaultData, actor: &str) {
        let bytes = a.sync.as_ref().unwrap().checkpoint("sender").unwrap();
        b.sync.as_mut().unwrap().merge_bytes(&bytes, actor).unwrap();
        apply(b, actor).unwrap();
    }
    #[test]
    fn independent_offline_edits_merge_and_preserve_local_ids() {
        let mut a = first();
        let mut b = copy(&a);
        let id = b.tokens[0].id.clone();
        a.tokens[0].name = "Renamed".into();
        record_local(&mut a, "actor-a").unwrap();
        b.groups.push("Work".into());
        b.tokens[0].group = Some("Work".into());
        record_local(&mut b, "actor-b").unwrap();
        receive(&a, &mut b, "actor-b");
        receive(&b, &mut a, "actor-a");
        assert!(a.sync.as_ref().unwrap().conflicts().unwrap().is_empty());
        assert_eq!(b.tokens[0].id, id);
        assert_eq!(a.tokens[0].name, "Renamed");
        assert_eq!(a.tokens[0].group.as_deref(), Some("Work"));
        assert_eq!(a.tokens[0].issuer, "Example");
    }
    #[test]
    fn same_field_conflict_requires_explicit_choice_then_converges() {
        let mut a = first();
        let mut b = copy(&a);
        a.tokens[0].name = "Name A".into();
        b.tokens[0].name = "Name B".into();
        record_local(&mut a, "actor-a").unwrap();
        record_local(&mut b, "actor-b").unwrap();
        receive(&a, &mut b, "actor-b");
        let conflicts = b.sync.as_ref().unwrap().conflicts().unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(b.tokens[0].name, "Name B");
        record_local(&mut b, "actor-b").unwrap();
        assert_eq!(b.sync.as_ref().unwrap().conflicts().unwrap().len(), 1);
        let c = &conflicts[0];
        let choice = c.choices.iter().find(|c| c.label == "Name A").unwrap();
        resolve(&mut b, "actor-b", &c.id, &choice.id).unwrap();
        receive(&b, &mut a, "actor-a");
        assert_eq!(a.tokens[0].name, "Name A");
        assert!(a.sync.as_ref().unwrap().conflicts().unwrap().is_empty());
    }
    #[test]
    fn deletion_survives_offline_rename_without_resurrecting_token() {
        let mut a = first();
        let mut b = copy(&a);
        a.tokens.clear();
        record_local(&mut a, "actor-a").unwrap();
        b.tokens[0].name = "Offline edit".into();
        record_local(&mut b, "actor-b").unwrap();
        receive(&a, &mut b, "actor-b");
        receive(&b, &mut a, "actor-a");
        assert!(a.tokens.is_empty() && b.tokens.is_empty());
        assert!(a.sync.as_ref().unwrap().conflicts().unwrap().is_empty());
    }
    #[test]
    fn identical_concurrent_values_are_not_conflicts_and_empty_groups_sync() {
        let mut a = first();
        let mut b = copy(&a);
        for (d, actor) in [(&mut a, "actor-a"), (&mut b, "actor-b")] {
            d.tokens[0].name = "Same".into();
            d.groups.push("Empty".into());
            record_local(d, actor).unwrap();
        }
        receive(&a, &mut b, "actor-b");
        assert_eq!(b.groups, vec!["Empty"]);
        assert!(b.sync.as_ref().unwrap().conflicts().unwrap().is_empty());
    }
    #[test]
    fn deleted_group_clears_concurrent_stale_assignment() {
        let mut a = first();
        a.groups.push("Old".into());
        record_local(&mut a, "actor-a").unwrap();
        let mut b = copy(&a);
        a.manage_group("delete", "Old", None).unwrap();
        record_local(&mut a, "actor-a").unwrap();
        b.tokens[0].group = Some("Old".into());
        record_local(&mut b, "actor-b").unwrap();
        receive(&a, &mut b, "actor-b");
        receive(&b, &mut a, "actor-a");
        assert!(a.tokens[0].group.is_none() && b.tokens[0].group.is_none());
        assert!(a.groups.is_empty());
    }
    #[test]
    fn steam_session_and_unrecognized_import_fields_never_enter_sync_document() {
        let mut a = first();
        a.tokens[0].steam_data = Some(
            serde_json::json!({"Session":{"AccessToken":"private-import-jwt"},"access_token":"private-access-jwt","revocation_code":"R-SYNTHETIC"}),
        );
        a.sessions = serde_json::json!({"private-session":"not-for-cloud"});
        record_local(&mut a, "actor-a").unwrap();
        let d = load(a.sync.as_ref().unwrap(), "reader").unwrap();
        let plain = d
            .keys(ROOT)
            .flat_map(|k| values(&d, &k).unwrap().into_iter().map(|v| v.1))
            .collect::<String>();
        for forbidden in [
            "private-import-jwt",
            "private-access-jwt",
            "not-for-cloud",
            "synthetic-app-password",
        ] {
            assert!(!plain.contains(forbidden));
        }
        assert!(plain.contains("R-SYNTHETIC"));
        let bytes = a.sync.as_ref().unwrap().checkpoint("reader").unwrap();
        let cloud = String::from_utf8(bytes).unwrap();
        assert!(!cloud.contains("Original"));
        assert!(!cloud.contains("R-SYNTHETIC"));
    }
    #[test]
    fn encrypted_checkpoints_reject_tampering_wrong_key_and_cross_library_replay() {
        let a = first();
        let bytes = a.sync.as_ref().unwrap().checkpoint("reader").unwrap();
        let mut b = config("device-b");
        b.key = STANDARD.encode([43u8; 32]);
        assert!(b.merge_bytes(&bytes, "b").is_err());
        b = config("device-b");
        b.library = uuid::Uuid::new_v4().to_string();
        assert!(b.merge_bytes(&bytes, "b").is_err());
        let mut env: Envelope = serde_json::from_slice(&bytes).unwrap();
        let mut cipher = STANDARD.decode(&env.ciphertext).unwrap();
        cipher[0] ^= 1;
        env.ciphertext = STANDARD.encode(cipher);
        assert!(config("device-b")
            .merge_bytes(&serde_json::to_vec(&env).unwrap(), "b")
            .is_err());
    }
    #[test]
    fn sync_password_verifies_header_and_short_creation_password_is_rejected() {
        assert!(create_header("fixture", "short").is_err());
        let (header, _) = create_header("fixture", "synthetic-sync-password").unwrap();
        let bytes = serde_json::to_vec(&header).unwrap();
        assert!(join_header(&bytes, "fixture", "wrong-password").is_err());
        assert!(join_header(&bytes, "fixture", "synthetic-sync-password").is_ok());
    }
    #[test]
    fn hotp_secondary_is_readonly_and_primary_claim_does_not_reset_counter() {
        let mut a = first();
        a.tokens[0].kind = "hotp".into();
        a.tokens[0].counter = 27;
        record_local(&mut a, "actor-a").unwrap();
        apply(&mut a, "actor-a").unwrap();
        let mut b = copy(&a);
        assert!(hotp_allowed(&a, &a.tokens[0], "device-a"));
        assert!(!hotp_allowed(&b, &b.tokens[0], "device-b"));
        assert!(b.tokens[0].hotp_read_only);
        let id = b.tokens[0].id.clone();
        claim_hotp(&mut b, "actor-b", &id, "device-b").unwrap();
        apply(&mut b, "actor-b").unwrap();
        receive(&b, &mut a, "actor-a");
        assert_eq!(b.tokens[0].counter, 27);
        assert!(!b.tokens[0].hotp_read_only);
        assert!(!hotp_allowed(&a, &a.tokens[0], "device-a"));
    }
    #[test]
    fn locked_sync_controller_cancels_current_lease_and_allows_retry() {
        let controller = Controller::default();
        let lease = controller.begin().unwrap();
        assert!(controller.begin().is_err());
        controller.cancel();
        assert!(lease.cancellation.is_cancelled());
        drop(lease);
        assert!(controller.begin().is_ok());
    }
}
