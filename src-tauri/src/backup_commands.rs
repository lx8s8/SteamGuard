//! Decrypted previews live only in the expiring native cache and expose labels.
use crate::{
    models::{self, Token},
    vault::{self, VaultData},
    AppState, Preview,
};
use serde::Serialize;
use std::{collections::HashSet, sync::atomic::Ordering};
use tauri::State;
use zeroize::Zeroizing;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    id: String,
    name: String,
    issuer: String,
    kind: String,
    status: String,
    detail: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    preview_id: String,
    tokens: Vec<Row>,
    new_count: usize,
    update_count: usize,
    unchanged_count: usize,
    conflict_count: usize,
}
/// Restoring preferences never rolls back an HOTP counter or removes known Steam identity.
fn restore_token(existing: &mut Token, incoming: &Token) -> Result<bool, String> {
    let before = Zeroizing::new(serde_json::to_vec(&*existing).map_err(|_| "无法比较令牌")?);
    vault::merge_metadata(existing, incoming)?;
    existing.name = incoming.name.clone();
    existing.issuer = incoming.issuer.clone();
    existing.algorithm = incoming.algorithm.clone();
    existing.digits = incoming.digits;
    existing.period = incoming.period;
    existing.group = incoming.group.clone();
    existing.icon = incoming.icon.clone();
    existing.pinned = incoming.pinned;
    existing.validate()?;
    Ok(before.as_slice()
        != Zeroizing::new(serde_json::to_vec(existing).map_err(|_| "无法比较令牌")?).as_slice())
}
fn conflict_account(data: &VaultData, incoming: &Token) -> bool {
    incoming.kind == "steam"
        && models::known_steam_id(incoming.steam_id.as_deref()).is_some()
        && data.tokens.iter().any(|t| {
            t.kind == "steam"
                && models::known_steam_id(t.steam_id.as_deref())
                    == models::known_steam_id(incoming.steam_id.as_deref())
        })
}
pub fn preview(s: &AppState, name: &str, password: &str) -> Result<BackupPreview, String> {
    let epoch = s.epoch.load(Ordering::SeqCst);
    let path = {
        let mut v = s.vault()?;
        v.ensure()?;
        v.path.clone()
    };
    let bytes = Zeroizing::new(crate::backup::read(&path, name)?);
    let mut decoded = vault::decode(&bytes, password)?;
    let mut staged = Preview {
        groups: decoded.group_names(),
        tokens: std::mem::take(&mut decoded.tokens),
        created: models::now(),
        expected_revision: None,
    };
    vault::wipe_json(&mut decoded.sessions);
    if staged.tokens.len() > 1000 {
        return Err("一次最多恢复 1000 个令牌".into());
    }
    let mut v = s.vault()?;
    staged.expected_revision = Some(v.revision.clone());
    let data = v.ensure()?;
    if epoch != s.epoch.load(Ordering::SeqCst) {
        return Err("保险库状态已变化，请重新检查备份".into());
    }
    let mut result = BackupPreview {
        preview_id: uuid::Uuid::new_v4().to_string(),
        tokens: vec![],
        new_count: 0,
        update_count: 0,
        unchanged_count: 0,
        conflict_count: 0,
    };
    for t in &mut staged.tokens {
        // Each row has a unique opaque handle even for malformed duplicate source IDs.
        t.id = uuid::Uuid::new_v4().to_string();
        let (status, detail) = if let Some(old) = data
            .tokens
            .iter()
            .find(|e| e.kind == t.kind && e.secret == t.secret)
        {
            let mut candidate = old.clone();
            let comparison = restore_token(&mut candidate, t);
            let mut fields = vec![];
            if old.name != candidate.name {
                fields.push("名称");
            }
            if old.issuer != candidate.issuer {
                fields.push("发行方");
            }
            if old.algorithm != candidate.algorithm {
                fields.push("算法");
            }
            if old.digits != candidate.digits {
                fields.push("位数");
            }
            if old.period != candidate.period {
                fields.push("周期");
            }
            if old.group != candidate.group {
                fields.push("分组");
            }
            if old.icon != candidate.icon {
                fields.push("头像");
            }
            if old.pinned != candidate.pinned {
                fields.push("置顶状态");
            }
            if old.counter != candidate.counter {
                fields.push("HOTP 计数");
            }
            if old.steam_id != candidate.steam_id
                || old.identity_secret != candidate.identity_secret
                || old.device_id != candidate.device_id
                || old.steam_data != candidate.steam_data
            {
                fields.push("Steam 身份资料");
            }
            let changes = (!fields.is_empty()).then(|| format!("将还原：{}", fields.join("、")));
            candidate.erase();
            match comparison {
                Ok(true) => {
                    result.update_count += 1;
                    ("update", changes)
                }
                Ok(false) => {
                    result.unchanged_count += 1;
                    ("unchanged", None)
                }
                Err(error) => {
                    result.conflict_count += 1;
                    ("conflict", Some(error))
                }
            }
        } else if conflict_account(data, t) {
            result.conflict_count += 1;
            (
                "conflict",
                Some("相同 SteamID 的密钥不同，拒绝恢复旧密钥".into()),
            )
        } else {
            result.new_count += 1;
            ("new", None)
        };
        result.tokens.push(Row {
            id: t.id.clone(),
            name: t.name.clone(),
            issuer: t.issuer.clone(),
            kind: t.kind.clone(),
            status: status.into(),
            detail,
        });
    }
    let mut previews = s.previews.lock().map_err(|_| "备份预览缓存不可用")?;
    previews.clear();
    previews.insert(result.preview_id.clone(), staged);
    v.touch();
    Ok(result)
}
#[tauri::command]
pub fn backup_preview(
    s: State<AppState>,
    name: String,
    password: String,
) -> Result<BackupPreview, String> {
    preview(&s, &name, &Zeroizing::new(password))
}
pub fn restore_selected(s: &AppState, preview_id: &str, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() || ids.len() > 1000 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err("请选择有效且不重复的备份令牌".into());
    }
    let mut v = s.vault()?;
    v.ensure()?;
    let mut preview = s
        .previews
        .lock()
        .map_err(|_| "备份预览缓存不可用")?
        .remove(preview_id)
        .ok_or("备份预览已过期，请重新检查")?;
    if models::now().saturating_sub(preview.created) > 300 {
        return Err("备份预览已过期，请重新检查".into());
    }
    if ids
        .iter()
        .any(|id| !preview.tokens.iter().any(|t| &t.id == id))
    {
        return Err("备份选择无效".into());
    }
    if preview
        .expected_revision
        .as_deref()
        .is_some_and(|revision| revision != v.revision)
    {
        return Err("令牌库已变化，请重新预览备份后再还原".into());
    }
    let result = v.update(|data| {
        let mut changed = 0;
        for incoming in preview.tokens.iter_mut().filter(|t| ids.contains(&t.id)) {
            if let Some(existing) = data
                .tokens
                .iter_mut()
                .find(|e| e.kind == incoming.kind && e.secret == incoming.secret)
            {
                if restore_token(existing, incoming)? {
                    changed += 1;
                }
            } else {
                if conflict_account(data, incoming) {
                    return Err("相同 SteamID 的密钥不同，拒绝恢复旧密钥".into());
                }
                let mut token = incoming.clone();
                token.id = uuid::Uuid::new_v4().to_string();
                token.hotp_read_only = false;
                token.sort_order = data
                    .tokens
                    .iter()
                    .map(|t| t.sort_order)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1024);
                data.tokens.push(token);
                changed += 1;
            }
        }
        data.groups = data.group_names();
        Ok(changed)
    });
    // Rechecking after a conflict or disk error is explicit and avoids stale merges.
    result
}
#[tauri::command]
pub fn backup_restore_selected(
    s: State<AppState>,
    preview_id: String,
    ids: Vec<String>,
) -> Result<usize, String> {
    restore_selected(&s, &preview_id, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicI64, AtomicU64},
        Mutex,
    };
    #[test]
    fn decrypted_preview_is_safe_selective_and_preserves_newer_hotp_counter() {
        let dir = std::env::temp_dir().join(format!(
            "steamguard-restore-preview-{}",
            uuid::Uuid::new_v4()
        ));
        let mut vault = vault::Vault::new(dir.join("vault.sgvault"));
        vault.create("synthetic password").unwrap();
        let mut original = Token::new(
            "backup label".into(),
            "hotp".into(),
            b"synthetic backup secret".to_vec(),
        );
        original.counter = 50;
        vault
            .update(|d| {
                d.tokens.push(original);
                Ok(())
            })
            .unwrap();
        let name = crate::backup::list(&vault.path)
            .unwrap()
            .into_iter()
            .find(|r| !r.daily)
            .unwrap()
            .name;
        vault
            .update(|d| {
                d.tokens[0].name = "current label".into();
                d.tokens[0].counter = 100;
                d.tokens.push(Token::new(
                    "unselected current".into(),
                    "totp".into(),
                    vec![7; 20],
                ));
                Ok(())
            })
            .unwrap();
        let s = AppState {
            vault: Mutex::new(vault),
            previews: Mutex::new(Default::default()),
            steam: crate::steam::SteamService::new().unwrap(),
            epoch: AtomicU64::new(0),
            time_offset: AtomicI64::new(0),
            sync: Default::default(),
        };
        assert!(preview(&s, &name, "wrong password").is_err());
        let p = preview(&s, &name, "synthetic password").unwrap();
        assert_eq!(p.update_count, 1);
        let visible = serde_json::to_string(&p).unwrap();
        assert!(!visible.contains("synthetic backup secret"));
        assert!(!visible.contains("secret"));
        let ids = vec![p.tokens[0].id.clone()];
        assert_eq!(restore_selected(&s, &p.preview_id, &ids).unwrap(), 1);
        assert!(restore_selected(&s, &p.preview_id, &ids).is_err());
        let mut v = s.vault().unwrap();
        let d = v.ensure().unwrap();
        assert_eq!(d.tokens.len(), 2);
        assert_eq!(d.tokens[0].name, "backup label");
        assert_eq!(d.tokens[0].counter, 100);
        assert_eq!(d.tokens[1].name, "unselected current");
        v.lock();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
