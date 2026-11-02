//! Mobile folder access is owned by the OS. Only already-encrypted snapshots leave app storage.
use crate::AppState;
use tauri::{AppHandle, State};
use tauri_plugin_quick_access::{ExternalBackupStatus, SecureAccessExt};

#[cfg(mobile)]
struct Worker {
    sender: std::sync::mpsc::SyncSender<std::path::PathBuf>,
    error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}
#[cfg(mobile)]
static WORKER: std::sync::OnceLock<Worker> = std::sync::OnceLock::new();
#[cfg(mobile)]
static INITIAL_REFRESH: std::sync::OnceLock<()> = std::sync::OnceLock::new();
#[cfg(mobile)]
static DESTINATION_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn install(app: AppHandle) {
    #[cfg(mobile)]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<std::path::PathBuf>(1);
        let error = std::sync::Arc::new(std::sync::Mutex::new(None));
        let thread_error = error.clone();
        if WORKER.set(Worker { sender, error }).is_err() {
            return;
        }
        // A one-item coalescing queue avoids copies of large encrypted vaults in memory.
        std::thread::spawn(move || {
            let mut generation = 0;
            let mut mirrored = std::collections::HashSet::new();
            while let Ok(path) = receiver.recv() {
                let result = (|| {
                    if !app.secure_access().external_backup_status()?.configured {
                        return Ok(());
                    }
                    let requested_generation =
                        DESTINATION_GENERATION.load(std::sync::atomic::Ordering::Acquire);
                    if requested_generation != generation {
                        mirrored.clear();
                        generation = requested_generation;
                    }
                    let mut rows = crate::backup::list(&path)?;
                    let names: std::collections::HashSet<_> =
                        rows.iter().map(|r| r.name.clone()).collect();
                    mirrored.retain(|name| names.contains(name));
                    rows.reverse(); // Populate older restore points before the latest snapshot.
                    for row in rows {
                        if mirrored.contains(&row.name) {
                            continue;
                        }
                        let bytes = crate::backup::read(&path, &row.name)?;
                        validate_snapshot(&bytes)?;
                        app.secure_access()
                            .external_backup_snapshot(&row.name, &bytes)?;
                        mirrored.insert(row.name);
                    }
                    Ok::<(), String>(())
                })();
                if let Ok(mut value) = thread_error.lock() {
                    *value = result.err();
                }
            }
        });
    }
    #[cfg(not(mobile))]
    let _ = app;
}
pub fn queue(vault: &std::path::Path) {
    #[cfg(mobile)]
    if let Some(worker) = WORKER.get() {
        // Full means an existing queued refresh will observe the latest local snapshots.
        let _ = worker.sender.try_send(vault.to_owned());
    }
    #[cfg(not(mobile))]
    let _ = vault;
}
#[cfg(any(mobile, test))]
fn validate_snapshot(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("外部备份文件超过大小限制".into());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "外部备份格式无效")?;
    if value["format"] != "SteamGuard Vault"
        || value["version"] != 1
        || value["kdf"] != "argon2id-v19-m19456-t2-p1"
        || !value["ciphertext"].is_string()
        || value.get("tokens").is_some()
    {
        return Err("外部备份只接受加密快照".into());
    }
    Ok(())
}
fn error() -> Option<String> {
    #[cfg(mobile)]
    {
        WORKER.get().and_then(|w| w.error.lock().ok()?.clone())
    }
    #[cfg(not(mobile))]
    {
        None
    }
}
#[tauri::command]
pub async fn backup_external_status(
    app: AppHandle,
    s: State<'_, AppState>,
) -> Result<ExternalBackupStatus, String> {
    s.vault()?.ensure()?;
    let mut status = app.secure_access().external_backup_status_async().await?;
    status.error = if status.configured {
        error().or(status.error)
    } else {
        None
    };
    #[cfg(mobile)]
    if status.configured && INITIAL_REFRESH.set(()).is_ok() {
        queue(&s.vault()?.path);
    }
    Ok(status)
}
#[tauri::command]
pub async fn backup_external_choose(
    app: AppHandle,
    s: State<'_, AppState>,
) -> Result<ExternalBackupStatus, String> {
    s.vault()?.ensure()?;
    let status = app.secure_access().external_backup_choose().await?;
    if status.configured {
        #[cfg(mobile)]
        DESTINATION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        queue(&s.vault()?.path);
    }
    Ok(status)
}
#[tauri::command]
pub async fn backup_external_clear(
    app: AppHandle,
    s: State<'_, AppState>,
) -> Result<ExternalBackupStatus, String> {
    s.vault()?.ensure()?;
    let result = app.secure_access().external_backup_clear().await?;
    #[cfg(mobile)]
    DESTINATION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    #[cfg(mobile)]
    if let Some(worker) = WORKER.get() {
        if let Ok(mut error) = worker.error.lock() {
            *error = None;
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_sink_accepts_only_bounded_encrypted_vaults() {
        assert!(validate_snapshot(br#"{"tokens":[{"secret":"not encrypted"}]}"#).is_err());
        assert!(validate_snapshot(br#"{"format":"SteamGuard Vault","version":1,"kdf":"argon2id-v19-m19456-t2-p1","ciphertext":"encrypted"}"#).is_ok());
        assert!(validate_snapshot(br#"{"format":"SteamGuard Vault","version":1,"kdf":"argon2id-v19-m19456-t2-p1","ciphertext":"encrypted","tokens":[]}"#).is_err());
    }
}
