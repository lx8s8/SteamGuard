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
    alias: String,
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
        alias: config.alias.clone(),
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    endpoint: String,
    username: String,
    password: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
impl Connection {
    fn validate(&self) -> Result<String, String> {
        if self.username.trim().is_empty()
            || self.username.len() > 1024
            || self.password.is_empty()
            || self.password.len() > 4096
        {
            return Err("请填写网盘账号和应用密码".into());
        }
        storage::validate_endpoint(&self.endpoint)
    }
}
#[tauri::command]
pub async fn sync_update_credentials(
    s: State<'_, AppState>,
    connection: Connection,
) -> Result<Status, String> {
    update_credentials(&s, connection).await
}
async fn update_credentials(s: &AppState, connection: Connection) -> Result<Status, String> {
    let endpoint = connection.validate()?;
    let lease = s.sync.begin()?;
    let (config, network, epoch) = {
        let mut v = s.vault()?;
        let d = v.ensure()?;
        (
            d.sync.clone().ok_or("尚未连接同步库")?,
            d.network.clone(),
            s.epoch.load(Ordering::SeqCst),
        )
    };
    let op = storage::client(
        &endpoint,
        connection.username.trim(),
        &connection.password,
        &network,
    )?;
    let header = tokio::select! {
        _ = lease.cancellation.cancelled() => return Err("同步已取消".into()),
        r = storage::header(&op, &config.library) => r?,
    };
    config.verify_header(&header)?;
    let mut v = s.vault()?;
    same(s, epoch, v.ensure()?, &config)?;
    v.update(|d| {
        let c = d.sync.as_mut().ok_or("同步已断开")?;
        c.endpoint = endpoint;
        c.username = connection.username.trim().into();
        c.password.zeroize();
        c.password = connection.password.clone();
        Ok(())
    })?;
    drop(v);
    drop(lease);
    if let Ok(mut result) = s.sync.result.lock() {
        result.1 = None;
    }
    status(s)
}
#[tauri::command]
pub fn sync_set_alias(s: State<AppState>, alias: String) -> Result<Status, String> {
    let alias = alias.trim();
    if alias.chars().count() > 80 {
        return Err("本机名称最多 80 个字符".into());
    }
    s.vault()?.update(|d| {
        d.sync.as_mut().ok_or("尚未连接同步库")?.alias = alias.into();
        Ok(())
    })?;
    status(&s)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    endpoint: String,
    username: String,
    library_id: String,
    alias: String,
    connection_qr: String,
}
#[tauri::command]
pub fn sync_connection_info(s: State<AppState>) -> Result<ConnectionInfo, String> {
    let mut v = s.vault()?;
    let c = v.ensure()?.sync.as_ref().ok_or("尚未连接同步库")?;
    Ok(ConnectionInfo {
        endpoint: c.endpoint.clone(), username: c.username.clone(), library_id: c.library.clone(), alias: c.alias.clone(),
        connection_qr: serde_json::json!({"format":"SteamGuard Sync Connection", "version":1, "endpoint":c.endpoint, "username":c.username, "libraryId":c.library}).to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRequest {
    endpoint: String,
    username: String,
    password: String,
    sync_password: String,
    mode: String,
    library_id: Option<String>,
    #[serde(default)]
    confirm_new_library: bool,
}
impl Drop for ConnectRequest {
    fn drop(&mut self) {
        self.password.zeroize();
        self.sync_password.zeroize();
    }
}
async fn discover(s: &AppState, connection: Option<Connection>) -> Result<Vec<String>, String> {
    let lease = s.sync.begin()?;
    let (connection, network, epoch) = {
        let mut v = s.vault()?;
        let d = v.ensure()?;
        let connection = match connection {
            Some(c) => c,
            None => {
                let c = d.sync.as_ref().ok_or("尚未连接同步库")?;
                Connection {
                    endpoint: c.endpoint.clone(),
                    username: c.username.clone(),
                    password: c.password.clone(),
                }
            }
        };
        (
            connection,
            d.network.clone(),
            s.epoch.load(Ordering::SeqCst),
        )
    };
    let endpoint = connection.validate()?;
    let op = storage::client(
        &endpoint,
        connection.username.trim(),
        &connection.password,
        &network,
    )?;
    let libraries = tokio::select! {
        _ = lease.cancellation.cancelled() => return Err("同步已取消".into()),
        r = storage::libraries(&op) => r?,
    };
    let mut v = s.vault()?;
    v.ensure()?;
    if s.epoch.load(Ordering::SeqCst) != epoch {
        return Err("同步已取消，请解锁后重试".into());
    }
    Ok(libraries)
}
#[tauri::command]
pub async fn sync_discover(
    s: State<'_, AppState>,
    connection: Option<Connection>,
) -> Result<Vec<String>, String> {
    discover(&s, connection).await
}
async fn connect(
    s: &AppState,
    connection: &Connection,
    sync_password: &str,
    mode: &str,
    library_id: Option<&str>,
    confirm_new_library: bool,
    switching: bool,
) -> Result<Status, String> {
    let endpoint = connection.validate()?;
    if sync_password.is_empty() || sync_password.len() > 4096 {
        return Err("请填写独立同步密码".into());
    }
    if !["create", "join"].contains(&mode) || switching && mode != "join" {
        return Err("请选择创建或加入同步库".into());
    }
    let lease = s.sync.begin()?;
    let (actor, device, epoch, network, previous) = {
        let mut v = s.vault()?;
        let actor = v.sync_actor.clone();
        let device = v.device_id.clone();
        let d = v.ensure()?;
        if switching {
            let previous = d.sync.as_ref().ok_or("尚未连接同步库")?;
            if library_id
                .and_then(|id| uuid::Uuid::parse_str(id.trim()).ok())
                .is_some_and(|id| id.to_string() == previous.library)
            {
                return Err("已连接此同步库，请使用立即同步".into());
            }
            if !previous.conflicts()?.is_empty() {
                return Err("请先处理当前同步库的冲突，再合并其他库".into());
            }
        } else if d.sync.is_some() {
            return Err("请先断开当前同步库，或选择其他同步库合并".into());
        }
        (
            actor,
            device,
            s.epoch.load(Ordering::SeqCst),
            d.network.clone(),
            d.sync.clone(),
        )
    };
    let operation = async {
        // Catch up the source before switching so cloud-only changes are retained.
        if switching {
            run(s, false).await?;
        }
        let op = storage::client(
            &endpoint,
            connection.username.trim(),
            &connection.password,
            &network,
        )?;
        let (header, key) = if mode == "create" {
            if !storage::libraries(&op).await?.is_empty() && !confirm_new_library {
                return Err("网盘已有同步库，请选择加入；确需独立使用时请确认创建另一个库".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            let (h, k) = create_header(&id, sync_password)?;
            storage::create(&op, &h).await?;
            (h, k)
        } else {
            let id = uuid::Uuid::parse_str(library_id.unwrap_or("").trim())
                .map_err(|_| "请输入有效的同步库编号")?
                .to_string();
            join_header(&storage::header(&op, &id).await?, &id, sync_password)?
        };
        let config = SyncState::new(
            endpoint,
            connection.username.trim().into(),
            connection.password.clone(),
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
            let d = v.ensure()?;
            if s.epoch.load(Ordering::SeqCst) != epoch
                || d.sync.as_ref().map(|c| (&c.library, &c.key, c.active))
                    != previous.as_ref().map(|c| (&c.library, &c.key, c.active))
            {
                return Err("保险库状态已变化，请重试".into());
            }
            if switching && !d.sync.as_ref().ok_or("同步已断开")?.conflicts()?.is_empty() {
                return Err("当前同步库有新的冲突，请处理后重试".into());
            }
            let ids = v.update(|d| {
                // A fresh bootstrap actor also permits reconnecting to a library
                // visited earlier in this process without reusing Automerge sequences.
                bootstrap(d, config)?;
                merge(d.sync.as_mut().ok_or("同步未配置")?, &remote, &actor)?;
                apply(d, &actor)
            })?;
            for id in ids {
                s.steam.logout(&id);
            }
        }
        Ok(())
    };
    let result: Result<(), String> = tokio::select! {
        _ = lease.cancellation.cancelled() => Err("同步已取消".into()),
        r = operation => r,
    };
    if let Err(e) = result {
        s.sync.finish(&Err(e.clone()));
        return Err(e);
    }
    // The local merge is committed. A failed first upload remains visible for retry.
    let first = tokio::select! {
        _ = lease.cancellation.cancelled() => Err("同步已取消".into()),
        r = run(s, false) => r,
    };
    // Clear status from the previous library, including its last-success timestamp.
    if let Ok(mut runtime) = s.sync.result.lock() {
        *runtime = (0, None);
    }
    s.sync.finish(&first);
    drop(lease);
    status(s)
}
fn bootstrap(data: &mut VaultData, mut target: SyncState) -> Result<(), String> {
    let actor = uuid::Uuid::new_v4().to_string();
    // Moving between libraries must not silently claim read-only HOTP tokens.
    if let Some(source) = &data.sync {
        let old_key = crate::quick_access::read_key(&source.key)?;
        let new_key = crate::quick_access::read_key(&target.key)?;
        let source_doc = load(source, &actor)?;
        let mut target_doc = load(&target, &actor)?;
        for token in data.tokens.iter().filter(|t| t.kind == "hotp") {
            if let Some(owner) = one(
                &source_doc,
                &format!("t/{}/owner", identity(&old_key, token)),
            )? {
                put(
                    &mut target_doc,
                    &format!("t/{}/owner", identity(&new_key, token)),
                    &owner,
                )?;
            }
        }
        target.doc = STANDARD.encode(target_doc.save());
    }
    data.sync = Some(target);
    record_local(data, &actor)
}
#[tauri::command]
pub async fn sync_connect(
    s: State<'_, AppState>,
    connection: ConnectRequest,
) -> Result<Status, String> {
    let credentials = Connection {
        endpoint: connection.endpoint.clone(),
        username: connection.username.clone(),
        password: connection.password.clone(),
    };
    connect(
        &s,
        &credentials,
        &connection.sync_password,
        &connection.mode,
        connection.library_id.as_deref(),
        connection.confirm_new_library,
        false,
    )
    .await
}
#[tauri::command]
pub async fn sync_switch(
    s: State<'_, AppState>,
    library_id: String,
    sync_password: String,
) -> Result<Status, String> {
    let sync_password = Zeroizing::new(sync_password);
    switch(&s, &library_id, &sync_password).await
}
async fn switch(s: &AppState, library_id: &str, sync_password: &str) -> Result<Status, String> {
    let connection = {
        let mut v = s.vault()?;
        let c = v.ensure()?.sync.as_ref().ok_or("尚未连接同步库")?;
        Connection {
            endpoint: c.endpoint.clone(),
            username: c.username.clone(),
            password: c.password.clone(),
        }
    };
    connect(
        s,
        &connection,
        sync_password,
        "join",
        Some(library_id),
        false,
        true,
    )
    .await
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
    fn credentials(dav: &storage::tests::Dav) -> Connection {
        Connection {
            endpoint: dav.endpoint.clone(),
            username: "fixture".into(),
            password: "synthetic".into(),
        }
    }
    fn clean(states: Vec<AppState>) {
        for state in states {
            let mut v = state.vault.lock().unwrap();
            let dir = v.path.parent().unwrap().to_owned();
            v.lock();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[tokio::test]
    async fn refreshing_expired_credentials_preserves_history_and_uploads_pending_deletion() {
        let dav = storage::tests::Dav::new();
        let (header, key) =
            create_header(&uuid::Uuid::new_v4().to_string(), "synthetic-sync-password").unwrap();
        storage::create(&dav.op("synthetic"), &header)
            .await
            .unwrap();
        let a = app(&dav, &header, &key, true);
        let b = app(&dav, &header, &key, false);
        run(&a, false).await.unwrap();
        run(&b, false).await.unwrap();
        let id = a.vault().unwrap().ensure().unwrap().tokens[0].id.clone();
        a.vault()
            .unwrap()
            .update(|d| {
                crate::token_commands::delete(d, &[id])?;
                d.sync.as_mut().unwrap().password = "expired-application-password".into();
                Ok(())
            })
            .unwrap();
        let before = a.vault().unwrap().ensure().unwrap().sync.clone().unwrap();
        assert!(before.dirty().unwrap());
        update_credentials(&a, credentials(&dav)).await.unwrap();
        let after = a.vault().unwrap().ensure().unwrap().sync.clone().unwrap();
        assert_eq!(after.doc, before.doc);
        assert_eq!(after.baseline, before.baseline);
        assert_eq!(after.uploaded_heads, before.uploaded_heads);
        assert_eq!(after.library, before.library);
        assert!(after.dirty().unwrap());
        run(&a, false).await.unwrap();
        run(&b, false).await.unwrap();
        assert!(a.vault().unwrap().ensure().unwrap().tokens.is_empty());
        assert!(b.vault().unwrap().ensure().unwrap().tokens.is_empty());
        assert_eq!(b.vault().unwrap().ensure().unwrap().trash.len(), 1);
        clean(vec![a, b]);
    }
    #[tokio::test]
    async fn empty_device_joins_discovered_phone_library_without_creating_another() {
        let dav = storage::tests::Dav::new();
        let (header, key) =
            create_header(&uuid::Uuid::new_v4().to_string(), "synthetic-sync-password").unwrap();
        storage::create(&dav.op("synthetic"), &header)
            .await
            .unwrap();
        let phone = app(&dav, &header, &key, true);
        let desktop = app(&dav, &header, &key, false);
        desktop
            .vault()
            .unwrap()
            .update(|d| {
                d.sync = None;
                Ok(())
            })
            .unwrap();
        run(&phone, false).await.unwrap();
        assert_eq!(
            discover(&desktop, Some(credentials(&dav))).await.unwrap(),
            vec![header.library.clone()]
        );
        // The backend also guards against accidental creation even if a client bypasses the chooser.
        assert!(connect(
            &desktop,
            &credentials(&dav),
            "synthetic-sync-password",
            "create",
            None,
            false,
            false
        )
        .await
        .err()
        .unwrap()
        .contains("网盘已有同步库"));
        assert!(desktop
            .vault()
            .unwrap()
            .data
            .as_ref()
            .unwrap()
            .tokens
            .is_empty());
        let result = connect(
            &desktop,
            &credentials(&dav),
            "synthetic-sync-password",
            "join",
            Some(&header.library),
            false,
            false,
        )
        .await
        .unwrap();
        assert!(result.configured && result.error.is_none());
        assert_eq!(result.library_id, header.library);
        assert_eq!(
            desktop.vault().unwrap().data.as_ref().unwrap().tokens.len(),
            1
        );
        assert_eq!(
            storage::libraries(&dav.op("synthetic"))
                .await
                .unwrap()
                .len(),
            1
        );
        clean(vec![phone, desktop]);
    }
    #[tokio::test]
    async fn selecting_another_library_merges_both_devices_and_can_switch_back_safely() {
        let dav = storage::tests::Dav::new();
        let (phone_header, phone_key) =
            create_header(&uuid::Uuid::new_v4().to_string(), "phone-sync-password").unwrap();
        let (pc_header, pc_key) =
            create_header(&uuid::Uuid::new_v4().to_string(), "desktop-sync-password").unwrap();
        for header in [&phone_header, &pc_header] {
            storage::create(&dav.op("synthetic"), header).await.unwrap();
        }
        let phone = app(&dav, &phone_header, &phone_key, true);
        let desktop = app(&dav, &pc_header, &pc_key, false);
        desktop
            .vault()
            .unwrap()
            .update(|d| {
                d.tokens.push(Token::new(
                    "Desktop only".into(),
                    "totp".into(),
                    b"different-synthetic-secret".to_vec(),
                ));
                d.tokens.push(Token::new(
                    "Desktop HOTP".into(),
                    "hotp".into(),
                    b"synthetic-hotp-secret".to_vec(),
                ));
                d.groups.push("Desktop".into());
                Ok(())
            })
            .unwrap();
        run(&phone, false).await.unwrap();
        run(&desktop, false).await.unwrap();
        // A third device remains the HOTP owner even when a secondary moves libraries.
        let secondary = app(&dav, &pc_header, &pc_key, false);
        run(&secondary, false).await.unwrap();
        assert!(
            secondary
                .vault()
                .unwrap()
                .data
                .as_ref()
                .unwrap()
                .tokens
                .iter()
                .find(|t| t.kind == "hotp")
                .unwrap()
                .hotp_read_only
        );
        let result = switch(&secondary, &phone_header.library, "phone-sync-password")
            .await
            .unwrap();
        assert_eq!(result.library_id, phone_header.library);
        assert!(
            secondary
                .vault()
                .unwrap()
                .data
                .as_ref()
                .unwrap()
                .tokens
                .iter()
                .find(|t| t.kind == "hotp")
                .unwrap()
                .hotp_read_only
        );
        // Wrong target password preserves current library and every local token.
        let failure = switch(&desktop, &phone_header.library, "incorrect-password").await;
        assert!(failure.is_err());
        assert_eq!(status(&desktop).unwrap().library_id, pc_header.library);
        assert_eq!(
            desktop.vault().unwrap().data.as_ref().unwrap().tokens.len(),
            2
        );
        let result = switch(&desktop, &phone_header.library, "phone-sync-password")
            .await
            .unwrap();
        assert!(result.error.is_none());
        run(&phone, false).await.unwrap();
        for state in [&phone, &desktop] {
            let v = state.vault().unwrap();
            let data = v.data.as_ref().unwrap();
            assert_eq!(data.tokens.len(), 3);
            assert!(data.groups.contains(&"Desktop".into()));
        }
        assert_eq!(
            storage::libraries(&dav.op("synthetic"))
                .await
                .unwrap()
                .len(),
            2
        );
        switch(&desktop, &pc_header.library, "desktop-sync-password")
            .await
            .unwrap();
        switch(&desktop, &phone_header.library, "phone-sync-password")
            .await
            .unwrap();
        assert_eq!(
            desktop.vault().unwrap().data.as_ref().unwrap().tokens.len(),
            3
        );
        assert!(switch(
            &desktop,
            &phone_header.library.to_uppercase(),
            "phone-sync-password"
        )
        .await
        .is_err());
        clean(vec![phone, desktop, secondary]);
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
