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
                | "desktop_codes"
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
    shortcut: String,
    shortcut_registered: bool,
    autostart: bool,
    autostart_supported: bool,
}
#[derive(serde::Deserialize)]
pub struct Labels {
    open: String,
    lock: String,
    quit: String,
    tokens: String,
    quick: String,
}
#[tauri::command]
pub fn desktop_localize(app: AppHandle, labels: Labels) -> Result<(), String> {
    if [
        &labels.open,
        &labels.lock,
        &labels.quit,
        &labels.tokens,
        &labels.quick,
    ]
    .iter()
    .any(|s| s.is_empty() || s.len() > 256 || s.chars().any(char::is_control))
    {
        return Err("菜单文字无效".into());
    }
    #[cfg(desktop)]
    {
        platform::localize(&app, labels)?;
    }
    let _ = app;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: String,
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
        let mut sorted = data.tokens.iter().collect::<Vec<_>>();
        sorted.sort_by_key(|t| (!t.pinned, t.sort_order));
        sorted
            .into_iter()
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
        let mut tokens = q.tokens(&vault.path, now)?;
        tokens.sort_by_key(|t| !t.pinned);
        tokens.into_iter().map(Into::into).collect()
    } else {
        vec![]
    };
    // Reading the popup never extends the inactivity timeout.
    let revision = if !locked {
        vault.revision.clone()
    } else if preview {
        q.codes(&vault.path, now)?.revision
    } else {
        String::new()
    };
    let preview_enabled = q.preferences()?.preview_enabled;
    if !locked {
        vault.ensure()?;
    }
    Ok(Snapshot {
        revision,
        initialized,
        locked,
        preview,
        preview_enabled,
        tokens,
    })
}
#[tauri::command]
pub fn desktop_codes(
    s: State<AppState>,
    q: State<QuickAccess>,
) -> Result<crate::token_commands::CodeSnapshot, String> {
    crate::token_commands::codes(&s, &q)
}
#[tauri::command]
pub fn desktop_snapshot(s: State<AppState>, q: State<QuickAccess>) -> Result<Snapshot, String> {
    snapshot(&s, &q)
}
#[tauri::command]
pub fn desktop_settings(app: AppHandle) -> Settings {
    #[cfg(desktop)]
    if let Some(controller) = app.try_state::<platform::Controller>() {
        use tauri_plugin_autostart::ManagerExt;
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let shortcut = controller
            .operation
            .lock()
            .map(|p| p.shortcut.clone())
            .unwrap_or_default();
        let autostart = app.autolaunch().is_enabled();
        return Settings {
            supported: controller
                .supported
                .load(std::sync::atomic::Ordering::SeqCst),
            resident: controller
                .resident
                .load(std::sync::atomic::Ordering::SeqCst),
            shortcut_registered: !shortcut.is_empty()
                && app.global_shortcut().is_registered(shortcut.as_str()),
            shortcut,
            autostart_supported: autostart.is_ok(),
            autostart: autostart.unwrap_or(false),
        };
    }
    let _ = app;
    Settings {
        supported: false,
        resident: false,
        shortcut: String::new(),
        shortcut_registered: false,
        autostart: false,
        autostart_supported: false,
    }
}
#[tauri::command]
pub fn desktop_configure(
    app: AppHandle,
    s: State<AppState>,
    resident: Option<bool>,
    shortcut: Option<String>,
    autostart: Option<bool>,
) -> Result<Settings, String> {
    s.unlocked()?;
    #[cfg(desktop)]
    {
        platform::configure(&app, resident, shortcut, autostart)?;
        Ok(desktop_settings(app.clone()))
    }
    #[cfg(mobile)]
    {
        let _ = (app, resident, shortcut, autostart);
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
    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    #[serde(default)]
    pub(super) struct Preferences {
        pub resident: bool,
        pub shortcut: String,
    }
    impl Default for Preferences {
        fn default() -> Self {
            Self {
                resident: true,
                shortcut: "CmdOrCtrl+Shift+G".into(),
            }
        }
    }
    #[derive(Default)]
    struct Menus {
        open: Option<MenuItem<tauri::Wry>>,
        lock: Option<MenuItem<tauri::Wry>>,
        quit: Option<MenuItem<tauri::Wry>>,
        quick: Option<MenuItem<tauri::Wry>>,
        tokens: Option<Submenu<tauri::Wry>>,
    }
    pub(super) struct Controller {
        pub supported: AtomicBool,
        pub resident: AtomicBool,
        pub path: PathBuf,
        pub operation: Mutex<Preferences>,
        menus: Mutex<Menus>,
    }
    pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
        let path = app.path().app_data_dir()?.join("device-only/desktop.json");
        let preferences = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Preferences>(&b).ok())
            .unwrap_or_default();
        let shortcut = preferences.shortcut.clone();
        let resident = preferences.resident;
        app.manage(Controller {
            path,
            resident: AtomicBool::new(resident),
            supported: AtomicBool::new(false),
            operation: Mutex::new(preferences),
            menus: Mutex::new(Menus::default()),
        });
        if create(app).is_ok() {
            app.state::<Controller>()
                .supported
                .store(true, Ordering::SeqCst);
            if !shortcut.is_empty() {
                let _ = register_shortcut(app.handle(), &shortcut);
            }
            if std::env::args().any(|a| a == "--autostart") && resident {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            // The same popup can also be opened from the native application menu.
            if let Some(menu) = app.menu() {
                let quick = MenuItem::with_id(app, "quick-tokens", "快捷复制", true, None::<&str>)?;
                let submenu = Submenu::with_items(app, "令牌", true, &[&quick])?;
                menu.append(&submenu)?;
                if let Ok(mut menus) = app.state::<Controller>().menus.lock() {
                    menus.quick = Some(quick);
                    menus.tokens = Some(submenu);
                }
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == "quick-tokens" {
                        let _ = toggle_from_shortcut(app);
                    }
                });
            }
        }
        Ok(())
    }
    pub(super) fn localize(app: &AppHandle, labels: Labels) -> Result<(), String> {
        let controller = app.state::<Controller>();
        let menus = controller.menus.lock().map_err(|_| "菜单不可用")?;
        for (item, text) in [
            (&menus.open, &labels.open),
            (&menus.lock, &labels.lock),
            (&menus.quit, &labels.quit),
            (&menus.quick, &labels.quick),
        ] {
            if let Some(item) = item {
                item.set_text(text).map_err(|_| "无法更新菜单")?;
            }
        }
        if let Some(tokens) = &menus.tokens {
            tokens.set_text(labels.tokens).map_err(|_| "无法更新菜单")?;
        }
        Ok(())
    }
    fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        app.global_shortcut()
            .on_shortcut(shortcut, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_from_shortcut(app);
                }
            })
            .map_err(|_| "快捷键无效或已被其他应用占用".to_string())
    }
    fn toggle_from_shortcut(app: &AppHandle) -> Result<(), String> {
        if let Some(tray) = app.tray_by_id("authenticator") {
            if let Ok(Some(rect)) = tray.rect() {
                let scale = app
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map_or(1.0, |m| m.scale_factor());
                return toggle(app, rect.position.to_physical::<f64>(scale), rect);
            }
        }
        open_main(app)
    }
    pub(super) fn configure(
        app: &AppHandle,
        resident: Option<bool>,
        shortcut: Option<String>,
        autostart: Option<bool>,
    ) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let controller = app.state::<Controller>();
        let mut old = controller.operation.lock().map_err(|_| "桌面设置不可用")?;
        let mut next = old.clone();
        if let Some(resident) = resident {
            next.resident = resident;
        }
        if let Some(shortcut) = shortcut {
            next.shortcut = shortcut.trim().to_string();
            if next.shortcut.len() > 128 {
                return Err("快捷键无效或已被其他应用占用".into());
            }
        }
        let previous_autostart = if autostart.is_some() {
            Some(
                app.autolaunch()
                    .is_enabled()
                    .map_err(|_| "无法读取开机启动设置")?,
            )
        } else {
            None
        };
        let changed = next.shortcut != old.shortcut;
        let old_registered =
            !old.shortcut.is_empty() && app.global_shortcut().is_registered(old.shortcut.as_str());
        if changed && !next.shortcut.is_empty() {
            register_shortcut(app, &next.shortcut)?;
        }
        let result = (|| {
            if let Some(enabled) = autostart {
                if enabled {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                }
                .map_err(|_| "无法修改开机启动设置")?;
            }
            let bytes = serde_json::to_vec(&next).map_err(|_| "无法保存桌面设置")?;
            let temporary = controller.path.with_extension("tmp");
            std::fs::write(&temporary, bytes)
                .and_then(|_| std::fs::rename(&temporary, &controller.path))
                .map_err(|_| "无法保存桌面设置")?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            if changed && !next.shortcut.is_empty() {
                let _ = app.global_shortcut().unregister(next.shortcut.as_str());
            }
            if autostart.is_some() {
                if previous_autostart == Some(true) {
                    let _ = app.autolaunch().enable();
                } else {
                    let _ = app.autolaunch().disable();
                }
            }
            return Err(error);
        }
        if changed && old_registered {
            let _ = app.global_shortcut().unregister(old.shortcut.as_str());
        }
        controller.resident.store(next.resident, Ordering::SeqCst);
        *old = next;
        Ok(())
    }
    fn create(app: &tauri::App) -> tauri::Result<()> {
        WebviewWindowBuilder::new(app, POPUP, WebviewUrl::App("index.html?view=tray".into()))
            .title("SteamGuard")
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
        if let Ok(mut menus) = app.state::<Controller>().menus.lock() {
            menus.open = Some(open);
            menus.lock = Some(lock);
            menus.quit = Some(quit);
        }
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
