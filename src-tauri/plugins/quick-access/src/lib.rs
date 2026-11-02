//! Fixed-purpose native secure storage. No raw storage commands are exposed to JS.
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "windows", test))]
mod sealed;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
use macos::Desktop;
#[cfg(target_os = "windows")]
use windows::Desktop;

fn validate_slot(slot: &str) -> Result<(), String> {
    if matches!(slot, "preview" | "biometric") {
        Ok(())
    } else {
        Err("未知的解锁选项".into())
    }
}
fn validate_data(data: &str) -> Result<(), String> {
    if data.is_empty() || data.len() > 16384 {
        Err("设备密钥内容无效".into())
    } else {
        Ok(())
    }
}
#[cfg(mobile)]
use tauri::plugin::PluginHandle;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub supported: bool,
    pub biometric_available: bool,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBackupStatus {
    pub supported: bool,
    pub configured: bool,
    pub label: String,
    pub error: Option<String>,
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest<'a> {
    name: &'a str,
    data: String,
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    slot: &'a str,
    data: Option<&'a str>,
    reason: String,
    fallback: String,
}
#[derive(Clone)]
#[cfg_attr(not(mobile), allow(dead_code))]
struct Prompt {
    reason: String,
    fallback: String,
}
impl Default for Prompt {
    fn default() -> Self {
        Self {
            reason: "Unlock SteamGuard".into(),
            fallback: "Use master password".into(),
        }
    }
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Response {
    data: String,
}

pub struct SecureAccess<R: Runtime> {
    prompt: std::sync::Mutex<Prompt>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    desktop: Desktop,
    #[cfg(mobile)]
    handle: PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}
impl<R: Runtime> SecureAccess<R> {
    pub async fn appearance(&self, theme: &str) -> Result<(), String> {
        if !matches!(theme, "system" | "light" | "dark") {
            return Err("主题无效".into());
        }
        #[cfg(mobile)]
        {
            #[derive(Serialize)]
            struct Appearance<'a> {
                theme: &'a str,
            }
            self.handle
                .run_mobile_plugin_async::<()>("appearance", Appearance { theme })
                .await
                .map_err(|_| "无法设置主题".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(())
        }
    }

    pub fn localize(&self, reason: &str, fallback: &str) -> Result<(), String> {
        if reason.is_empty()
            || fallback.is_empty()
            || reason.chars().count() > 200
            || fallback.chars().count() > 80
            || reason.chars().chain(fallback.chars()).any(char::is_control)
        {
            return Err("设备认证提示文本无效".into());
        }
        *self.prompt.lock().map_err(|_| "设备认证提示暂不可用")? = Prompt {
            reason: reason.into(),
            fallback: fallback.into(),
        };
        Ok(())
    }
    #[cfg(mobile)]
    fn request<'a>(&self, slot: &'a str, data: Option<&'a str>) -> Request<'a> {
        let prompt = self.prompt.lock().map(|p| p.clone()).unwrap_or_default();
        Request {
            slot,
            data,
            reason: prompt.reason,
            fallback: prompt.fallback,
        }
    }

    pub fn external_backup_status(&self) -> Result<ExternalBackupStatus, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("externalBackupStatus", ())
                .map_err(|_| "无法读取外部备份目录授权".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(ExternalBackupStatus::default())
        }
    }
    pub async fn external_backup_status_async(&self) -> Result<ExternalBackupStatus, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("externalBackupStatus", ())
                .await
                .map_err(|_| "无法读取外部备份目录授权".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(ExternalBackupStatus::default())
        }
    }
    pub async fn external_backup_choose(&self) -> Result<ExternalBackupStatus, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("externalBackupChoose", ())
                .await
                .map_err(|_| "未能选择外部备份目录，请重新授权文件夹访问".into())
        }
        #[cfg(not(mobile))]
        {
            Err("请使用桌面备份目录设置".into())
        }
    }
    pub async fn external_backup_clear(&self) -> Result<ExternalBackupStatus, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async("externalBackupClear", ())
                .await
                .map_err(|_| "无法重置外部备份目录".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(ExternalBackupStatus::default())
        }
    }
    pub fn external_backup_snapshot(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        #[cfg(mobile)]
        {
            use base64::Engine;
            self.handle
                .run_mobile_plugin::<()>(
                    "externalBackupSnapshot",
                    SnapshotRequest {
                        name,
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    },
                )
                .map_err(|_| "外部备份未写入，请检查目录授权和可用空间；本地快照已保留".into())
        }
        #[cfg(not(mobile))]
        {
            let _ = (name, bytes);
            Ok(())
        }
    }

    pub fn configure_backup(&self, directory: &str) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        {
            #[derive(Serialize)]
            struct BackupPolicy<'a> {
                directory: &'a str,
            }
            self.handle
                .run_mobile_plugin::<()>("configureBackup", BackupPolicy { directory })
                .map_err(|_| "无法配置系统备份".into())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = directory;
            Ok(())
        }
    }
    pub fn availability(&self) -> Result<Availability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("availability", ())
                .map_err(|_| "无法读取设备认证状态".into())
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.desktop.availability()
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            Ok(Availability::default())
        }
    }
    pub fn write(&self, slot: &str, data: &str) -> Result<(), String> {
        validate_slot(slot)?;
        validate_data(data)?;
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>("write", self.request(slot, Some(data)))
                .map_err(|_| {
                    "未能启用快捷访问，请确认设备已设置指纹或 Face ID，并完成系统验证".into()
                })
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.desktop.write(slot, data)
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            Err("此系统暂不支持快捷访问".into())
        }
    }
    pub fn read(&self, slot: &str) -> Result<String, String> {
        validate_slot(slot)?;
        #[cfg(mobile)]
        {
            self.handle.run_mobile_plugin::<Response>("read", self.request(slot, None)).map(|v| v.data).map_err(|_| "验证已取消或设备密钥不可用，请使用主密码解锁；更改系统指纹或 Face ID 后需重新启用".into())
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let prompt = self
                .prompt
                .lock()
                .map_err(|_| "设备认证提示暂不可用")?
                .clone();
            self.desktop.read(slot, &prompt)
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            Err("此系统暂不支持快捷访问".into())
        }
    }
    pub fn remove(&self, slot: &str) -> Result<(), String> {
        validate_slot(slot)?;
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>("remove", self.request(slot, None))
                .map_err(|_| "无法清除设备密钥，请重试".into())
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.desktop.remove(slot)
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            Ok(())
        }
    }
}
pub trait SecureAccessExt<R: Runtime>: Manager<R> {
    fn secure_access(&self) -> &SecureAccess<R> {
        self.state::<SecureAccess<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> SecureAccessExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_quick_access);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("quick-access")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api
                .register_android_plugin("com.kasen.steamguard.quickaccess", "QuickAccessPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_quick_access)?;
            app.manage(SecureAccess::<R> {
                prompt: std::sync::Mutex::new(Prompt::default()),
                #[cfg(target_os = "macos")]
                desktop: Desktop::new(&app.config().identifier)?,
                #[cfg(target_os = "windows")]
                desktop: Desktop::new(
                    &app.config().identifier,
                    app.path().app_local_data_dir()?.join("device-only"),
                )?,
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _runtime: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
