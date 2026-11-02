//! Updates use GitHub Releases. Executable installation requires the embedded signature key.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

const RELEASES: &str = "https://github.com/lx8s8/SteamGuard/releases/latest";
const API: &str = "https://api.github.com/repos/lx8s8/SteamGuard/releases/latest";
#[derive(Default)]
pub struct Controller {
    #[cfg(desktop)]
    pending: Mutex<Option<(Instant, tauri_plugin_updater::Update)>>,
    installing: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    can_install: bool,
    notes: String,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}
fn release_version(tag: &str) -> Result<semver::Version, String> {
    let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| "更新版本信息无效")?;
    if !version.pre.is_empty() {
        return Err("更新版本信息无效".into());
    }
    Ok(version)
}
fn trusted_asset(value: &str, version: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .strip_prefix(&format!("/lx8s8/SteamGuard/releases/download/v{version}/"))
            .is_some_and(|name| !name.is_empty() && !name.contains('/') && !name.contains('%'))
}
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    control: State<'_, Controller>,
) -> Result<UpdateInfo, String> {
    if control.installing.load(Ordering::SeqCst) {
        return Err("正在安装更新".into());
    }
    #[cfg(desktop)]
    {
        control.pending.lock().map_err(|_| "更新状态不可用")?.take();
    }
    let current_version = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .https_only(true)
        .user_agent("SteamGuard update checker")
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法检查更新")?;
    let response = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接更新服务器，请稍后重试")?;
    if !response.status().is_success() {
        return Err("无法检查更新，请稍后重试".into());
    }
    if response.content_length().is_some_and(|n| n > 1_048_576) {
        return Err("更新信息过大".into());
    }
    let mut response = response;
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "无法读取更新信息")? {
        if data.len() + chunk.len() > 1_048_576 {
            return Err("更新信息过大".into());
        }
        data.extend_from_slice(&chunk);
    }
    let release: Release = serde_json::from_slice(&data).map_err(|_| "更新信息无效")?;
    let latest = release_version(&release.tag_name)?;
    if release.draft || release.prerelease {
        return Err("更新版本信息无效".into());
    }
    let available = latest > release_version(&current_version)?;
    let mut can_install = false;
    #[cfg(desktop)]
    if available
        && release.assets.iter().any(|asset| {
            asset.name == "latest.json"
                && trusted_asset(&asset.browser_download_url, &latest.to_string())
        })
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "无法初始化更新")?;
        if let Some(update) = updater
            .check()
            .await
            .map_err(|_| "无法读取更新清单，请稍后重试")?
        {
            if update.version != latest.to_string()
                || !trusted_asset(update.download_url.as_str(), &update.version)
            {
                return Err("更新清单与正式版本不一致".into());
            }
            *control.pending.lock().map_err(|_| "更新状态不可用")? = Some((Instant::now(), update));
            can_install = true;
        }
    }
    #[cfg(mobile)]
    let _ = (&release.assets, &mut can_install);
    Ok(UpdateInfo {
        current_version,
        latest_version: latest.to_string(),
        available,
        can_install,
        notes: release
            .body
            .unwrap_or_default()
            .chars()
            .take(16_384)
            .collect(),
    })
}
#[tauri::command]
pub async fn update_install(app: AppHandle, control: State<'_, Controller>) -> Result<(), String> {
    if control.installing.swap(true, Ordering::SeqCst) {
        return Err("正在安装更新".into());
    }
    struct Reset<'a>(&'a AtomicBool);
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset(&control.installing);
    #[cfg(desktop)]
    {
        let (checked, update) = control
            .pending
            .lock()
            .map_err(|_| "更新状态不可用")?
            .take()
            .ok_or("请先检查更新")?;
        if checked.elapsed() > Duration::from_secs(900) {
            return Err("更新检查已过期，请重新检查".into());
        }
        // The official updater verifies the downloaded bytes before returning them.
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|_| "下载更新或签名校验失败，请重新检查更新")?;
        crate::vault_lock(
            app.state::<crate::AppState>(),
            app.state::<crate::quick_access::QuickAccess>(),
        )?;
        update
            .install(bytes)
            .map_err(|_| "安装更新失败，请从发布页面下载安装包")?;
        app.restart();
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("请从发布页面下载移动端更新".into())
    }
}
#[tauri::command]
pub fn update_open_download(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES, None::<&str>)
        .map_err(|_| "无法打开下载页面".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updater_rejects_prereleases_downgrades_and_untrusted_assets() {
        assert!(release_version("v2.0.0").unwrap() > release_version("1.5.1").unwrap());
        assert!(release_version("v2.0.0-beta.1").is_err());
        assert!(trusted_asset(
            "https://github.com/lx8s8/SteamGuard/releases/download/v2.0.0/app.tar.gz",
            "2.0.0"
        ));
        for value in [
            "http://github.com/lx8s8/SteamGuard/releases/download/v2.0.0/app",
            "https://github.com/other/SteamGuard/releases/download/v2.0.0/app",
            "https://github.com/lx8s8/SteamGuard/releases/download/v1.0.0/app",
            "https://github.com/lx8s8/SteamGuard/releases/download/v2.0.0/app?token=test",
            "https://github.com/lx8s8/SteamGuard/releases/download/v2.0.0/x/y",
        ] {
            assert!(!trusted_asset(value, "2.0.0"));
        }
    }
}
