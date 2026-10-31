//! Fixed-purpose native secure storage. No raw storage commands are exposed to JS.
use serde::{Deserialize, Serialize};
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
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    slot: &'a str,
    data: Option<&'a str>,
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Response {
    data: String,
}

pub struct SecureAccess<R: Runtime> {
    #[cfg(mobile)]
    handle: PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}
impl<R: Runtime> SecureAccess<R> {
    pub fn availability(&self) -> Result<Availability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("availability", ())
                .map_err(|_| "无法读取设备认证状态".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(Availability {
                label: "指纹 / Face ID".into(),
                ..Default::default()
            })
        }
    }
    pub fn write(&self, slot: &str, data: &str) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>(
                    "write",
                    Request {
                        slot,
                        data: Some(data),
                    },
                )
                .map_err(|_| {
                    "未能启用快捷访问，请确认设备已设置指纹或 Face ID，并完成系统验证".into()
                })
        }
        #[cfg(not(mobile))]
        {
            let _ = (slot, data);
            Err("快捷访问目前支持 Android 和 iOS".into())
        }
    }
    pub fn read(&self, slot: &str) -> Result<String, String> {
        #[cfg(mobile)]
        {
            self.handle.run_mobile_plugin::<Response>("read", Request { slot, data: None }).map(|v| v.data).map_err(|_| "验证已取消或设备密钥不可用，请使用主密码解锁；更改系统指纹或 Face ID 后需重新启用".into())
        }
        #[cfg(not(mobile))]
        {
            let _ = slot;
            Err("快捷访问目前支持 Android 和 iOS".into())
        }
    }
    pub fn remove(&self, slot: &str) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>("remove", Request { slot, data: None })
                .map_err(|_| "无法清除设备密钥，请重试".into())
        }
        #[cfg(not(mobile))]
        {
            let _ = slot;
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
            let handle =
                _api.register_android_plugin("dev.steamguard.quickaccess", "QuickAccessPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_quick_access)?;
            app.manage(SecureAccess::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _runtime: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
