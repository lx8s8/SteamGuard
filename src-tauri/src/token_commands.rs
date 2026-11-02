//! Token mutations are committed as one encrypted vault transaction.
use crate::{
    models::{self, Token},
    otp,
    quick_access::QuickAccess,
    vault::{TrashEntry, VaultData},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    name: String,
    #[serde(default)]
    issuer: String,
    secret: String,
    kind: String,
    algorithm: Option<String>,
    digits: Option<u32>,
    period: Option<u64>,
    counter: Option<u64>,
    group: Option<String>,
    #[serde(default)]
    pinned: bool,
}
impl Drop for CreateInput {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.secret.zeroize();
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameters {
    issuer: Option<String>,
    algorithm: Option<String>,
    digits: Option<u32>,
    period: Option<u64>,
    counter: Option<u64>,
    pinned: Option<bool>,
}
impl Parameters {
    pub fn apply(&self, token: &mut Token) -> Result<(), String> {
        if !["totp", "hotp"].contains(&token.kind.as_str())
            && (self.issuer.is_some()
                || self.algorithm.is_some()
                || self.digits.is_some()
                || self.period.is_some()
                || self.counter.is_some())
        {
            return Err("此令牌类型不支持修改高级参数".into());
        }
        if let Some(issuer) = &self.issuer {
            if issuer.chars().count() > 120 {
                return Err("发行方最多 120 个字符".into());
            }
            token.issuer = issuer.trim().into();
        }
        if let Some(value) = &self.algorithm {
            token.algorithm = value.clone();
        }
        if let Some(value) = self.digits {
            token.digits = value;
        }
        if let Some(value) = self.period {
            token.period = value;
        }
        if let Some(value) = self.counter {
            if token.kind != "hotp" {
                return Err("只有 HOTP 令牌可修改计数".into());
            }
            if token.hotp_read_only {
                return Err("此 HOTP 由另一设备递增，请先切换主设备".into());
            }
            if value < token.counter {
                return Err("HOTP 计数不能倒退".into());
            }
            token.counter = value;
        }
        if let Some(value) = self.pinned {
            token.pinned = value;
        }
        token.validate()
    }
}
pub fn create(data: &mut VaultData, input: &CreateInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("名称需为 1–120 个字符".into());
    }
    if !["totp", "hotp"].contains(&input.kind.as_str()) {
        return Err("手动新增仅支持 TOTP 或 HOTP".into());
    }
    if input
        .group
        .as_ref()
        .is_some_and(|g| !data.group_names().contains(g))
    {
        return Err("分组不存在".into());
    }
    let secret = Zeroizing::new(
        input
            .secret
            .chars()
            .filter(|c| !c.is_ascii_whitespace() && *c != '-')
            .collect::<String>()
            .trim_end_matches('=')
            .to_ascii_uppercase(),
    );
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .map_err(|_| "密钥必须是有效 Base32 字符串")?;
    let mut token = Token::new(name.into(), input.kind.clone(), secret);
    Parameters {
        issuer: Some(input.issuer.clone()),
        algorithm: input.algorithm.clone(),
        digits: input.digits,
        period: input.period,
        counter: input.counter,
        pinned: Some(input.pinned),
    }
    .apply(&mut token)
    .map_err(|error| {
        token.erase();
        error
    })?;
    token.group = input.group.clone();
    if data
        .tokens
        .iter()
        .any(|t| t.kind == token.kind && t.secret == token.secret)
    {
        token.erase();
        return Err("相同密钥的令牌已存在".into());
    }
    token.sort_order = data
        .tokens
        .iter()
        .map(|t| t.sort_order)
        .max()
        .unwrap_or(0)
        .saturating_add(1024);
    let id = token.id.clone();
    data.tokens.push(token);
    Ok(id)
}
#[tauri::command]
pub fn token_create(s: State<AppState>, input: CreateInput) -> Result<String, String> {
    s.vault()?.update(|d| create(d, &input))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub id: String,
    pub code: String,
    pub remaining: u64,
    pub period: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentCode {
    code: String,
    remaining: u64,
    period: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnapshot {
    pub revision: String,
    pub codes: Vec<Code>,
}
pub fn codes(s: &AppState, q: &QuickAccess) -> Result<CodeSnapshot, String> {
    let mut v = s.vault()?;
    let now = s.timestamp();
    if v.data.is_some() {
        let revision = v.revision.clone();
        let codes = v
            .ensure()?
            .tokens
            .iter()
            .map(|t| {
                Ok(Code {
                    id: t.id.clone(),
                    code: if t.hotp_read_only {
                        String::new()
                    } else {
                        otp::code(t, now)?
                    },
                    period: t.period,
                    remaining: if t.kind == "hotp" {
                        0
                    } else {
                        t.period - now % t.period
                    },
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(CodeSnapshot { revision, codes });
    }
    let path = v.path.clone();
    drop(v);
    q.codes(&path, now)
}
#[tauri::command]
pub fn token_codes(s: State<AppState>, q: State<QuickAccess>) -> Result<CodeSnapshot, String> {
    codes(&s, &q)
}
#[tauri::command]
pub fn token_current_code(
    s: State<AppState>,
    q: State<QuickAccess>,
    id: String,
) -> Result<CurrentCode, String> {
    let value = codes(&s, &q)?
        .codes
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("令牌不存在")?;
    if value.code.is_empty() {
        return Err("此 HOTP 由另一设备递增，请先切换主设备".into());
    }
    Ok(CurrentCode {
        code: value.code,
        remaining: value.remaining,
        period: value.period,
    })
}
fn validate_ids(data: &VaultData, ids: &[String], trash: bool) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 1000 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err("请选择有效且不重复的令牌".into());
    }
    if ids.iter().any(|id| {
        if trash {
            !data.trash.iter().any(|t| &t.token.id == id)
        } else {
            !data.tokens.iter().any(|t| &t.id == id)
        }
    }) {
        return Err("部分令牌已不存在，请刷新后重试".into());
    }
    Ok(())
}
pub fn delete(data: &mut VaultData, ids: &[String]) -> Result<usize, String> {
    validate_ids(data, ids, false)?;
    let mut kept = Vec::new();
    for token in data.tokens.drain(..) {
        if ids.contains(&token.id) {
            data.trash.retain(|entry| entry.token.id != token.id);
            data.trash.push(TrashEntry {
                token,
                deleted_at: models::now(),
            });
        } else {
            kept.push(token);
        }
    }
    data.tokens = kept;
    if let Some(sessions) = data.sessions.as_object_mut() {
        for id in ids {
            if let Some(mut value) = sessions.remove(id) {
                crate::vault::wipe_json(&mut value);
            }
        }
    }
    Ok(ids.len())
}
#[tauri::command]
pub fn token_batch(
    s: State<AppState>,
    action: String,
    ids: Vec<String>,
    group: Option<String>,
    pinned: Option<bool>,
) -> Result<usize, String> {
    let count = s.vault()?.update(|d| {
        validate_ids(d, &ids, false)?;
        match action.as_str() {
            "delete" => delete(d, &ids),
            "pin" => {
                let pinned = pinned.ok_or("请指定置顶状态")?;
                for t in d.tokens.iter_mut().filter(|t| ids.contains(&t.id)) {
                    t.pinned = pinned;
                }
                Ok(ids.len())
            }
            "group" => {
                if group.as_ref().is_some_and(|g| !d.group_names().contains(g)) {
                    return Err("分组不存在".into());
                }
                for t in d.tokens.iter_mut().filter(|t| ids.contains(&t.id)) {
                    t.group = group.clone();
                }
                Ok(ids.len())
            }
            _ => Err("批量操作无效".into()),
        }
    })?;
    if action == "delete" {
        for id in ids {
            s.steam.logout(&id);
        }
    }
    Ok(count)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashView {
    id: String,
    name: String,
    issuer: String,
    kind: String,
    deleted_at: u64,
}
#[tauri::command]
pub fn trash_list(s: State<AppState>) -> Result<Vec<TrashView>, String> {
    Ok(s.vault()?
        .ensure()?
        .trash
        .iter()
        .rev()
        .map(|entry| TrashView {
            id: entry.token.id.clone(),
            name: entry.token.name.clone(),
            issuer: entry.token.issuer.clone(),
            kind: entry.token.kind.clone(),
            deleted_at: entry.deleted_at,
        })
        .collect())
}
pub fn restore(data: &mut VaultData, ids: &[String]) -> Result<usize, String> {
    validate_ids(data, ids, true)?;
    let selected: Vec<_> = data
        .trash
        .iter()
        .filter(|e| ids.contains(&e.token.id))
        .collect();
    for (index, entry) in selected.iter().enumerate() {
        let duplicate = |t: &Token| {
            t.id == entry.token.id
                || t.kind == entry.token.kind && t.secret == entry.token.secret
                || t.kind == "steam"
                    && entry.token.kind == "steam"
                    && models::known_steam_id(t.steam_id.as_deref()).is_some()
                    && models::known_steam_id(t.steam_id.as_deref())
                        == models::known_steam_id(entry.token.steam_id.as_deref())
        };
        if data.tokens.iter().any(duplicate)
            || selected[..index].iter().any(|old| duplicate(&old.token))
        {
            return Err("令牌已存在，请先处理重复项".into());
        }
    }
    let mut kept = Vec::new();
    for entry in data.trash.drain(..) {
        if ids.contains(&entry.token.id) {
            data.tokens.push(entry.token);
        } else {
            kept.push(entry);
        }
    }
    data.trash = kept;
    data.tokens.sort_by_key(|t| t.sort_order);
    Ok(ids.len())
}
#[tauri::command]
pub fn trash_restore(s: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    s.vault()?.update(|d| restore(d, &ids))
}
#[tauri::command]
pub fn trash_delete(s: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    s.vault()?.update(|d| {
        validate_ids(d, &ids, true)?;
        for e in d.trash.iter_mut().filter(|e| ids.contains(&e.token.id)) {
            e.token.erase();
        }
        d.trash.retain(|e| !ids.contains(&e.token.id));
        Ok(ids.len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    #[test]
    fn manual_hotp_matches_rfc_and_rejects_duplicate_invalid_and_backwards_parameters() {
        let mut data = VaultData::default();
        let input: CreateInput = serde_json::from_value(serde_json::json!({"name":"RFC", "kind":"hotp", "secret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "counter":0})).unwrap();
        let id = create(&mut data, &input).unwrap();
        assert_eq!(data.tokens[0].id, id);
        assert_eq!(otp::code(&data.tokens[0], 0).unwrap(), "755224");
        assert!(create(&mut data, &input).is_err());
        let next: Parameters = serde_json::from_value(
            serde_json::json!({"counter":8,"pinned":true,"algorithm":"SHA256","digits":8}),
        )
        .unwrap();
        next.apply(&mut data.tokens[0]).unwrap();
        assert_eq!(data.tokens[0].counter, 8);
        assert!(data.tokens[0].pinned);
        assert!(Parameters {
            counter: Some(7),
            ..Default::default()
        }
        .apply(&mut data.tokens[0])
        .is_err());
        data.tokens[0].hotp_read_only = true;
        assert!(Parameters {
            counter: Some(9),
            ..Default::default()
        }
        .apply(&mut data.tokens[0])
        .is_err());
    }
    #[test]
    fn delete_is_encrypted_local_only_and_restore_keeps_identity() {
        let dir = std::env::temp_dir().join(format!("steamguard-trash-{}", uuid::Uuid::new_v4()));
        let mut vault = Vault::new(dir.join("vault.sgvault"));
        vault.create("synthetic password").unwrap();
        let token = Token::new(
            "private trash fixture".into(),
            "totp".into(),
            b"synthetic secret".to_vec(),
        );
        let id = token.id.clone();
        vault
            .update(|d| {
                d.tokens.push(token);
                Ok(())
            })
            .unwrap();
        vault.update(|d| delete(d, &[id.clone()])).unwrap();
        assert!(vault.ensure().unwrap().tokens.is_empty());
        assert_eq!(vault.ensure().unwrap().trash.len(), 1);
        let bytes = std::fs::read(&vault.path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private trash fixture"));
        let portable = vault.portable_encrypted().unwrap();
        assert!(crate::vault::decode(&portable, "synthetic password")
            .unwrap()
            .trash
            .is_empty());
        vault.lock();
        vault.unlock("synthetic password").unwrap();
        assert!(vault.update(|d| restore(d, &["missing".into()])).is_err());
        vault.update(|d| restore(d, &[id.clone()])).unwrap();
        assert_eq!(vault.ensure().unwrap().tokens[0].id, id);
        assert!(vault.ensure().unwrap().trash.is_empty());
        vault.lock();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restoring_two_deleted_copies_of_one_secret_is_rejected_atomically() {
        let mut data = VaultData::default();
        let original = Token::new("old".into(), "totp".into(), vec![9; 20]);
        let mut newer = original.clone();
        newer.id = uuid::Uuid::new_v4().to_string();
        let ids = vec![original.id.clone(), newer.id.clone()];
        data.trash = vec![
            TrashEntry {
                token: original,
                deleted_at: 1,
            },
            TrashEntry {
                token: newer,
                deleted_at: 2,
            },
        ];
        assert!(restore(&mut data, &ids).is_err());
        assert!(data.tokens.is_empty());
        assert_eq!(data.trash.len(), 2);
        restore(&mut data, &ids[..1]).unwrap();
        assert_eq!(data.tokens.len(), 1);
        assert_eq!(data.trash.len(), 1);
    }
}
