//! Opt-in system metadata and bounded navigation requests. These APIs never
//! export an OTP, key, note, recovery code, or authentication session.
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_system_entry::{Entry, Snapshot, SystemEntryExt};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    selected_ids: Vec<String>,
}
impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.selected_ids.len() > 4 {
            return Err("最多选择 4 个快捷令牌".into());
        }
        let mut seen = std::collections::HashSet::new();
        if self
            .selected_ids
            .iter()
            .any(|id| uuid::Uuid::parse_str(id).is_err() || !seen.insert(id))
        {
            return Err("快捷入口令牌无效".into());
        }
        Ok(())
    }
}
pub struct Controller {
    path: PathBuf,
    config: Mutex<Config>,
    gate: tokio::sync::Mutex<()>,
}
pub fn initialize(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app
        .path()
        .app_data_dir()?
        .join("device-only/system-entries.json");
    let config = fs::read(&path)
        .ok()
        .filter(|b| b.len() <= 8192)
        .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
        .filter(|c| c.validate().is_ok())
        .unwrap_or_default();
    let disabled = !config.enabled;
    app.manage(Controller {
        path,
        config: Mutex::new(config),
        gate: tokio::sync::Mutex::new(()),
    });
    if disabled {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let control = app.state::<Controller>();
            let _gate = control.gate.lock().await;
            let enabled = control
                .config
                .lock()
                .map(|config| config.enabled)
                .unwrap_or(false);
            if !enabled {
                let _ = app
                    .system_entry()
                    .publish(&Snapshot {
                        enabled: false,
                        entries: vec![],
                    })
                    .await;
            }
        });
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    shared_available: bool,
    enabled: bool,
    selected_ids: Vec<String>,
}
async fn status(app: &AppHandle) -> Result<Status, String> {
    let available = app.system_entry().availability().await?;
    let c = app
        .state::<Controller>()
        .config
        .lock()
        .map_err(|_| "快捷入口状态不可用")?
        .clone();
    Ok(Status {
        supported: available.supported,
        shared_available: available.shared_available,
        enabled: c.enabled,
        selected_ids: c.selected_ids,
    })
}
#[tauri::command]
pub async fn system_entries_status(app: AppHandle) -> Result<Status, String> {
    status(&app).await
}
fn write(path: &Path, config: &Config) -> Result<(), String> {
    use std::io::Write;
    let directory = path.parent().ok_or("快捷入口配置目录无效")?;
    fs::create_dir_all(directory).map_err(|_| "无法保存快捷入口设置")?;
    let temporary = directory.join(format!(".system-entry-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法保存快捷入口设置")?;
        file.write_all(&serde_json::to_vec(config).map_err(|_| "无法保存快捷入口设置")?)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存快捷入口设置")?;
        fs::rename(&temporary, path).map_err(|_| "无法保存快捷入口设置")
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(str::to_owned)
}
fn snapshot(s: &AppState, config: &Config) -> Result<Snapshot, String> {
    let mut vault = s.vault()?;
    let data = vault.ensure()?;
    if config.enabled
        && config
            .selected_ids
            .iter()
            .any(|id| !data.tokens.iter().any(|t| &t.id == id))
    {
        return Err("快捷入口中的令牌已移除，请重新选择".into());
    }
    let entries = if config.enabled {
        config
            .selected_ids
            .iter()
            .filter_map(|id| data.tokens.iter().find(|t| &t.id == id))
            .map(|token| {
                let label = token
                    .name
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(80)
                    .collect::<String>();
                Entry {
                    id: token.id.clone(),
                    label: if label.trim().is_empty() {
                        "SteamGuard".into()
                    } else {
                        label
                    },
                }
            })
            .collect()
    } else {
        vec![]
    };
    Ok(Snapshot {
        enabled: config.enabled,
        entries,
    })
}
#[tauri::command]
pub async fn system_entries_configure(
    app: AppHandle,
    s: State<'_, AppState>,
    enabled: bool,
    selected_ids: Vec<String>,
) -> Result<Status, String> {
    s.unlocked()?;
    if !app.system_entry().availability().await?.supported {
        return Err("此功能仅适用于手机端".into());
    }
    let control = app.state::<Controller>();
    let _gate = control.gate.lock().await;
    let config = Config {
        enabled,
        selected_ids,
    };
    config.validate()?;
    let epoch = s.epoch.load(Ordering::SeqCst);
    let value = snapshot(&s, &config)?;
    // Persist the user's choice before publication. In particular a failed OS
    // refresh cannot leave a disabled feature enabled again on the next launch.
    write(&control.path, &config)?;
    *control.config.lock().map_err(|_| "快捷入口状态不可用")? = config;
    app.system_entry().publish(&value).await?;
    if s.epoch.load(Ordering::SeqCst) != epoch {
        return Err("保险库已锁定，请重新打开设置".into());
    }
    status(&app).await
}
pub async fn refresh(app: &AppHandle, s: &AppState) -> Result<(), String> {
    let control = app.state::<Controller>();
    let _gate = control.gate.lock().await;
    let mut config = control
        .config
        .lock()
        .map_err(|_| "快捷入口状态不可用")?
        .clone();
    if !config.enabled {
        return Ok(());
    }
    {
        let vault = s.vault()?;
        let Some(data) = vault.data.as_ref() else {
            return Ok(());
        };
        config
            .selected_ids
            .retain(|id| data.tokens.iter().any(|t| &t.id == id));
    }
    let value = snapshot(s, &config)?;
    if control
        .config
        .lock()
        .map_err(|_| "快捷入口状态不可用")?
        .selected_ids
        != config.selected_ids
    {
        write(&control.path, &config)?;
        *control.config.lock().map_err(|_| "快捷入口状态不可用")? = config;
    }
    app.system_entry().publish(&value).await
}
#[tauri::command]
pub async fn system_entries_refresh(app: AppHandle, s: State<'_, AppState>) -> Result<(), String> {
    refresh(&app, &s).await
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action: String,
    pub id: Option<String>,
}
fn parse_action(raw: &str) -> Option<Action> {
    if raw.len() > 1024 {
        return None;
    }
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "steamguard"
        || u.host_str() != Some("entry")
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return None;
    }
    let action = match u.path() {
        "/open" => "open",
        "/copy" => "copy",
        _ => return None,
    };
    let pairs = u.query_pairs().collect::<Vec<_>>();
    if pairs.len() > 1 || pairs.iter().any(|(k, _)| k != "id") {
        return None;
    }
    let id = pairs
        .first()
        .map(|(_, id)| uuid::Uuid::parse_str(id).map(|u| u.to_string()))
        .transpose()
        .ok()?;
    if action == "copy" && id.is_none() {
        return None;
    }
    Some(Action {
        action: action.into(),
        id,
    })
}
#[tauri::command]
pub async fn system_entry_take(
    app: AppHandle,
    s: State<'_, AppState>,
) -> Result<Option<Action>, String> {
    // Locked/preview state cannot consume or execute a request. Root UI will
    // focus this token only; Copy still requires an explicit user gesture.
    s.unlocked()?;
    let epoch = s.epoch.load(Ordering::SeqCst);
    let Some(raw) = app.system_entry().take().await? else {
        return Ok(None);
    };
    let Some(action) = parse_action(&raw) else {
        return Ok(None);
    };
    let config = app
        .state::<Controller>()
        .config
        .lock()
        .map_err(|_| "快捷入口状态不可用")?
        .clone();
    let mut v = s.vault()?;
    let d = v.ensure()?;
    if s.epoch.load(Ordering::SeqCst) != epoch {
        return Ok(None);
    }
    if let Some(id) = &action.id {
        if !config.enabled
            || !config.selected_ids.contains(id)
            || !d.tokens.iter().any(|t| &t.id == id)
        {
            return Ok(None);
        }
    }
    Ok(Some(action))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entry_urls_only_navigate_to_valid_selected_token_ids() {
        let id = "2971a71b-042c-4f28-b8ae-3c02b713f0f0";
        assert_eq!(
            parse_action(&format!("steamguard://entry/copy?id={id}")),
            Some(Action {
                action: "copy".into(),
                id: Some(id.into())
            })
        );
        assert_eq!(
            parse_action("steamguard://entry/open"),
            Some(Action {
                action: "open".into(),
                id: None
            })
        );
        for raw in ["https://entry/open","steamguard://other/open","steamguard://entry/approve","steamguard://entry/copy","steamguard://entry/copy?id=secret","steamguard://user@entry/open","steamguard://entry/open#fragment","steamguard://entry/open?id=2971a71b-042c-4f28-b8ae-3c02b713f0f0&id=2971a71b-042c-4f28-b8ae-3c02b713f0f0","steamguard://entry/open?code=123456"] {assert!(parse_action(raw).is_none(),"{raw}");}
    }
    #[test]
    fn configuration_is_bounded_and_snapshot_schema_has_no_sensitive_fields() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(Config {
            enabled: true,
            selected_ids: vec![id.clone(), id.clone()]
        }
        .validate()
        .is_err());
        assert!(Config {
            enabled: true,
            selected_ids: vec![id; 5]
        }
        .validate()
        .is_err());
        assert!(Config {
            enabled: true,
            selected_ids: vec!["../vault".into()]
        }
        .validate()
        .is_err());
        let json = serde_json::to_value(Snapshot {
            enabled: true,
            entries: vec![Entry {
                id: uuid::Uuid::new_v4().to_string(),
                label: "Synthetic account".into(),
            }],
        })
        .unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["enabled", "entries"]
        );
        assert_eq!(
            json["entries"][0]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["id", "label"]
        );
    }
}
