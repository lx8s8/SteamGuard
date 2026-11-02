//! Bounded, password-encrypted snapshots. Device-only quick-access keys are never copied.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const RECENT_LIMIT: usize = 10;
const DAILY_LIMIT: usize = 30;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub created_at: u64,
    pub size: u64,
    pub daily: bool,
    #[serde(skip)]
    order: u128,
}
fn configuration(vault: &Path) -> Result<PathBuf, String> {
    Ok(vault
        .parent()
        .ok_or("备份目录无效")?
        .join("device-only/backup-directory.json"))
}
pub fn directory(vault: &Path) -> Result<PathBuf, String> {
    let config = configuration(vault)?;
    match fs::read(config) {
        Ok(bytes) => {
            let value: String = serde_json::from_slice(&bytes).map_err(|_| "备份目录设置无效")?;
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("备份目录必须是绝对路径".into());
            }
            Ok(path)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(vault.parent().ok_or("备份目录无效")?.join("backups"))
        }
        Err(_) => Err("无法读取备份目录设置".into()),
    }
}
pub fn configure_directory(vault: &Path, path: Option<&str>) -> Result<(), String> {
    #[cfg(mobile)]
    if path.is_some() {
        return Err("移动端外部目录需要系统文件授权，请先使用导出备份".into());
    }
    let config = configuration(vault)?;
    if let Some(value) = path {
        let directory = PathBuf::from(value);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("请选择存在的绝对目录路径".into());
        }
        let probe = directory.join(format!(".steamguard-write-check-{}", uuid::Uuid::new_v4()));
        atomic(&probe, b"SteamGuard encrypted backup directory")?;
        fs::remove_file(&probe).map_err(|_| "无法清理目录写入检查")?;
        atomic(
            &config,
            &serde_json::to_vec(&directory.to_string_lossy()).map_err(|_| "无法编码备份目录")?,
        )
    } else {
        match fs::remove_file(config) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法重置备份目录".into()),
        }
    }
}

fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::quick_access::write_private(path, bytes)
}
fn entries(dir: &Path) -> Result<Vec<BackupEntry>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| "无法读取自动备份目录")? {
        let entry = entry.map_err(|_| "无法读取自动备份")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((time, daily)) = parse_name(&name) else {
            continue;
        };
        if !entry.file_type().map_err(|_| "无法读取备份类型")?.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|_| "无法读取备份信息")?;
        entries.push(BackupEntry {
            name,
            created_at: time,
            size: metadata.len(),
            daily,
            order: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |t| t.as_nanos()),
        });
    }
    entries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.order.cmp(&a.order))
    });
    Ok(entries)
}
fn parse_name(name: &str) -> Option<(u64, bool)> {
    let (prefix, rest) = name.split_once('-')?;
    let daily = match prefix {
        "daily" => true,
        "recent" => false,
        _ => return None,
    };
    let rest = rest.strip_suffix(".sgvault")?;
    let (timestamp, suffix) = rest.split_once('-')?;
    if timestamp.len() != 20
        || !timestamp.bytes().all(|c| c.is_ascii_digit())
        || uuid::Uuid::parse_str(suffix).is_err()
    {
        return None;
    }
    Some((timestamp.parse().ok()?, daily))
}
pub fn list(vault: &Path) -> Result<Vec<BackupEntry>, String> {
    let mut rows = entries(&directory(vault)?)?;
    rows.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.order.cmp(&a.order))
    });
    Ok(rows)
}
pub fn read(vault: &Path, name: &str) -> Result<Vec<u8>, String> {
    if parse_name(name).is_none() {
        return Err("备份编号无效".into());
    }
    let path = directory(vault)?.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "备份不存在")?;
    if !metadata.file_type().is_file() || metadata.len() > 20 * 1024 * 1024 {
        return Err("备份文件无效或过大".into());
    }
    fs::read(path).map_err(|_| "无法读取备份".into())
}
pub fn record(
    vault: &Path,
    previous: Option<&[u8]>,
    current: &[u8],
    now: u64,
) -> Result<(), String> {
    let dir = directory(vault)?;
    let rows = entries(&dir)?;
    // Keep one point per day, taking the pre-change vault when available.
    if !rows
        .iter()
        .any(|e| e.daily && e.created_at / 86400 == now / 86400)
    {
        atomic(
            &dir.join(format!("daily-{now:020}-{}.sgvault", uuid::Uuid::new_v4())),
            previous.unwrap_or(current),
        )?;
    }
    atomic(
        &dir.join(format!("recent-{now:020}-{}.sgvault", uuid::Uuid::new_v4())),
        current,
    )?;
    let rows = entries(&dir)?;
    for (daily, limit) in [(true, DAILY_LIMIT), (false, RECENT_LIMIT)] {
        for old in rows.iter().filter(|r| r.daily == daily).skip(limit) {
            fs::remove_file(dir.join(&old.name)).map_err(|_| "备份已保存，但旧快照清理失败")?;
        }
    }
    crate::backup_external::queue(vault);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_keep_history_encrypted_and_enforce_retention_and_safe_names() {
        let dir = std::env::temp_dir().join(format!("steamguard-backups-{}", uuid::Uuid::new_v4()));
        let mut vault = crate::vault::Vault::new(dir.join("vault.sgvault"));
        vault.create("fixture password").unwrap();
        vault
            .update(|d| {
                d.tokens.push(crate::models::Token::new(
                    "private fixture".into(),
                    "totp".into(),
                    vec![1; 20],
                ));
                Ok(())
            })
            .unwrap();
        let bytes = fs::read(&vault.path).unwrap();
        fs::remove_dir_all(directory(&vault.path).unwrap()).unwrap();
        for day in 1..35 {
            for revision in 0..2 {
                record(&vault.path, Some(&bytes), &bytes, day * 86400 + revision).unwrap();
            }
        }
        let rows = list(&vault.path).unwrap();
        assert_eq!(rows.iter().filter(|r| r.daily).count(), 30);
        assert_eq!(rows.iter().filter(|r| !r.daily).count(), 10);
        assert!(read(&vault.path, "../../vault.sgvault").is_err());
        for row in rows {
            let b = read(&vault.path, &row.name).unwrap();
            assert!(!String::from_utf8_lossy(&b).contains("private fixture"));
            assert_eq!(
                crate::vault::decode(&b, "fixture password")
                    .unwrap()
                    .tokens
                    .len(),
                1
            );
        }
        vault.lock();
        fs::remove_dir_all(dir).unwrap();
    }
}
