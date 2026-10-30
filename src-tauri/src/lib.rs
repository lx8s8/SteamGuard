#[cfg(target_os = "android")]
mod android_proxy;
mod import;
mod models;
mod network;
mod otp;
mod steam;
mod vault;

use models::{Token, TokenView};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

struct Preview {
    tokens: Vec<Token>,
    created: u64,
}
struct AppState {
    vault: Mutex<vault::Vault>,
    previews: Mutex<HashMap<String, Preview>>,
    steam: steam::SteamService,
    epoch: AtomicU64,
    time_offset: std::sync::atomic::AtomicI64,
}
impl AppState {
    fn vault(&self) -> Result<std::sync::MutexGuard<'_, vault::Vault>, String> {
        let mut v = self.vault.lock().map_err(|_| "令牌库暂不可用")?;
        if v.data.is_some() && models::now().saturating_sub(v.last_activity) > 900 {
            self.epoch.fetch_add(1, Ordering::SeqCst);
            v.lock();
            self.previews.lock().map_err(|_| "导入缓存不可用")?.clear();
            self.steam.clear();
        }
        Ok(v)
    }
    fn token(&self, id: &str) -> Result<Token, String> {
        let mut v = self.vault()?;
        v.ensure()?
            .tokens
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| "令牌不存在".into())
    }
    fn unlocked(&self) -> Result<(), String> {
        self.vault()?.ensure()?;
        Ok(())
    }
    fn save_session(&self, id: &str, epoch: u64) -> Result<(), String> {
        if self.epoch.load(Ordering::SeqCst) != epoch {
            self.steam.logout(id);
            return Err("令牌库已锁定，登录已取消".into());
        }
        let Some(session) = self.steam.export_session(id) else {
            return Ok(());
        };
        if id == "new-account" {
            return Ok(());
        }
        let mut v = self.vault()?;
        let d = v.ensure()?;
        if let Some(t) = d.tokens.iter_mut().find(|t| t.id == id) {
            if let Some(expected) = &t.steam_id {
                if expected != &session.steam_id {
                    self.steam.logout(id);
                    return Err("登录账号与令牌账号不一致".into());
                }
            }
            t.steam_id = Some(session.steam_id.clone());
            t.account_name = Some(session.account_name.clone());
        } else {
            self.steam.logout(id);
            return Err("令牌已删除，登录已取消".into());
        }
        if !d.sessions.is_object() {
            d.sessions = serde_json::json!({});
        }
        d.sessions[id] = serde_json::to_value(session).map_err(|_| "无法保存登录状态")?;
        v.touch();
        v.save()
    }
    fn timestamp(&self) -> u64 {
        (models::now() as i64 + self.time_offset.load(Ordering::Relaxed)).max(0) as u64
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    initialized: bool,
    locked: bool,
    token_count: usize,
}
#[tauri::command]
fn vault_status(s: State<AppState>) -> Result<VaultStatus, String> {
    let mut v = s.vault()?;
    let _ = v.ensure();
    Ok(VaultStatus {
        initialized: v.path.exists(),
        locked: v.data.is_none(),
        token_count: v.data.as_ref().map_or(0, |d| d.tokens.len()),
    })
}
#[tauri::command]
async fn vault_create(s: State<'_, AppState>, password: String) -> Result<(), String> {
    let p = Zeroizing::new(password);
    s.vault()?.create(&p)
}
#[tauri::command]
async fn vault_unlock(s: State<'_, AppState>, password: String) -> Result<(), String> {
    let p = Zeroizing::new(password);
    let mut v = s.vault()?;
    if v.data.is_some() {
        return Err("保险库已解锁".into());
    }
    if let Err(e) = v.unlock(&p) {
        v.lock();
        return Err(e);
    };
    if let Some(d) = &v.data {
        if let Err(e) = s.steam.configure_network(d.network.clone()) {
            v.lock();
            return Err(e);
        }
    }
    if let Some(d) = &v.data {
        if let Some(sessions) = d.sessions.as_object() {
            for (id, value) in sessions {
                if let Ok(session) = serde_json::from_value(value.clone()) {
                    let Some(token) = d.tokens.iter().find(|t| &t.id == id) else {
                        continue;
                    };
                    let expected = Some(token).and_then(|t| t.steam_id.as_deref());
                    let _ = s.steam.restore_session(id, session, expected);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    #[ignore = "Set WATT_TEST_MPO to a private local backup; never logs account data"]
    fn private_mpo_encrypted_backup_and_legacy_export_roundtrip() {
        let path = std::env::var("WATT_TEST_MPO").expect("Set private fixture path");
        let bytes = Zeroizing::new(std::fs::read(path).expect("Read private fixture"));
        let tokens =
            import::parse_import(&bytes, None, "private.mpo").expect("Import private fixture");
        assert!(!tokens.is_empty());
        let expected = tokens
            .iter()
            .map(|t| otp::code(t, 1_700_000_000).unwrap())
            .collect::<Vec<_>>();
        let data = vault::VaultData {
            tokens,
            sessions: serde_json::Value::Null,
            ..Default::default()
        };
        let encrypted = vault::backup(&data, "disposable fixture password").unwrap();
        let restored = vault::decode(&encrypted, "disposable fixture password").unwrap();
        let legacy =
            import::export_mpo(&restored.tokens, Some("disposable export password")).unwrap();
        let final_tokens =
            import::parse_import(&legacy, Some("disposable export password"), "roundtrip.mpo")
                .unwrap();
        assert!(final_tokens.len() == data.tokens.len());
        for (i, t) in final_tokens.iter().enumerate() {
            assert!(otp::code(t, 1_700_000_000).unwrap() == expected[i]);
            assert!(t.secret == data.tokens[i].secret);
            assert!(t.identity_secret == data.tokens[i].identity_secret);
            assert!(t.device_id == data.tokens[i].device_id);
            assert!(t.steam_id == data.tokens[i].steam_id);
        }
    }
}
#[tauri::command]
fn vault_lock(s: State<AppState>) -> Result<(), String> {
    s.epoch.fetch_add(1, Ordering::SeqCst);
    s.vault()?.lock();
    s.previews.lock().map_err(|_| "导入缓存不可用")?.clear();
    s.steam.clear();
    Ok(())
}
#[tauri::command]
fn vault_touch(s: State<AppState>) -> Result<(), String> {
    let mut v = s.vault()?;
    v.ensure()?;
    v.touch();
    Ok(())
}
#[tauri::command]
fn list_tokens(s: State<AppState>) -> Result<Vec<TokenView>, String> {
    let mut v = s.vault()?;
    let now = s.timestamp();
    v.ensure()?
        .tokens
        .iter()
        .map(|t| {
            Ok(TokenView {
                id: t.id.clone(),
                name: t.name.clone(),
                issuer: t.issuer.clone(),
                kind: t.kind.clone(),
                code: otp::code(t, now)?,
                period: t.period,
                remaining: if t.kind == "hotp" {
                    0
                } else {
                    t.period - now % t.period
                },
                algorithm: t.algorithm.clone(),
                digits: t.digits,
                counter: t.counter,
                steam_id: t.steam_id.clone(),
                account_name: t.account_name.clone(),
                logged_in: s.steam.is_logged_in(&t.id),
                has_identity_secret: t.identity_secret.is_some(),
                enrollment_pending: t
                    .steam_data
                    .as_ref()
                    .is_some_and(|v| v["steamguard_pending"].as_bool() == Some(true)),
            })
        })
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportPreview {
    preview_id: String,
    tokens: Vec<serde_json::Value>,
    duplicates: usize,
}
#[tauri::command]
async fn import_preview(
    s: State<'_, AppState>,
    data: Option<Vec<u8>>,
    filename: Option<String>,
    text: Option<String>,
    password: Option<String>,
) -> Result<ImportPreview, String> {
    s.unlocked()?;
    let p = Zeroizing::new(password.unwrap_or_default());
    let bytes = Zeroizing::new(data.unwrap_or_else(|| text.unwrap_or_default().into_bytes()));
    if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
        return Err("请选择不超过 10 MB 的令牌文件".into());
    }
    let filename = filename.unwrap_or_default();
    let mut tokens =
        if filename.ends_with(".sgvault") || bytes.windows(16).any(|w| w == b"SteamGuard Vault") {
            vault::decode(&bytes, &p)?.tokens
        } else {
            import::parse_import(
                &bytes,
                if p.is_empty() { None } else { Some(&p) },
                &filename,
            )?
        };
    if tokens.len() > 1000 {
        return Err("一次最多导入 1000 个令牌".into());
    }
    for t in &tokens {
        t.validate()?;
    }
    let mut v = s.vault()?;
    let existing = &v.ensure()?.tokens;
    let count = tokens.len();
    let mut seen = std::collections::HashSet::new();
    tokens.retain(|t| {
        !existing
            .iter()
            .any(|e| e.kind == t.kind && e.secret == t.secret)
            && seen.insert((t.kind.clone(), t.secret.clone()))
    });
    let result = ImportPreview {
        preview_id: uuid::Uuid::new_v4().to_string(),
        tokens: tokens
            .iter()
            .map(|t| serde_json::json!({"name":t.name,"issuer":t.issuer,"kind":t.kind}))
            .collect(),
        duplicates: count - tokens.len(),
    };
    let mut previews = s.previews.lock().map_err(|_| "导入缓存不可用")?;
    previews.retain(|_, p| models::now().saturating_sub(p.created) < 300);
    previews.clear();
    previews.insert(
        result.preview_id.clone(),
        Preview {
            tokens,
            created: models::now(),
        },
    );
    v.touch();
    Ok(result)
}
#[tauri::command]
fn import_commit(s: State<AppState>, preview_id: String) -> Result<usize, String> {
    let mut v = s.vault()?;
    v.ensure()?;
    let p = s
        .previews
        .lock()
        .map_err(|_| "导入缓存不可用")?
        .remove(&preview_id)
        .ok_or("预览已过期，请重新导入")?;
    if models::now().saturating_sub(p.created) > 300 {
        return Err("预览已过期，请重新导入".into());
    }
    let old = v.ensure()?.tokens.clone();
    let mut count = 0;
    for mut t in p.tokens {
        if !v
            .ensure()?
            .tokens
            .iter()
            .any(|e| e.kind == t.kind && e.secret == t.secret)
        {
            t.id = uuid::Uuid::new_v4().to_string();
            v.ensure()?.tokens.push(t);
            count += 1;
        }
    }
    v.touch();
    if let Err(e) = v.save() {
        v.ensure()?.tokens = old;
        return Err(e);
    };
    Ok(count)
}
#[tauri::command]
fn token_rename(s: State<AppState>, id: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("名称需为 1–120 个字符".into());
    }
    let mut v = s.vault()?;
    let t = v
        .ensure()?
        .tokens
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("令牌不存在")?;
    t.name = name.into();
    v.touch();
    v.save()
}
#[tauri::command]
fn token_delete(s: State<AppState>, id: String) -> Result<(), String> {
    let mut v = s.vault()?;
    let d = v.ensure()?;
    if let Some(t) = d.tokens.iter_mut().find(|t| t.id == id) {
        t.erase()
    };
    d.tokens.retain(|t| t.id != id);
    if let Some(m) = d.sessions.as_object_mut() {
        m.remove(&id);
    };
    s.steam.logout(&id);
    v.touch();
    v.save()
}
#[tauri::command]
fn token_advance(s: State<AppState>, id: String) -> Result<(), String> {
    let mut v = s.vault()?;
    let t = v
        .ensure()?
        .tokens
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("令牌不存在")?;
    if t.kind != "hotp" {
        return Err("只有 HOTP 令牌可增加计数".into());
    }
    t.counter = t.counter.checked_add(1).ok_or("计数溢出")?;
    v.touch();
    v.save()
}
#[tauri::command]
fn token_reorder(s: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    let mut v = s.vault()?;
    let tokens = &mut v.ensure()?.tokens;
    if ids.len() != tokens.len()
        || ids.iter().collect::<std::collections::HashSet<_>>().len() != tokens.len()
    {
        return Err("排序数据无效".into());
    }
    let mut ordered = Vec::new();
    for id in ids {
        ordered.push(
            tokens
                .iter()
                .find(|t| t.id == id)
                .ok_or("令牌不存在")?
                .clone(),
        );
    }
    *tokens = ordered;
    v.touch();
    v.save()
}
#[tauri::command]
async fn vault_export(
    app: tauri::AppHandle,
    s: State<'_, AppState>,
    password: String,
    format: Option<String>,
) -> Result<Option<String>, String> {
    let p = Zeroizing::new(password);
    if p.chars().count() < 8 {
        return Err("备份密码至少需要 8 个字符".into());
    }
    let mpo = format.as_deref() == Some("mpo");
    let bytes = {
        let mut v = s.vault()?;
        let bytes = if mpo {
            import::export_mpo(&v.ensure()?.tokens, Some(&p))?
        } else {
            vault::backup(v.ensure()?, &p)?
        };
        v.touch();
        bytes
    };
    save_file(
        &app,
        if mpo {
            "SteamGuard-backup.mpo"
        } else {
            "SteamGuard-backup.sgvault"
        },
        if mpo { "mpo" } else { "sgvault" },
        bytes,
    )
    .await
}
async fn save_file(
    app: &tauri::AppHandle,
    name: &str,
    ext: &str,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let bytes = Zeroizing::new(bytes);
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("令牌备份", &[ext])
        .set_file_name(name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    use std::io::Write;
    use tauri_plugin_fs::FsExt;
    let label = match &path {
        tauri_plugin_dialog::FilePath::Path(p) => p.to_string_lossy().to_string(),
        tauri_plugin_dialog::FilePath::Url(u) => u.to_string(),
    };
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = app
        .fs()
        .open(path, options)
        .map_err(|_| "无法打开保存位置")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法保存文件")?;
    Ok(Some(label))
}
#[tauri::command]
fn token_uri(s: State<AppState>, id: String) -> Result<String, String> {
    let t = s.token(&id)?;
    let kind = if t.kind == "hotp" { "hotp" } else { "totp" };
    let mut u = url::Url::parse(&format!("otpauth://{kind}/")).map_err(|_| "URI 格式错误")?;
    u.set_path(&format!("{}:{}", t.issuer, t.name));
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("secret", &data_encoding::BASE32_NOPAD.encode(&t.secret))
            .append_pair("issuer", &t.issuer)
            .append_pair("algorithm", &t.algorithm)
            .append_pair("digits", &t.digits.to_string());
        if t.kind == "hotp" {
            q.append_pair("counter", &t.counter.to_string());
        } else {
            q.append_pair("period", &t.period.to_string());
        }
        if t.kind == "steam" {
            q.append_pair("encoder", "steam");
        }
    }
    Ok(u.to_string())
}
#[tauri::command]
async fn token_export(
    app: tauri::AppHandle,
    s: State<'_, AppState>,
    id: String,
    format: String,
) -> Result<Option<String>, String> {
    let t = s.token(&id)?;
    if format == "otpauth" {
        let uri = token_uri(s, id)?;
        return save_file(&app, "authenticator.txt", "txt", uri.into_bytes()).await;
    }
    if format != "mafile" || t.kind != "steam" {
        return Err("请选择 Steam 令牌导出 maFile".into());
    }
    use base64::Engine;
    let mut data = t
        .steam_data
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));
    data["shared_secret"] = base64::engine::general_purpose::STANDARD
        .encode(&t.secret)
        .into();
    if let Some(x) = t.identity_secret {
        data["identity_secret"] = x.into()
    };
    if let Some(x) = t.device_id {
        data["device_id"] = x.into()
    };
    if let Some(x) = t.account_name {
        data["account_name"] = x.into()
    };
    if let Some(x) = t.steam_id {
        data["steamid"] = x.into()
    };
    save_file(
        &app,
        "authenticator.maFile",
        "maFile",
        serde_json::to_vec_pretty(&data).map_err(|_| "导出失败")?,
    )
    .await
}
#[tauri::command]
async fn steam_login(
    s: State<'_, AppState>,
    id: String,
    username: String,
    password: String,
) -> Result<steam::LoginStatus, String> {
    s.unlocked()?;
    let t = if id == "new-account" {
        None
    } else {
        Some(s.token(&id)?)
    };
    let p = Zeroizing::new(password);
    let epoch = s.epoch.load(Ordering::SeqCst);
    let code = Zeroizing::new(
        t.as_ref()
            .map(|t| otp::code(t, s.timestamp()))
            .transpose()?
            .unwrap_or_default(),
    );
    let r = s
        .steam
        .begin_login(
            &id,
            &username,
            &p,
            t.as_ref().and_then(|t| t.steam_id.as_deref()),
            if code.is_empty() { None } else { Some(&code) },
        )
        .await?;
    s.save_session(&id, epoch)?;
    Ok(r)
}
#[tauri::command]
async fn steam_begin_qr(s: State<'_, AppState>, id: String) -> Result<steam::LoginStatus, String> {
    s.unlocked()?;
    let t = if id == "new-account" {
        None
    } else {
        Some(s.token(&id)?)
    };
    s.steam
        .begin_qr(&id, t.as_ref().and_then(|t| t.steam_id.as_deref()))
        .await
}
#[tauri::command]
async fn steam_submit_guard(
    s: State<'_, AppState>,
    id: String,
    code: String,
    code_type: u32,
) -> Result<steam::LoginStatus, String> {
    s.unlocked()?;
    let epoch = s.epoch.load(Ordering::SeqCst);
    let r = s.steam.submit_guard(&id, &code, code_type).await?;
    s.save_session(&id, epoch)?;
    Ok(r)
}
#[tauri::command]
async fn steam_poll_login(
    s: State<'_, AppState>,
    id: String,
) -> Result<steam::LoginStatus, String> {
    s.unlocked()?;
    let epoch = s.epoch.load(Ordering::SeqCst);
    let r = s.steam.poll_login(&id).await?;
    s.save_session(&id, epoch)?;
    Ok(r)
}
#[tauri::command]
fn steam_logout(s: State<AppState>, id: String) -> Result<(), String> {
    s.unlocked()?;
    s.steam.logout(&id);
    let mut v = s.vault()?;
    if let Some(m) = v.ensure()?.sessions.as_object_mut() {
        m.remove(&id);
    };
    v.touch();
    v.save()
}
#[tauri::command]
async fn steam_confirmations(
    s: State<'_, AppState>,
    id: String,
) -> Result<Vec<steam::Confirmation>, String> {
    let t = s.token(&id)?;
    s.steam
        .confirmations(
            &id,
            t.identity_secret
                .as_deref()
                .ok_or("缺少 identity_secret，无法加载交易确认")?,
            t.device_id
                .as_deref()
                .ok_or("缺少设备标识，请重新导入完整 maFile")?,
            t.steam_id.as_deref(),
        )
        .await
}
#[tauri::command]
async fn steam_confirmation_action(
    s: State<'_, AppState>,
    id: String,
    confirmation_id: String,
    confirmation_key: String,
    approve: bool,
) -> Result<(), String> {
    let t = s.token(&id)?;
    s.steam
        .act_confirmation(
            &id,
            t.identity_secret.as_deref().ok_or("缺少确认密钥")?,
            t.device_id.as_deref().ok_or("缺少设备标识")?,
            t.steam_id.as_deref(),
            &confirmation_id,
            &confirmation_key,
            approve,
        )
        .await
}
#[tauri::command]
async fn steam_market(
    s: State<'_, AppState>,
    id: String,
    start: Option<u32>,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    s.token(&id)?;
    s.steam
        .market_listings(&id, start.unwrap_or(0), count.unwrap_or(20).clamp(1, 100))
        .await
}
#[tauri::command]
async fn steam_market_search(
    s: State<'_, AppState>,
    query: String,
    start: Option<u32>,
) -> Result<serde_json::Value, String> {
    s.unlocked()?;
    s.steam.market_search(&query, start.unwrap_or(0), 20).await
}
#[tauri::command]
async fn steam_qr_info(
    s: State<'_, AppState>,
    id: String,
    url: String,
) -> Result<serde_json::Value, String> {
    let t = s.token(&id)?;
    s.steam
        .qr_login_info(&id, &url, t.steam_id.as_deref())
        .await
}
#[tauri::command]
async fn steam_qr_approve(
    s: State<'_, AppState>,
    id: String,
    url: String,
    approve: bool,
) -> Result<(), String> {
    let t = s.token(&id)?;
    s.steam
        .approve_qr_login(&id, &url, &t.secret, t.steam_id.as_deref(), approve)
        .await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentView {
    id: String,
    phone_hint: String,
    revocation_code: String,
    needs_activation: bool,
}
struct EnrollmentContext {
    epoch: u64,
    lease: vault::RecoveryLease,
    session: steam::SteamSession,
}
fn enrollment_context(s: &AppState, id: &str) -> Result<EnrollmentContext, String> {
    let mut v = s.vault()?;
    v.ensure()?;
    v.touch();
    Ok(EnrollmentContext {
        epoch: s.epoch.load(Ordering::SeqCst),
        lease: v.lease()?,
        session: s.steam.export_session(id).ok_or("请先登录 Steam")?,
    })
}
fn persist_enrollment(
    s: &AppState,
    e: steam::EnrollmentSecret,
    name: Option<String>,
    pending: bool,
    context: EnrollmentContext,
) -> Result<EnrollmentView, String> {
    // Persist recovery material before reporting SMS activation or transfer success.
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut v = s.vault()?;
    let existing = v
        .data
        .as_ref()
        .and_then(|d| {
            d.tokens
                .iter()
                .find(|t| t.steam_id.as_deref() == Some(&e.steam_id))
        })
        .map(|t| t.id.clone());
    let mut t = Token::new(
        name.filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| e.account_name.clone()),
        "steam".into(),
        e.shared_secret,
    );
    if let Some(id) = existing {
        t.id = id;
    }
    t.steam_id = Some(e.steam_id.clone());
    t.account_name = Some(e.account_name.clone());
    t.identity_secret = Some(STANDARD.encode(&e.identity_secret));
    t.device_id = Some(e.device_id.clone());
    t.steam_data = Some(
        serde_json::json!({"steamid":e.steam_id,"account_name":e.account_name,"identity_secret":STANDARD.encode(e.identity_secret),"device_id":e.device_id,"serial_number":e.serial_number,"revocation_code":e.revocation_code,"token_gid":e.token_gid,"steamguard_pending":pending}),
    );
    let result = EnrollmentView {
        id: t.id.clone(),
        phone_hint: e.phone_number_hint,
        revocation_code: e.revocation_code,
        needs_activation: pending,
    };
    let mut sessions = serde_json::json!({});
    sessions[&result.id] = serde_json::to_value(&context.session).map_err(|_| "无法保存会话")?;
    let checkpoint = context.lease.checkpoint(&vault::VaultData {
        tokens: vec![t.clone()],
        sessions,
        network: s.steam.network_settings(),
    })?;
    if s.epoch.load(Ordering::SeqCst) != context.epoch || v.data.is_none() {
        return Err(
            "新令牌已加密保存。请解锁保险库，应用会自动恢复，再继续激活或导出备份。".into(),
        );
    }
    let d = v.ensure()?;
    if let Some(old) = d.tokens.iter_mut().find(|x| x.id == t.id) {
        old.erase();
        *old = t
    } else {
        d.tokens.push(t)
    }
    if !d.sessions.is_object() {
        d.sessions = serde_json::json!({})
    };
    d.sessions[&result.id] = serde_json::to_value(&context.session).map_err(|_| "无法保存会话")?;
    s.steam
        .restore_session(&result.id, context.session, Some(&e.steam_id))?;
    s.time_offset.store(
        e.server_time as i64 - models::now() as i64,
        Ordering::Relaxed,
    );
    v.touch();
    v.save()?;
    let _ = std::fs::remove_file(checkpoint);
    Ok(result)
}
#[tauri::command]
async fn steam_enroll_begin(
    s: State<'_, AppState>,
    id: String,
    name: Option<String>,
) -> Result<EnrollmentView, String> {
    let context = enrollment_context(&s, &id)?;
    let e = s.steam.begin_enrollment(&id, None).await?;
    persist_enrollment(&s, e, name, true, context)
}
#[tauri::command]
async fn steam_enroll_finalize(
    s: State<'_, AppState>,
    id: String,
    sms_code: String,
) -> Result<(), String> {
    let t = s.token(&id)?;
    s.steam
        .finalize_enrollment(&id, &t.secret, &sms_code, t.steam_id.as_deref())
        .await?;
    let mut v = s.vault()?;
    if let Some(t) = v.ensure()?.tokens.iter_mut().find(|t| t.id == id) {
        if let Some(d) = &mut t.steam_data {
            d["steamguard_pending"] = false.into()
        }
    }
    v.touch();
    v.save()
}
#[tauri::command]
async fn steam_transfer_begin(s: State<'_, AppState>, id: String) -> Result<(), String> {
    s.unlocked()?;
    s.steam.begin_transfer(&id, None).await
}
#[tauri::command]
async fn steam_transfer_finish(
    s: State<'_, AppState>,
    id: String,
    sms_code: String,
    name: Option<String>,
) -> Result<EnrollmentView, String> {
    let context = enrollment_context(&s, &id)?;
    let e = s.steam.finish_transfer(&id, &sms_code, None).await?;
    persist_enrollment(&s, e, name, false, context)
}
#[tauri::command]
async fn steam_remove_authenticator(
    s: State<'_, AppState>,
    id: String,
    revocation_code: String,
) -> Result<(), String> {
    let t = s.token(&id)?;
    let r = Zeroizing::new(revocation_code);
    s.steam
        .remove_authenticator(&id, &r, t.steam_id.as_deref())
        .await?;
    let mut v = s.vault()?;
    if let Some(m) = v.ensure()?.sessions.as_object_mut() {
        m.remove(&id);
    };
    if let Some(t) = v.ensure()?.tokens.iter_mut().find(|t| t.id == id) {
        if let Some(data) = &mut t.steam_data {
            data["steamguard_removed"] = true.into()
        }
    }
    v.touch();
    v.save()
}
#[tauri::command]
fn steam_network_settings(s: State<AppState>) -> Result<network::NetworkSettings, String> {
    s.unlocked()?;
    Ok(s.steam.network_settings())
}
#[tauri::command]
fn steam_network_configure(
    s: State<AppState>,
    settings: network::NetworkSettings,
) -> Result<(), String> {
    let mut v = s.vault()?;
    let old = v.ensure()?.network.clone();
    s.steam.configure_network(settings.clone())?;
    v.ensure()?.network = settings;
    v.touch();
    if let Err(e) = v.save() {
        v.ensure()?.network = old.clone();
        let _ = s.steam.configure_network(old);
        return Err(e);
    }
    Ok(())
}
#[tauri::command]
async fn steam_network_diagnostics(s: State<'_, AppState>) -> Result<steam::NetworkReport, String> {
    s.unlocked()?;
    s.steam.network_diagnostics().await
}
#[tauri::command]
async fn sync_time(s: State<'_, AppState>) -> Result<i64, String> {
    s.unlocked()?;
    let start = models::now() as i64;
    let server = s.steam.server_time().await? as i64;
    let offset = server - (start + models::now() as i64) / 2;
    s.time_offset.store(offset, Ordering::Relaxed);
    Ok(offset)
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let u = url::Url::parse(&url).map_err(|_| "链接无效")?;
    if u.scheme() != "https"
        || ![
            "steamcommunity.com",
            "store.steampowered.com",
            "help.steampowered.com",
            "login.steampowered.com",
        ]
        .contains(&u.host_str().unwrap_or(""))
    {
        return Err("仅允许打开 Steam 官方 HTTPS 页面".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "无法打开浏览器".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("vault.sgvault");
            let steam = steam::SteamService::new().map_err(std::io::Error::other)?;
            app.manage(AppState {
                vault: Mutex::new(vault::Vault::new(path)),
                previews: Mutex::new(HashMap::new()),
                steam,
                epoch: AtomicU64::new(0),
                time_offset: std::sync::atomic::AtomicI64::new(0),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_touch,
            list_tokens,
            import_preview,
            import_commit,
            token_rename,
            token_delete,
            token_advance,
            token_reorder,
            vault_export,
            token_uri,
            token_export,
            steam_login,
            steam_begin_qr,
            steam_submit_guard,
            steam_poll_login,
            steam_logout,
            steam_confirmations,
            steam_confirmation_action,
            steam_market,
            steam_market_search,
            steam_qr_info,
            steam_qr_approve,
            steam_enroll_begin,
            steam_enroll_finalize,
            steam_transfer_begin,
            steam_transfer_finish,
            steam_remove_authenticator,
            steam_network_settings,
            steam_network_configure,
            steam_network_diagnostics,
            sync_time,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("SteamGuard runtime failed");
}
