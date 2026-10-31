//! Commands never expose cloud credentials, sync keys, or authenticator payloads.
use super::{storage, State as SyncState, *};
use crate::{vault::VaultData, AppState};
use std::sync::atomic::Ordering;
use tauri::State;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    active: bool,
    busy: bool,
    endpoint: String,
    username: String,
    library_id: String,
    dirty: bool,
    last_success: u64,
    error: Option<String>,
    conflicts: Vec<Conflict>,
}
fn status(s: &AppState) -> Result<Status, String> {
    let v = s.vault()?;
    let Some(config) = v.data.as_ref().and_then(|d| d.sync.as_ref()) else {
        return Ok(Status::default());
    };
    let runtime = s.sync.result.lock().map_err(|_| "同步状态不可用")?;
    Ok(Status {
        configured: true,
        active: config.active,
        busy: s.sync.busy(),
        endpoint: config.endpoint.clone(),
        username: config.username.clone(),
        library_id: config.library.clone(),
        dirty: config.dirty()?,
        last_success: runtime.0.max(config.last_success),
        error: runtime.1.clone(),
        conflicts: config.conflicts()?,
    })
}
#[tauri::command]
pub fn sync_status(s: State<AppState>) -> Result<Status, String> {
    status(&s)
}
fn same(s: &AppState, epoch: u64, data: &VaultData, config: &SyncState) -> Result<(), String> {
    if s.epoch.load(Ordering::SeqCst) != epoch
        || !data
            .sync
            .as_ref()
            .is_some_and(|c| c.library == config.library && c.key == config.key)
    {
        return Err("同步已取消，请解锁后重试".into());
    }
    Ok(())
}
fn merge(target: &mut SyncState, source: &SyncState, actor: &str) -> Result<(), String> {
    let mut doc = load(target, actor)?;
    let mut incoming = load(source, actor)?;
    doc.merge(&mut incoming).map_err(|_| "无法合并同步历史")?;
    validate_document(&doc)?;
    let bytes = Zeroizing::new(doc.save());
    if bytes.len() > MAX_DOCUMENT {
        return Err("同步文档过大".into());
    }
    target.doc = STANDARD.encode(&bytes);
    Ok(())
}
async fn run(s: &AppState, automatic: bool) -> Result<(), String> {
    let (mut remote, actor, epoch, network) = {
        let mut v = s.vault()?;
        let actor = v.sync_actor.clone();
        let d = v.ensure()?;
        let Some(config) = d.sync.as_ref() else {
            return Ok(());
        };
        if automatic && !config.active {
            return Ok(());
        }
        (
            config.clone(),
            actor,
            s.epoch.load(Ordering::SeqCst),
            d.network.clone(),
        )
    };
    let op = storage::client(
        &remote.endpoint,
        &remote.username,
        &remote.password,
        &network,
    )?;
    remote.verify_header(&storage::header(&op, &remote.library).await?)?;
    let files = storage::snapshots(&op, &remote).await?;
    let mut cloud = remote.clone();
    cloud.doc.clear();
    for (_, bytes) in &files {
        cloud.merge_bytes(bytes, &actor)?;
    }
    merge(&mut remote, &cloud, &actor)?;
    let published = {
        let mut v = s.vault()?;
        same(s, epoch, v.ensure()?, &remote)?;
        let old_heads = v
            .ensure()?
            .sync
            .as_ref()
            .ok_or("同步已断开")?
            .head_hash(&actor)?;
        let mut merged = v.ensure()?.sync.as_ref().ok_or("同步已断开")?.clone();
        merge(&mut merged, &remote, &actor)?;
        if merged.head_hash(&actor)? != old_heads {
            let ids = v.update(|d| {
                d.sync = Some(merged);
                apply(d, &actor)
            })?;
            for id in ids {
                s.steam.logout(&id);
            }
        }
        v.ensure()?.sync.as_ref().ok_or("同步已断开")?.clone()
    };
    let hash = published.head_hash(&actor)?;
    // Publish even when the only remote checkpoint was missing some local heads.
    let remote_covered = cloud.head_hash(&actor)? == hash;
    let needs_upload = published.dirty()? || files.len() != 1 || !remote_covered;
    if needs_upload {
        let path = storage::publish(&op, &published, published.checkpoint(&actor)?).await?;
        {
            let mut v = s.vault()?;
            same(s, epoch, v.ensure()?, &published)?;
            v.update(|d| {
                let c = d.sync.as_mut().ok_or("同步已断开")?;
                c.uploaded_heads = hash;
                c.last_success = crate::models::now();
                Ok(())
            })?;
        }
        // Delete only immutable files whose history was included in this verified upload.
        // Files created concurrently by another device are deliberately left for the next merge.
        storage::compact(
            &op,
            &published.library,
            &files.into_iter().map(|f| f.0).collect::<Vec<_>>(),
            &path,
        )
        .await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn sync_run(s: State<'_, AppState>, automatic: Option<bool>) -> Result<Status, String> {
    let lease = match s.sync.begin() {
        Ok(l) => l,
        Err(_) if automatic == Some(true) => return status(&s),
        Err(e) => return Err(e),
    };
    let result = tokio::select! {_ = lease.cancellation.cancelled()=>Err("同步已取消".into()),r=run(&s,automatic.unwrap_or(false))=>r};
    s.sync.finish(&result);
    drop(lease);
    result?;
    status(&s)
}
#[tauri::command]
pub async fn sync_connect(
    s: State<'_, AppState>,
    endpoint: String,
    username: String,
    password: String,
    sync_password: String,
    mode: String,
    library_id: Option<String>,
) -> Result<Status, String> {
    let password = Zeroizing::new(password);
    let sync_password = Zeroizing::new(sync_password);
    let endpoint = storage::validate_endpoint(&endpoint)?;
    if username.trim().is_empty()
        || username.len() > 1024
        || password.is_empty()
        || password.len() > 4096
        || sync_password.len() > 4096
    {
        return Err("请填写网盘账号、应用密码和同步密码".into());
    }
    if !["create", "join"].contains(&mode.as_str()) {
        return Err("请选择创建或加入同步库".into());
    }
    let lease = s.sync.begin()?;
    let (actor, device, epoch, network) = {
        let mut v = s.vault()?;
        let actor = v.sync_actor.clone();
        let device = v.device_id.clone();
        let d = v.ensure()?;
        if d.sync.is_some() {
            return Err("请先断开当前同步库".into());
        }
        (
            actor,
            device,
            s.epoch.load(Ordering::SeqCst),
            d.network.clone(),
        )
    };
    let connect = async {
        let op = storage::client(&endpoint, username.trim(), &password, &network)?;
        let (header, key) = if mode == "create" {
            let id = uuid::Uuid::new_v4().to_string();
            let (h, k) = create_header(&id, &sync_password)?;
            storage::create(&op, &h).await?;
            (h, k)
        } else {
            let id = uuid::Uuid::parse_str(library_id.as_deref().unwrap_or("").trim())
                .map_err(|_| "请输入有效的同步库编号")?
                .to_string();
            join_header(&storage::header(&op, &id).await?, &id, &sync_password)?
        };
        let config = SyncState::new(
            endpoint,
            username.trim().into(),
            password.to_string(),
            &header,
            &key,
            device,
        );
        let mut remote = config.clone();
        for (_, bytes) in storage::snapshots(&op, &config).await? {
            remote.merge_bytes(&bytes, &actor)?;
        }
        {
            let mut v = s.vault()?;
            if s.epoch.load(Ordering::SeqCst) != epoch || v.ensure()?.sync.is_some() {
                return Err("保险库状态已变化，请重试".into());
            }
            let ids = v.update(|d| {
                d.sync = Some(config);
                record_local(d, &actor)?;
                merge(d.sync.as_mut().ok_or("同步未配置")?, &remote, &actor)?;
                apply(d, &actor)
            })?;
            for id in ids {
                s.steam.logout(&id);
            }
        }
        Ok(())
    };
    let result: Result<(), String> =
        tokio::select! {_=lease.cancellation.cancelled()=>Err("同步已取消".into()),r=connect=>r};
    if let Err(e) = result {
        s.sync.finish(&Err(e.clone()));
        return Err(e);
    }
    // Connection is already saved. A first-upload failure remains visible and can be retried.
    let first = tokio::select! {_=lease.cancellation.cancelled()=>Err("同步已取消".into()),r=run(&s,false)=>r};
    s.sync.finish(&first);
    drop(lease);
    status(&s)
}
#[tauri::command]
pub fn sync_pause(s: State<AppState>, active: bool) -> Result<Status, String> {
    s.sync.cancel();
    let mut v = s.vault()?;
    v.update(|d| {
        d.sync.as_mut().ok_or("尚未连接同步库")?.active = active;
        Ok(())
    })?;
    drop(v);
    status(&s)
}
#[tauri::command]
pub fn sync_disconnect(s: State<AppState>) -> Result<Status, String> {
    s.sync.cancel();
    let mut v = s.vault()?;
    v.update(|d| {
        d.sync = None;
        for t in &mut d.tokens {
            t.hotp_read_only = false;
        }
        Ok(())
    })?;
    if let Ok(mut result) = s.sync.result.lock() {
        *result = (0, None);
    }
    drop(v);
    status(&s)
}
#[tauri::command]
pub fn sync_resolve(s: State<AppState>, id: String, choice: String) -> Result<Status, String> {
    if s.sync.busy() {
        return Err("请等待当前同步完成".into());
    }
    let mut v = s.vault()?;
    let actor = v.sync_actor.clone();
    let ids = v.update(|d| resolve(d, &actor, &id, &choice))?;
    for id in ids {
        s.steam.logout(&id);
    }
    drop(v);
    status(&s)
}
#[tauri::command]
pub fn sync_claim_hotp(
    s: State<AppState>,
    id: String,
    acknowledged: bool,
) -> Result<Status, String> {
    if !acknowledged {
        return Err("请确认旧设备已停止使用此 HOTP 令牌".into());
    }
    if s.sync.busy() {
        return Err("请等待当前同步完成".into());
    }
    let mut v = s.vault()?;
    let actor = v.sync_actor.clone();
    let device = v.device_id.clone();
    v.update(|d| {
        claim_hotp(d, &actor, &id, &device)?;
        apply(d, &actor)?;
        Ok(())
    })?;
    drop(v);
    status(&s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        network::{NetworkSettings, ProxyMode},
        steam::SteamService,
        vault::Vault,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicI64, AtomicU64},
            Mutex,
        },
    };
    fn app(
        dav: &storage::tests::Dav,
        header: &Header,
        key: &[u8; 32],
        with_token: bool,
    ) -> AppState {
        let path = std::env::temp_dir()
            .join(format!("steamguard-sync-app-{}", uuid::Uuid::new_v4()))
            .join("vault.sgvault");
        let mut v = Vault::new(path);
        v.create("synthetic-vault-password").unwrap();
        let device = v.device_id.clone();
        v.update(|d| {
            d.network = NetworkSettings {
                mode: ProxyMode::Direct,
                proxy_url: String::new(),
            };
            d.sync = Some(SyncState::new(
                dav.endpoint.clone(),
                "fixture".into(),
                "synthetic".into(),
                header,
                key,
                device,
            ));
            if with_token {
                d.tokens.push(Token::new(
                    "Original".into(),
                    "totp".into(),
                    b"synthetic-token-secret".to_vec(),
                ));
            }
            Ok(())
        })
        .unwrap();
        AppState {
            vault: Mutex::new(v),
            previews: Mutex::new(HashMap::new()),
            steam: SteamService::new().unwrap(),
            epoch: AtomicU64::new(0),
            time_offset: AtomicI64::new(0),
            sync: Controller::default(),
        }
    }
    #[tokio::test]
    async fn real_command_pipeline_converges_after_concurrent_edits_and_cloud_rollback() {
        let dav = storage::tests::Dav::new();
        let library = uuid::Uuid::new_v4().to_string();
        let (header, key) = create_header(&library, "synthetic-sync-password").unwrap();
        storage::create(&dav.op("synthetic"), &header)
            .await
            .unwrap();
        let a = app(&dav, &header, &key, true);
        let b = app(&dav, &header, &key, false);
        run(&a, false).await.unwrap();
        run(&b, false).await.unwrap();
        let original = dav
            .files
            .lock()
            .unwrap()
            .iter()
            .find(|(p, _)| p.ends_with(".sgsync"))
            .map(|(p, v)| (p.clone(), v.clone()))
            .unwrap();
        a.vault()
            .unwrap()
            .update(|d| {
                d.tokens[0].name = "New name".into();
                Ok(())
            })
            .unwrap();
        b.vault()
            .unwrap()
            .update(|d| {
                d.groups.push("Work".into());
                d.tokens[0].group = Some("Work".into());
                Ok(())
            })
            .unwrap();
        let (ar, br) = tokio::join!(run(&a, false), run(&b, false));
        ar.unwrap();
        br.unwrap();
        run(&a, false).await.unwrap();
        run(&b, false).await.unwrap();
        for state in [&a, &b] {
            let v = state.vault().unwrap();
            let d = v.data.as_ref().unwrap();
            assert_eq!(d.tokens[0].name, "New name");
            assert_eq!(d.tokens[0].group.as_deref(), Some("Work"));
            assert!(!d.sync.as_ref().unwrap().dirty().unwrap());
        }
        {
            let mut files = dav.files.lock().unwrap();
            files.retain(|p, _| !p.ends_with(".sgsync"));
            files.insert(original.0, original.1);
        }
        run(&a, false).await.unwrap();
        let config = a
            .vault()
            .unwrap()
            .data
            .as_ref()
            .unwrap()
            .sync
            .as_ref()
            .unwrap()
            .clone();
        let cloud = storage::snapshots(&dav.op("synthetic"), &config)
            .await
            .unwrap();
        assert_eq!(cloud.len(), 1);
        let mut check = SyncState::new(
            dav.endpoint.clone(),
            "fixture".into(),
            "synthetic".into(),
            &header,
            &key,
            "new-device".into(),
        );
        check.merge_bytes(&cloud[0].1, "new-actor").unwrap();
        let mut data = VaultData {
            sync: Some(check),
            ..Default::default()
        };
        apply(&mut data, "new-actor").unwrap();
        assert_eq!(data.tokens[0].name, "New name");
        assert_eq!(data.tokens[0].group.as_deref(), Some("Work"));
        for state in [a, b] {
            let mut v = state.vault.lock().unwrap();
            let dir = v.path.parent().unwrap().to_owned();
            v.lock();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[tokio::test]
    async fn failed_upload_verification_keeps_prior_version_and_dirty_local_changes_for_retry() {
        let dav = storage::tests::Dav::new();
        let (header, key) =
            create_header(&uuid::Uuid::new_v4().to_string(), "synthetic-sync-password").unwrap();
        storage::create(&dav.op("synthetic"), &header)
            .await
            .unwrap();
        let a = app(&dav, &header, &key, true);
        run(&a, false).await.unwrap();
        let old = dav
            .files
            .lock()
            .unwrap()
            .keys()
            .find(|p| p.ends_with(".sgsync"))
            .unwrap()
            .clone();
        a.vault()
            .unwrap()
            .update(|d| {
                d.tokens[0].name = "Retry me".into();
                Ok(())
            })
            .unwrap();
        dav.fail_after_put.store(true, Ordering::SeqCst);
        assert!(run(&a, false).await.is_err());
        assert!(dav.files.lock().unwrap().contains_key(&old));
        assert!(a
            .vault()
            .unwrap()
            .data
            .as_ref()
            .unwrap()
            .sync
            .as_ref()
            .unwrap()
            .dirty()
            .unwrap());
        run(&a, false).await.unwrap();
        assert!(!dav.files.lock().unwrap().contains_key(&old));
        assert!(!a
            .vault()
            .unwrap()
            .data
            .as_ref()
            .unwrap()
            .sync
            .as_ref()
            .unwrap()
            .dirty()
            .unwrap());
        let mut v = a.vault.lock().unwrap();
        let dir = v.path.parent().unwrap().to_owned();
        v.lock();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
