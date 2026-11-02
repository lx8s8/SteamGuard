//! Desktop-only tray and a deliberately small, read-only token popup.
use crate::{models::TokenView, quick_access::QuickAccess, AppState};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub const POPUP: &str = "quick-tokens";
pub fn allowed_invoke(label: &str, command: &str) -> bool {
    label != POPUP
        || matches!(
            command,
            "desktop_snapshot"
                | "desktop_copy"
                | "desktop_open_main"
                | "desktop_hide"
                | "vault_lock"
                | "quick_preview_enter"
        )
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    supported: bool,
    resident: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    initialized: bool,
    locked: bool,
    preview: bool,
    preview_enabled: bool,
    tokens: Vec<PopupToken>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PopupToken {
    id: String,
    name: String,
    issuer: String,
    icon: Option<String>,
    kind: String,
    code: String,
    remaining: u64,
    period: u64,
    hotp_read_only: bool,
}
impl From<TokenView> for PopupToken {
    fn from(t: TokenView) -> Self {
        Self {
            id: t.id,
            name: t.name,
            issuer: t.issuer,
            icon: t.icon,
            kind: t.kind,
            code: t.code,
            remaining: t.remaining,
            period: t.period,
            hotp_read_only: t.hotp_read_only,
        }
    }
}
fn snapshot(s: &AppState, q: &QuickAccess) -> Result<Snapshot, String> {
    let mut vault = s.vault()?;
    let initialized = vault.path.exists();
    let locked = vault.data.is_none();
    let preview = locked && q.active();
    let now = s.timestamp();
    let tokens = if let Some(data) = &vault.data {
        data.tokens
            .iter()
            .map(|t| {
                Ok(PopupToken {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    issuer: t.issuer.clone(),
                    icon: t.icon.clone(),
                    kind: t.kind.clone(),
                    code: if t.hotp_read_only {
                        String::new()
                    } else {
                        crate::otp::code(t, now)?
                    },
                    remaining: if t.kind == "hotp" {
                        0
                    } else {
                        t.period - now % t.period
                    },
                    period: t.period,
                    hotp_read_only: t.hotp_read_only,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else if preview {
        q.tokens(&vault.path, now)?
            .into_iter()
            .map(Into::into)
            .collect()
    } else {
        vec![]
    };
    // Reading the popup never extends the inactivity timeout.
    let preview_enabled = q.preferences()?.preview_enabled;
    if !locked {
        vault.ensure()?;
    }
    Ok(Snapshot {
        initialized,
        locked,
        preview,
        preview_enabled,
        tokens,
    })
}
#[tauri::command]
pub fn desktop_snapshot(s: State<AppState>, q: State<QuickAccess>) -> Result<Snapshot, String> {
    snapshot(&s, &q)
}
#[tauri::command]
pub fn desktop_settings(app: AppHandle) -> Settings {
    #[cfg(desktop)]
    if let Some(settings) = app.try_state::<platform::Controller>() {
        return Settings {
            supported: settings.supported.load(std::sync::atomic::Ordering::SeqCst),
            resident: settings.resident.load(std::sync::atomic::Ordering::SeqCst),
        };
    }
    let _ = app;
    Settings {
        supported: false,
        resident: false,
    }
}
#[tauri::command]
pub fn desktop_configure(
    app: AppHandle,
    s: State<AppState>,
    resident: bool,
) -> Result<Settings, String> {
    s.unlocked()?;
    #[cfg(desktop)]
    {
        let controller = app.state::<platform::Controller>();
        let _guard = controller.operation.lock().map_err(|_| "桌面设置不可用")?;
        let bytes = serde_json::to_vec(&platform::Preferences { resident })
            .map_err(|_| "无法保存桌面设置")?;
        let temporary = controller.path.with_extension("tmp");
        std::fs::write(&temporary, bytes)
            .and_then(|_| std::fs::rename(&temporary, &controller.path))
            .map_err(|_| "无法保存桌面设置")?;
        controller
            .resident
            .store(resident, std::sync::atomic::Ordering::SeqCst);
        Ok(desktop_settings(app.clone()))
    }
    #[cfg(mobile)]
    {
        let _ = (app, resident);
        Err("此设置仅适用于桌面端".into())
    }
}
#[tauri::command]
pub fn desktop_copy(
    app: AppHandle,
    s: State<AppState>,
    q: State<QuickAccess>,
    id: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let epoch = s.epoch.load(std::sync::atomic::Ordering::SeqCst);
        let mut v = s.vault()?;
        let code = if let Some(data) = &v.data {
            let token = data
                .tokens
                .iter()
                .find(|t| t.id == id)
                .ok_or("令牌已删除")?;
            if token.hotp_read_only {
                return Err("此 HOTP 由另一设备生成".into());
            }
            crate::otp::code(token, s.timestamp())?
        } else {
            let token = q
                .tokens(&v.path, s.timestamp())?
                .into_iter()
                .find(|t| t.id == id)
                .ok_or("令牌不可用，请先解锁")?;
            if token.hotp_read_only || token.code.is_empty() {
                return Err("此令牌需在主设备查看".into());
            }
            token.code
        };
        let code = zeroize::Zeroizing::new(code);
        if epoch != s.epoch.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("已锁定，请先解锁".into());
        }
        app.clipboard()
            .write_text(code.as_str())
            .map_err(|_| "无法复制验证码")?;
        v.touch();
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (app, s, q, id);
        Err("此功能仅适用于桌面端".into())
    }
}
#[tauri::command]
pub fn desktop_open_main(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        platform::open_main(&app)?;
    }
    let _ = app;
    Ok(())
}
#[tauri::command]
pub fn desktop_hide(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(POPUP) {
        window.hide().map_err(|_| "无法关闭窗口")?;
    }
    let _ = app;
    Ok(())
}

#[cfg(target_os = "macos")]
pub use platform::open_main;
#[cfg(desktop)]
pub use platform::{setup, window_event};

#[cfg(desktop)]
mod platform {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
    };
    #[derive(serde::Serialize, serde::Deserialize)]
    pub(super) struct Preferences {
        pub resident: bool,
    }
    pub(super) struct Controller {
        pub supported: AtomicBool,
        pub resident: AtomicBool,
        pub path: PathBuf,
        pub operation: Mutex<()>,
    }
    pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
        let path = app.path().app_data_dir()?.join("device-only/desktop.json");
        let resident = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Preferences>(&b).ok())
            .is_none_or(|p| p.resident);
        app.manage(Controller {
            path,
            resident: AtomicBool::new(resident),
            supported: AtomicBool::new(false),
            operation: Mutex::new(()),
        });
        if create(app).is_ok() {
            app.state::<Controller>()
                .supported
                .store(true, Ordering::SeqCst);
            // The same popup can also be opened from the native application menu.
            if let Some(menu) = app.menu() {
                let quick = MenuItem::with_id(
                    app,
                    "quick-tokens",
                    "快捷复制",
                    true,
                    Some("CmdOrCtrl+Shift+G"),
                )?;
                let submenu = Submenu::with_items(app, "令牌", true, &[&quick])?;
                menu.append(&submenu)?;
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == "quick-tokens" {
                        if let Some(tray) = app.tray_by_id("authenticator") {
                            if let Ok(Some(rect)) = tray.rect() {
                                let scale = app
                                    .primary_monitor()
                                    .ok()
                                    .flatten()
                                    .map_or(1.0, |m| m.scale_factor());
                                let position = rect.position.to_physical::<f64>(scale);
                                let _ = toggle(app, position, rect);
                            }
                        }
                    }
                });
            }
        }
        Ok(())
    }
    fn create(app: &tauri::App) -> tauri::Result<()> {
        WebviewWindowBuilder::new(app, POPUP, WebviewUrl::App("index.html?view=tray".into()))
            .title("SteamGuard")
            .theme(Some(tauri::Theme::Light))
            .inner_size(360.0, 520.0)
            .visible(false)
            .focused(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .build()?;
        let open = MenuItem::with_id(app, "open-main", "打开应用", true, None::<&str>)?;
        let lock = MenuItem::with_id(app, "lock-vault", "锁定", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let line = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&open, &lock, &line, &quit])?;
        TrayIconBuilder::with_id("authenticator")
            .icon(tauri::image::Image::from_bytes(
                if cfg!(target_os = "macos") {
                    include_bytes!("../icons/tray.png").as_slice()
                } else {
                    include_bytes!("../icons/32x32.png").as_slice()
                },
            )?)
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("SteamGuard")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open-main" => {
                    let _ = open_main(app);
                }
                "lock-vault" => {
                    let _ = crate::vault_lock(app.state::<AppState>(), app.state::<QuickAccess>());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    position,
                    rect,
                    ..
                } = event
                {
                    let _ = toggle(tray.app_handle(), position, rect);
                }
            })
            .build(app)?;
        Ok(())
    }
    pub fn open_main(app: &AppHandle) -> Result<(), String> {
        if let Some(popup) = app.get_webview_window(POPUP) {
            let _ = popup.hide();
        }
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
        window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .map_err(|_| "无法打开应用".into())
    }
    fn toggle(
        app: &AppHandle,
        point: PhysicalPosition<f64>,
        rect: tauri::Rect,
    ) -> Result<(), String> {
        let window = app.get_webview_window(POPUP).ok_or("快捷窗口不可用")?;
        if window.is_visible().unwrap_or(false) {
            return window.hide().map_err(|_| "无法关闭快捷窗口".into());
        }
        let monitor = app
            .available_monitors()
            .map_err(|_| "屏幕不可用")?
            .into_iter()
            .find(|m| {
                let p = m.position();
                let s = m.size();
                point.x >= p.x as f64
                    && point.y >= p.y as f64
                    && point.x < p.x as f64 + s.width as f64
                    && point.y < p.y as f64 + s.height as f64
            })
            .or_else(|| app.primary_monitor().ok().flatten())
            .ok_or("屏幕不可用")?;
        let scale = monitor.scale_factor();
        let count = app
            .state::<AppState>()
            .vault()
            .ok()
            .and_then(|v| v.data.as_ref().map(|d| d.tokens.len()))
            .unwrap_or(0);
        let logical_height = if count == 0 {
            190.0
        } else {
            (138.0 + count.min(8) as f64 * 70.0).min(640.0)
        };
        let area = monitor.work_area();
        let width = (360.0 * scale).min(area.size.width as f64);
        let height = (logical_height * scale).min(area.size.height as f64 - 16.0 * scale);
        let origin = rect.position.to_physical::<f64>(scale);
        let icon = rect.size.to_physical::<f64>(scale);
        let (x, y) = placement(
            (
                area.position.x as f64,
                area.position.y as f64,
                area.size.width as f64,
                area.size.height as f64,
            ),
            (origin.x + icon.width / 2.0, origin.y, icon.height),
            (width, height),
            scale,
        );
        window
            .set_size(LogicalSize::new(width / scale, height / scale))
            .and_then(|_| window.set_position(PhysicalPosition::new(x as i32, y as i32)))
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .map_err(|_| "无法打开快捷窗口".into())
    }
    pub(super) fn placement(
        area: (f64, f64, f64, f64),
        icon: (f64, f64, f64),
        panel: (f64, f64),
        scale: f64,
    ) -> (f64, f64) {
        let (left, top, width, height) = area;
        let x = (icon.0 - panel.0 / 2.0).clamp(left, (left + width - panel.0).max(left));
        let y = if icon.1 > top + height / 2.0 {
            icon.1 - panel.1 - 6.0 * scale
        } else {
            icon.1 + icon.2 + 6.0 * scale
        };
        (x, y.clamp(top, (top + height - panel.1).max(top)))
    }
    pub fn window_event(window: &Window, event: &WindowEvent) {
        if window.label() == POPUP {
            match event {
                WindowEvent::Focused(false) => {
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        } else if window.label() == "main" {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let controller = window.state::<Controller>();
                if controller.supported.load(Ordering::SeqCst)
                    && controller.resident.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                } else {
                    window.app_handle().exit(0);
                }
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn popup_stays_inside_negative_and_high_dpi_monitor_bounds() {
            assert_eq!(
                placement(
                    (-1920.0, 0.0, 1920.0, 1040.0),
                    (-8.0, 1040.0, 40.0),
                    (360.0, 500.0),
                    1.0
                ),
                (-360.0, 534.0)
            );
            assert_eq!(
                placement(
                    (0.0, 50.0, 3000.0, 1900.0),
                    (2980.0, 0.0, 50.0),
                    (720.0, 1000.0),
                    2.0
                ),
                (2280.0, 62.0)
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_cannot_invoke_import_steam_or_export_commands() {
        assert!(allowed_invoke(POPUP, "desktop_copy"));
        assert!(allowed_invoke("main", "import_commit"));
        for command in [
            "import_commit",
            "token_uri",
            "steam_remove_authenticator",
            "sync_connect",
            "token_update",
        ] {
            assert!(!allowed_invoke(POPUP, command));
        }
    }
}
