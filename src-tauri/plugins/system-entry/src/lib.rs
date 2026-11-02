//! System entries contain selected labels and IDs only, never OTP material.
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub label: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub enabled: bool,
    pub entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub supported: bool,
    pub shared_available: bool,
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Pending {
    uri: Option<String>,
}
pub struct SystemEntry<R: Runtime> {
    pending: Mutex<Option<(Instant, String)>>,
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}
impl<R: Runtime> SystemEntry<R> {
    pub async fn availability(&self) -> Result<Availability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("availability", ())
                .await
                .map_err(|_| "无法读取系统快捷入口状态".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(Availability {
                supported: false,
                shared_available: false,
            })
        }
    }
    pub async fn publish(&self, snapshot: &Snapshot) -> Result<(), String> {
        if snapshot.entries.len() > 4
            || snapshot.entries.iter().any(|e| {
                e.id.len() > 64
                    || e.label.chars().count() > 80
                    || e.label.chars().any(char::is_control)
            })
        {
            return Err("快捷入口数据无效".into());
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async::<()>("publish", snapshot)
                .await
                .map_err(|_| "无法更新系统快捷入口，请重试".into())
        }
        #[cfg(not(mobile))]
        {
            let _ = snapshot;
            Ok(())
        }
    }
    pub async fn take(&self) -> Result<Option<String>, String> {
        if let Some((date, uri)) = self
            .pending
            .lock()
            .map_err(|_| "快捷入口状态不可用")?
            .take()
        {
            if date.elapsed() < Duration::from_secs(120) {
                return Ok(Some(uri));
            }
        }
        #[cfg(mobile)]
        {
            let pending: Pending = self
                .handle
                .run_mobile_plugin_async("take", ())
                .await
                .map_err(|_| "无法读取系统快捷入口")?;
            Ok(pending.uri.filter(|s| s.len() <= 1024))
        }
        #[cfg(not(mobile))]
        {
            Ok(None)
        }
    }
}
pub trait SystemEntryExt<R: Runtime>: Manager<R> {
    fn system_entry(&self) -> &SystemEntry<R> {
        self.state::<SystemEntry<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> SystemEntryExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_system_entry);
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-entry")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api
                .register_android_plugin("com.kasen.steamguard.systementry", "SystemEntryPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_system_entry)?;
            #[cfg(not(mobile))]
            let _ = api;
            app.manage(SystemEntry::<R> {
                pending: Mutex::new(None),
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _runtime: std::marker::PhantomData,
            });
            Ok(())
        })
        .on_event(|app, event| {
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls.iter().filter(|u| {
                    u.scheme() == "steamguard"
                        && u.host_str() == Some("entry")
                        && u.as_str().len() <= 1024
                }) {
                    if let Ok(mut p) = app.system_entry().pending.lock() {
                        *p = Some((Instant::now(), url.to_string()));
                    }
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (app, event);
        })
        .build()
}
