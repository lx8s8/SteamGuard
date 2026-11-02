//! No frontend commands. Rust retrieves the code after checking vault access.
#[cfg(mobile)]
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn steamguard_clipboard_write(bytes: *const u8, length: usize) -> i64;
    fn steamguard_clipboard_clear(owner: i64) -> i32;
}
#[cfg(mobile)]
#[derive(Serialize)]
struct Write<'a> {
    text: &'a str,
    seconds: u64,
}
#[cfg(mobile)]
#[derive(Serialize)]
struct Clear<'a> {
    owner: &'a str,
}
#[cfg(mobile)]
#[derive(Deserialize)]
pub struct Ownership {
    pub owner: String,
}
pub struct PrivateClipboard<R: Runtime> {
    owner: std::sync::Mutex<Option<String>>,
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}
impl<R: Runtime> PrivateClipboard<R> {
    pub fn write(
        &self,
        _app: &tauri::AppHandle<R>,
        text: &str,
        seconds: u64,
    ) -> Result<String, String> {
        if text.is_empty() || text.len() > 32768 || text.contains('\0') || seconds > 3600 {
            return Err("复制内容无效".into());
        }
        let value = self.write_native(_app, text, seconds)?;
        *self.owner.lock().map_err(|_| "复制标识不可用")? = Some(value.clone());
        Ok(value)
    }
    fn write_native(
        &self,
        _app: &tauri::AppHandle<R>,
        text: &str,
        seconds: u64,
    ) -> Result<String, String> {
        #[cfg(mobile)]
        {
            return self
                .handle
                .run_mobile_plugin::<Ownership>("write", Write { text, seconds })
                .map(|v| v.owner)
                .map_err(|_| "无法复制验证码".into());
        }
        #[cfg(target_os = "macos")]
        {
            let owner = unsafe { steamguard_clipboard_write(text.as_ptr(), text.len()) };
            if owner < 0 {
                return Err("无法复制验证码".into());
            }
            let _ = seconds;
            Ok(owner.to_string())
        }
        #[cfg(target_os = "windows")]
        {
            let window = _app.get_webview_window("main").ok_or("无法访问应用窗口")?;
            let hwnd = window.hwnd().map_err(|_| "无法访问应用窗口")?;
            let _ = seconds;
            windows::write(hwnd.0 as usize, text).map(|v| v.to_string())
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            let _ = (text, seconds);
            Err("此平台不支持原生复制".into())
        }
    }
    pub fn clear(&self, owner: &str) -> Result<bool, String> {
        #[cfg(mobile)]
        {
            return self
                .handle
                .run_mobile_plugin("clear", Clear { owner })
                .map_err(|_| "暂时无法清除剪贴板".into());
        }
        #[cfg(target_os = "macos")]
        {
            let owner = owner.parse::<i64>().map_err(|_| "复制标识无效")?;
            match unsafe { steamguard_clipboard_clear(owner) } {
                0 => Ok(false),
                1 => Ok(true),
                _ => Err("暂时无法清除剪贴板".into()),
            }
        }
        #[cfg(target_os = "windows")]
        {
            windows::clear(owner.parse::<u32>().map_err(|_| "复制标识无效")?)
        }
        #[cfg(not(any(mobile, target_os = "macos", target_os = "windows")))]
        {
            let _ = owner;
            Ok(false)
        }
    }
}
pub trait PrivateClipboardExt<R: Runtime>: Manager<R> {
    fn private_clipboard(&self) -> &PrivateClipboard<R> {
        self.state::<PrivateClipboard<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> PrivateClipboardExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_private_clipboard);
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("private-clipboard")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(
                "com.kasen.steamguard.clipboard",
                "PrivateClipboardPlugin",
            )?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_private_clipboard)?;
            #[cfg(not(mobile))]
            let _ = api;
            app.manage(PrivateClipboard::<R> {
                owner: std::sync::Mutex::new(None),
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _runtime: std::marker::PhantomData,
            });
            Ok(())
        })
        .on_event(|app, event| {
            // Mobile native calls need the main event loop to deliver their reply.
            // Do not wait for it from Exit after that event loop has stopped.
            #[cfg(not(mobile))]
            if matches!(event, tauri::RunEvent::Exit) {
                let clipboard = app.private_clipboard();
                if let Ok(owner) = clipboard.owner.lock() {
                    if let Some(owner) = owner.as_deref() {
                        let _ = clipboard.clear(owner);
                    }
                }
            }
            #[cfg(mobile)]
            let _ = (app, event);
        })
        .build()
}
