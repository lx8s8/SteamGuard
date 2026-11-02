//! Local preferences and ownership-based cleanup. No clipboard content is read.
use crate::{quick_access::QuickAccess, AppState};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_private_clipboard::PrivateClipboardExt;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    clear_after: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self { clear_after: 30 }
    }
}
fn valid(value: u64) -> bool {
    [0, 15, 30, 60, 120].contains(&value)
}
struct Deadline {
    monotonic: Instant,
    wall: SystemTime,
}
struct Owned {
    owner: String,
    expires: Option<Deadline>,
}
pub struct Controller {
    path: PathBuf,
    settings: Mutex<Settings>,
    owned: Mutex<Option<Owned>>,
    operation: Mutex<()>,
}
impl Controller {
    pub fn new(path: PathBuf) -> Self {
        let settings = std::fs::read(&path)
            .ok()
            .and_then(|v| serde_json::from_slice::<Settings>(&v).ok())
            .filter(|s| valid(s.clear_after))
            .unwrap_or_default();
        Self {
            path,
            settings: Mutex::new(settings),
            owned: Mutex::new(None),
            operation: Mutex::new(()),
        }
    }
}
#[tauri::command(async)]
pub fn clipboard_settings(control: State<Controller>) -> Result<Settings, String> {
    control
        .settings
        .lock()
        .map(|v| *v)
        .map_err(|_| "复制设置不可用".into())
}
#[tauri::command(async)]
pub fn clipboard_configure(
    s: State<AppState>,
    control: State<Controller>,
    clear_after: u64,
) -> Result<Settings, String> {
    s.unlocked()?;
    if !valid(clear_after) {
        return Err("剪贴板清除时间无效".into());
    }
    let next = Settings { clear_after };
    let mut settings = control.settings.lock().map_err(|_| "复制设置不可用")?;
    let bytes = serde_json::to_vec(&next).map_err(|_| "无法保存复制设置")?;
    crate::quick_access::write_private(&control.path, &bytes).map_err(|_| "无法保存复制设置")?;
    *settings = next;
    Ok(next)
}
pub fn write(app: &AppHandle, value: &str, epoch: u64) -> Result<(), String> {
    let control = app.state::<Controller>();
    let _operation = control.operation.lock().map_err(|_| "复制设置不可用")?;
    if app
        .state::<AppState>()
        .epoch
        .load(std::sync::atomic::Ordering::SeqCst)
        != epoch
    {
        return Err("保险库状态已变化，请重试".into());
    }
    let seconds = control
        .settings
        .lock()
        .map_err(|_| "复制设置不可用")?
        .clear_after;
    let owner = app.private_clipboard().write(app, value, seconds)?;
    *control.owned.lock().map_err(|_| "复制设置不可用")? = Some(Owned {
        owner,
        expires: (seconds > 0).then(|| Deadline {
            monotonic: Instant::now() + Duration::from_secs(seconds),
            wall: SystemTime::now() + Duration::from_secs(seconds),
        }),
    });
    if seconds > 0 {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            // iOS handles expiration independently; retries cover temporary
            // Windows locks and Android foreground clipboard restrictions.
            for _ in 0..3 {
                if expire(&app).is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
    Ok(())
}
fn expire(app: &AppHandle) -> Result<(), String> {
    let control = app.state::<Controller>();
    let _operation = control.operation.lock().map_err(|_| "复制设置不可用")?;
    let mut owned = control.owned.lock().map_err(|_| "复制设置不可用")?;
    expire_owned(&mut owned, Instant::now(), |owner| {
        app.private_clipboard().clear(owner)
    })?;
    Ok(())
}
fn expire_owned(
    owned: &mut Option<Owned>,
    now: Instant,
    clear: impl FnOnce(&str) -> Result<bool, String>,
) -> Result<(), String> {
    if owned.as_ref().is_some_and(|o| due(o.expires.as_ref(), now)) {
        clear(&owned.as_ref().unwrap().owner)?;
        *owned = None;
    }
    Ok(())
}
fn due(expiry: Option<&Deadline>, now: Instant) -> bool {
    expiry.is_some_and(|v| v.monotonic <= now || v.wall <= SystemTime::now())
}
#[tauri::command]
pub async fn clipboard_housekeeping(app: AppHandle) -> Result<(), String> {
    // Android can resume the WebView just before the activity gains focus.
    // Retain ownership until the OS allows cleanup, without reading its text.
    for _ in 0..3 {
        if expire(&app).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    expire(&app)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Copied {
    code: String,
    period: u64,
    remaining: u64,
}
#[tauri::command]
pub async fn token_copy(
    app: AppHandle,
    s: State<'_, AppState>,
    q: State<'_, QuickAccess>,
    id: String,
) -> Result<Copied, String> {
    let epoch = s.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let mut vault = s.vault()?;
    let now = s.timestamp();
    let (code, period, remaining) = if let Some(data) = &vault.data {
        let token = data
            .tokens
            .iter()
            .find(|t| t.id == id)
            .ok_or("令牌已删除")?;
        if token.hotp_read_only {
            return Err("此 HOTP 由另一设备生成".into());
        }
        (
            Zeroizing::new(crate::otp::code(token, now)?),
            token.period,
            if token.kind == "hotp" {
                0
            } else {
                token.period - now % token.period
            },
        )
    } else {
        let item = q
            .codes(&vault.path, now)?
            .codes
            .into_iter()
            .find(|t| t.id == id)
            .ok_or("令牌不可用，请先解锁")?;
        if item.code.is_empty() {
            return Err("此令牌需在主设备查看".into());
        }
        (Zeroizing::new(item.code), item.period, item.remaining)
    };
    // Hold the vault lock through the synchronous native write. A queued copy
    // cannot overtake a lock/delete or write after access has been revoked.
    write(&app, &code, epoch)?;
    vault.touch();
    Ok(Copied {
        code: code.to_string(),
        period,
        remaining,
    })
}
#[tauri::command]
pub async fn token_recovery_copy(
    app: AppHandle,
    s: State<'_, AppState>,
    id: String,
    recovery_id: String,
) -> Result<(), String> {
    let epoch = s.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let mut vault = s.vault()?;
    let token = vault
        .ensure()?
        .tokens
        .iter()
        .find(|t| t.id == id)
        .ok_or("令牌不存在")?;
    let code = token
        .recovery_codes
        .iter()
        .find(|c| c.id == recovery_id && !c.used)
        .ok_or("恢复码不可用")?;
    write(&app, &code.code, epoch)?;
    vault.touch();
    Ok(())
}
#[tauri::command]
pub async fn token_uri_copy(
    app: AppHandle,
    s: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let epoch = s.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let mut vault = s.vault()?;
    let token = vault
        .ensure()?
        .tokens
        .iter()
        .find(|t| t.id == id)
        .ok_or("令牌不存在")?;
    let uri = Zeroizing::new(crate::make_token_uri(token)?);
    write(&app, &uri, epoch)?;
    vault.touch();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_preserves_replacement_clipboard_and_retries_temporary_failures() {
        let now = Instant::now();
        let mut owned = Some(Owned {
            owner: "first-copy".into(),
            expires: Some(Deadline {
                monotonic: now,
                wall: SystemTime::now(),
            }),
        });
        // A failure must retain the original ownership so foreground retries
        // can clear it later; a replacement owner must never be cleared.
        assert!(expire_owned(&mut owned, now, |_| Err("temporarily busy".into())).is_err());
        assert_eq!(owned.as_ref().unwrap().owner, "first-copy");
        let mut board_owner = "other-application";
        expire_owned(&mut owned, now, |owner| {
            if owner == board_owner {
                board_owner = "empty";
                Ok(true)
            } else {
                Ok(false)
            }
        })
        .unwrap();
        assert!(owned.is_none());
        assert_eq!(board_owner, "other-application");
        owned = Some(Owned {
            owner: "new-copy".into(),
            expires: Some(Deadline {
                monotonic: now + Duration::from_secs(30),
                wall: SystemTime::now() + Duration::from_secs(30),
            }),
        });
        expire_owned(&mut owned, now, |_| {
            panic!("old timer attempted early cleanup")
        })
        .unwrap();
        expire_owned(&mut owned, now + Duration::from_secs(30), |owner| {
            assert_eq!(owner, "new-copy");
            Ok(true)
        })
        .unwrap();
        assert!(owned.is_none());
        owned = Some(Owned {
            owner: "no-expiry".into(),
            expires: None,
        });
        expire_owned(&mut owned, now + Duration::from_secs(1000), |_| {
            panic!("disabled cleanup ran")
        })
        .unwrap();
        assert!(owned.is_some());
    }
    #[test]
    fn cleanup_includes_time_spent_with_the_app_suspended() {
        let now = Instant::now();
        let mut owned = Some(Owned {
            owner: "expired-while-suspended".into(),
            expires: Some(Deadline {
                monotonic: now + Duration::from_secs(30),
                wall: SystemTime::UNIX_EPOCH,
            }),
        });
        expire_owned(&mut owned, now, |owner| {
            assert_eq!(owner, "expired-while-suspended");
            Ok(true)
        })
        .unwrap();
        assert!(owned.is_none());
    }
    #[test]
    fn cleanup_preferences_are_bounded() {
        for value in [0, 15, 30, 60, 120] {
            assert!(valid(value));
        }
        for value in [1, 10, 121, u64::MAX] {
            assert!(!valid(value));
        }
    }
}
