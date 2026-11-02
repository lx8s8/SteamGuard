//! iCloud Drive transports the same immutable encrypted checkpoints as WebDAV.
//! Native coordination, placeholders and upload acknowledgement stay in Apple APIs.
use crate::AppState;
use opendal::{
    raw::{oio, *},
    *,
};
use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc, OnceLock},
};
use tauri::{AppHandle, State};
use tauri_plugin_icloud_sync::{Failure, ICloudExt, Session};

pub const ENDPOINT: &str = "steamguard-icloud://default/";
static APP: OnceLock<AppHandle> = OnceLock::new();
pub fn initialize(app: AppHandle) {
    let _ = APP.set(app);
}
pub fn matches(endpoint: &str) -> bool {
    endpoint == ENDPOINT
}
pub fn stop() {
    if let Some(app) = APP.get() {
        app.icloud_sync().stop();
    }
}
#[tauri::command]
pub async fn icloud_status() -> tauri_plugin_icloud_sync::Availability {
    if let Some(app) = APP.get() {
        app.icloud_sync().availability().await
    } else {
        tauri_plugin_icloud_sync::Availability {
            supported: cfg!(any(target_os = "macos", target_os = "ios")),
            configured: false,
            available: false,
            revision: 0,
        }
    }
}
#[tauri::command]
pub async fn icloud_watch(s: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    if !enabled {
        stop();
        return Ok(());
    }
    let app = APP.get().ok_or("iCloud 服务尚未初始化")?;
    let generation = app.icloud_sync().generation();
    let epoch = {
        let mut vault = s.vault()?;
        let d = vault.ensure()?;
        if !d
            .sync
            .as_ref()
            .is_some_and(|c| matches(&c.endpoint) && c.active)
        {
            return Ok(());
        }
        s.epoch.load(Ordering::SeqCst)
    };
    app.icloud_sync()
        .connect_at(generation)
        .await
        .map_err(|e| e.to_string())?;
    let valid = {
        let mut vault = s.vault()?;
        vault.ensure().is_ok_and(|d| {
            s.epoch.load(Ordering::SeqCst) == epoch
                && d.sync
                    .as_ref()
                    .is_some_and(|c| matches(&c.endpoint) && c.active)
        })
    };
    if !valid {
        stop();
        return Err("iCloud 同步已取消".into());
    }
    Ok(())
}
pub async fn operator(s: &AppState) -> Result<Operator, String> {
    let app = APP.get().ok_or("iCloud 服务尚未初始化")?;
    let generation = app.icloud_sync().generation();
    let epoch = {
        let mut vault = s.vault()?;
        vault.ensure()?;
        s.epoch.load(Ordering::SeqCst)
    };
    let session = app
        .icloud_sync()
        .connect_at(generation)
        .await
        .map_err(|e| e.to_string())?;
    let valid = {
        let mut vault = s.vault()?;
        vault.ensure().is_ok() && s.epoch.load(Ordering::SeqCst) == epoch
    };
    if !valid {
        stop();
        return Err("iCloud 同步已取消".into());
    }
    Ok(Operator::from_parts(
        OperationContext::default(),
        Arc::new(CloudService {
            session: session.into(),
        }),
    ))
}
fn failed(error: Failure) -> opendal::Error {
    let kind = match error.0.as_str() {
        "notFound" => ErrorKind::NotFound,
        "conflict" => ErrorKind::AlreadyExists,
        "bounds" => ErrorKind::Unexpected,
        "account" | "unavailable" => ErrorKind::PermissionDenied,
        _ => ErrorKind::Unexpected,
    };
    opendal::Error::new(kind, "iCloud document operation failed").set_source(error)
}
fn unsupported() -> opendal::Error {
    opendal::Error::new(
        ErrorKind::Unsupported,
        "iCloud sync only supports fixed checkpoint operations",
    )
}
fn metadata(entry: &tauri_plugin_icloud_sync::Entry) -> Metadata {
    if entry.directory {
        MetadataBuilder::dir().build()
    } else {
        MetadataBuilder::file(entry.size).build()
    }
}
#[derive(Clone, Debug)]
enum CloudSession {
    Native(Session),
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<tests::Memory>>),
}
impl From<Session> for CloudSession {
    fn from(value: Session) -> Self {
        Self::Native(value)
    }
}
impl CloudSession {
    async fn stat(
        &self,
        path: &str,
    ) -> std::result::Result<tauri_plugin_icloud_sync::Entry, Failure> {
        match self {
            Self::Native(s) => s.stat(path).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().stat(path),
        }
    }
    async fn list(
        &self,
        path: &str,
    ) -> std::result::Result<Vec<tauri_plugin_icloud_sync::Entry>, Failure> {
        match self {
            Self::Native(s) => s.list(path).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().list(path),
        }
    }
    async fn mkdir(&self, path: &str) -> std::result::Result<(), Failure> {
        match self {
            Self::Native(s) => s.mkdir(path).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().mkdir(path),
        }
    }
    async fn read(&self, path: &str) -> std::result::Result<Vec<u8>, Failure> {
        match self {
            Self::Native(s) => s.read(path).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().read(path),
        }
    }
    async fn write(&self, path: &str, bytes: &[u8]) -> std::result::Result<(), Failure> {
        match self {
            Self::Native(s) => s.write(path, bytes).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().write(path, bytes),
        }
    }
    async fn delete(&self, path: &str) -> std::result::Result<(), Failure> {
        match self {
            Self::Native(s) => s.delete(path).await,
            #[cfg(test)]
            Self::Memory(s) => s.lock().unwrap().delete(path),
        }
    }
}
#[derive(Debug)]
struct CloudService {
    session: CloudSession,
}
impl Service for CloudService {
    type Reader = CloudReader;
    type Writer = CloudWriter;
    type Lister = CloudLister;
    type Deleter = CloudDeleter;
    type Copier = ();
    type Composer = ();
    fn info(&self) -> ServiceInfo {
        ServiceInfo::new("steamguard-icloud", "/", "iCloud Drive")
    }
    fn capability(&self) -> Capability {
        Capability {
            stat: true,
            read: true,
            write: true,
            create_dir: true,
            list: true,
            delete: true,
            ..Default::default()
        }
    }
    async fn create_dir(
        &self,
        _: &OperationContext,
        path: &str,
        _: OpCreateDir,
    ) -> Result<RpCreateDir> {
        self.session.mkdir(path).await.map_err(failed)?;
        Ok(RpCreateDir::default())
    }
    async fn stat(&self, _: &OperationContext, path: &str, _: OpStat) -> Result<RpStat> {
        Ok(RpStat::new(metadata(
            &self.session.stat(path).await.map_err(failed)?,
        )))
    }
    fn read(&self, _: &OperationContext, path: &str, _: OpRead) -> Result<Self::Reader> {
        tauri_plugin_icloud_sync::validate_path(path).map_err(failed)?;
        Ok(CloudReader {
            session: self.session.clone(),
            path: path.into(),
        })
    }
    fn write(&self, _: &OperationContext, path: &str, _: OpWrite) -> Result<Self::Writer> {
        tauri_plugin_icloud_sync::validate_path(path).map_err(failed)?;
        Ok(CloudWriter {
            session: self.session.clone(),
            path: path.into(),
            bytes: Vec::new(),
            closed: false,
        })
    }
    fn list(&self, _: &OperationContext, path: &str, args: OpList) -> Result<Self::Lister> {
        if args.recursive() {
            return Err(unsupported());
        }
        tauri_plugin_icloud_sync::validate_path(path).map_err(failed)?;
        Ok(CloudLister {
            session: self.session.clone(),
            path: path.into(),
            entries: None,
        })
    }
    fn delete(&self, _: &OperationContext) -> Result<Self::Deleter> {
        Ok(CloudDeleter(self.session.clone()))
    }
    fn copy(&self, _: &OperationContext, _: &str, _: &str, _: OpCopy) -> Result<Self::Copier> {
        Err(unsupported())
    }
    async fn rename(
        &self,
        _: &OperationContext,
        _: &str,
        _: &str,
        _: OpRename,
    ) -> Result<RpRename> {
        Err(unsupported())
    }
    async fn presign(&self, _: &OperationContext, _: &str, _: OpPresign) -> Result<RpPresign> {
        Err(unsupported())
    }
}
struct CloudReader {
    session: CloudSession,
    path: String,
}
impl CloudReader {
    async fn buffer(&self, range: BytesRange) -> Result<(RpRead, Buffer)> {
        let bytes = self.session.read(&self.path).await.map_err(failed)?;
        let length = bytes.len();
        let start = usize::try_from(range.offset()).map_err(|_| unsupported())?;
        let size = range
            .size()
            .map(usize::try_from)
            .transpose()
            .map_err(|_| unsupported())?
            .unwrap_or(length.saturating_sub(start));
        let end = start
            .checked_add(size)
            .filter(|n| *n <= length)
            .ok_or_else(|| {
                opendal::Error::new(
                    ErrorKind::RangeNotSatisfied,
                    "iCloud range exceeds file size",
                )
            })?;
        let meta = MetadataBuilder::file(size as u64).build();
        Ok((RpRead::new(meta), Buffer::from(bytes[start..end].to_vec())))
    }
}
impl oio::Read for CloudReader {
    async fn open(&self, range: BytesRange) -> Result<(RpRead, Box<dyn oio::ReadStreamDyn>)> {
        let (rp, b) = self.buffer(range).await?;
        Ok((rp, Box::new(b)))
    }
    async fn read(&self, range: BytesRange) -> Result<(RpRead, Buffer)> {
        self.buffer(range).await
    }
}
struct CloudWriter {
    session: CloudSession,
    path: String,
    bytes: Vec<u8>,
    closed: bool,
}
impl oio::Write for CloudWriter {
    async fn write(&mut self, bytes: Buffer) -> Result<()> {
        if self.closed
            || self
                .bytes
                .len()
                .checked_add(bytes.len())
                .is_none_or(|size| size > 32 * 1024 * 1024)
        {
            return Err(unsupported());
        }
        self.bytes.extend_from_slice(&bytes.to_vec());
        Ok(())
    }
    async fn close(&mut self) -> Result<Metadata> {
        if self.closed {
            return Err(unsupported());
        }
        self.session
            .write(&self.path, &self.bytes)
            .await
            .map_err(failed)?;
        self.closed = true;
        Ok(MetadataBuilder::file(self.bytes.len() as u64).build())
    }
    async fn abort(&mut self) -> Result<()> {
        self.bytes.clear();
        self.closed = true;
        Ok(())
    }
}
struct CloudLister {
    session: CloudSession,
    path: String,
    entries: Option<VecDeque<oio::Entry>>,
}
impl oio::List for CloudLister {
    async fn next(&mut self) -> Result<Option<oio::Entry>> {
        if self.entries.is_none() {
            let entries = match self.session.list(&self.path).await {
                Ok(v) => v,
                Err(e) if e.0 == "notFound" => Vec::new(),
                Err(e) => return Err(failed(e)),
            };
            let mut result = VecDeque::new();
            for e in entries {
                if !e.path.starts_with(&self.path) {
                    return Err(unsupported());
                }
                result.push_back(oio::Entry::new(&e.path, metadata(&e)));
            }
            self.entries = Some(result);
        }
        Ok(self.entries.as_mut().unwrap().pop_front())
    }
}
struct CloudDeleter(CloudSession);
impl oio::Delete for CloudDeleter {
    async fn delete(&mut self, path: &str, _: OpDelete) -> Result<()> {
        self.0.delete(path).await.map_err(failed)
    }
    async fn close(&mut self) -> Result<()> {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{self, storage};
    use std::collections::{BTreeMap, BTreeSet};
    #[derive(Debug, Default)]
    pub(super) struct Memory {
        files: BTreeMap<String, Vec<u8>>,
        dirs: BTreeSet<String>,
        uploading: bool,
        confirmed: Option<String>,
    }
    impl Memory {
        pub(super) fn stat(
            &self,
            path: &str,
        ) -> std::result::Result<tauri_plugin_icloud_sync::Entry, Failure> {
            let directory = self.dirs.contains(path.trim_end_matches('/'));
            let bytes = self.files.get(path);
            if !directory && bytes.is_none() {
                return Err(Failure("notFound".into()));
            }
            Ok(tauri_plugin_icloud_sync::Entry {
                path: path.into(),
                directory,
                size: bytes.map(|v| v.len() as u64).unwrap_or(0),
            })
        }
        pub(super) fn mkdir(&mut self, path: &str) -> std::result::Result<(), Failure> {
            tauri_plugin_icloud_sync::validate_path(path)?;
            let mut parent = String::new();
            for part in path.trim_end_matches('/').split('/') {
                if !parent.is_empty() {
                    parent.push('/');
                }
                parent.push_str(part);
                self.dirs.insert(parent.clone());
            }
            Ok(())
        }
        pub(super) fn list(
            &self,
            path: &str,
        ) -> std::result::Result<Vec<tauri_plugin_icloud_sync::Entry>, Failure> {
            let prefix = format!("{}/", path.trim_end_matches('/'));
            let mut entries = Vec::new();
            for directory in &self.dirs {
                if directory
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
                {
                    entries.push(tauri_plugin_icloud_sync::Entry {
                        path: format!("{directory}/"),
                        directory: true,
                        size: 0,
                    });
                }
            }
            for (file, bytes) in &self.files {
                if file
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.contains('/'))
                {
                    entries.push(tauri_plugin_icloud_sync::Entry {
                        path: file.clone(),
                        directory: false,
                        size: bytes.len() as u64,
                    });
                }
            }
            Ok(entries)
        }
        pub(super) fn read(&self, path: &str) -> std::result::Result<Vec<u8>, Failure> {
            self.files
                .get(path)
                .cloned()
                .ok_or(Failure("notFound".into()))
        }
        pub(super) fn write(
            &mut self,
            path: &str,
            bytes: &[u8],
        ) -> std::result::Result<(), Failure> {
            if let Some(previous) = self.files.get(path) {
                if previous != bytes {
                    return Err(Failure("conflict".into()));
                }
            } else {
                if self.uploading && self.files.keys().any(|p| p.ends_with(".sgsync")) {
                    return Err(Failure("pending".into()));
                }
                self.files.insert(path.into(), bytes.to_vec());
            }
            if self.uploading {
                return Err(Failure("pending".into()));
            }
            self.confirmed = Some(path.into());
            Ok(())
        }
        pub(super) fn delete(&mut self, path: &str) -> std::result::Result<(), Failure> {
            if !path.ends_with(".sgsync")
                || self.uploading
                || self.confirmed.as_ref().is_none_or(|keep| {
                    !keep.ends_with(".sgsync")
                        || keep.rsplit_once('/').map(|x| x.0) != path.rsplit_once('/').map(|x| x.0)
                })
            {
                return Err(Failure("pending".into()));
            }
            self.files.remove(path);
            Ok(())
        }
    }
    fn operator_fixture() -> (Operator, Arc<std::sync::Mutex<Memory>>) {
        let store = Arc::new(std::sync::Mutex::new(Memory::default()));
        (
            Operator::from_parts(
                OperationContext::default(),
                Arc::new(CloudService {
                    session: CloudSession::Memory(store.clone()),
                }),
            ),
            store,
        )
    }
    fn state(header: &sync::Header, key: &[u8; 32], actor: &str) -> sync::State {
        sync::State::new(
            ENDPOINT.into(),
            "iCloud Drive".into(),
            String::new(),
            header,
            key,
            actor.into(),
        )
    }
    #[test]
    fn endpoint_cannot_point_to_user_files_or_other_containers() {
        assert!(matches(ENDPOINT));
        for e in [
            "steamguard-icloud://other/",
            "steamguard-icloud://default/?secret=x",
            "file:///Users/user/vault",
            "steamguard-icloud://default/../",
        ] {
            assert!(!matches(e));
        }
    }
    #[tokio::test]
    async fn unconfigured_build_does_not_expose_cloud_credentials() {
        let status = icloud_status().await;
        assert!(!status.configured);
        assert!(!status.available);
    }
    #[tokio::test]
    async fn encrypted_library_discovery_merge_and_compaction_keep_concurrent_files() {
        let (op, store) = operator_fixture();
        let library = uuid::Uuid::new_v4().to_string();
        let (h, key) = sync::create_header(&library, "synthetic-sync-password").unwrap();
        storage::create(&op, &h).await.unwrap();
        assert_eq!(
            storage::libraries(&op).await.unwrap(),
            vec![library.clone()]
        );
        let bytes = storage::header(&op, &library).await.unwrap();
        assert!(sync::join_header(&bytes, &library, "wrong-password").is_err());
        sync::join_header(&bytes, &library, "synthetic-sync-password").unwrap();
        let mut vault = crate::vault::VaultData {
            sync: Some(state(&h, &key, "a")),
            ..Default::default()
        };
        let mut token = crate::models::Token::new(
            "private-name".into(),
            "totp".into(),
            b"private-secret".to_vec(),
        );
        token.notes = "private-note".into();
        vault.tokens.push(token);
        sync::record_local(&mut vault, "a").unwrap();
        let a = vault.sync.as_ref().unwrap();
        let first = storage::publish(&op, a, a.checkpoint("a").unwrap())
            .await
            .unwrap();
        let read = storage::snapshots(&op, a).await.unwrap();
        let mut b = state(&h, &key, "b");
        b.merge_bytes(&read[0].1, "b").unwrap();
        let concurrent = storage::publish(&op, &b, b.checkpoint("b").unwrap())
            .await
            .unwrap();
        let latest = storage::publish(&op, a, a.checkpoint("a").unwrap())
            .await
            .unwrap();
        storage::compact(&op, &library, std::slice::from_ref(&first), &latest)
            .await
            .unwrap();
        let remaining = storage::snapshots(&op, a).await.unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|v| v.0 == concurrent));
        assert!(remaining.iter().any(|v| v.0 == latest));
        assert!(remaining.iter().all(|v| v.0 != first));
        for bytes in store.lock().unwrap().files.values() {
            let text = String::from_utf8_lossy(bytes);
            for private in [
                "private-name",
                "private-secret",
                "private-note",
                "synthetic-sync-password",
            ] {
                assert!(!text.contains(private));
            }
        }
        assert!(op
            .write("../../vault.sgvault", b"plaintext".to_vec())
            .await
            .is_err());
    }
    #[tokio::test]
    async fn pending_upload_never_compacts_confirmed_history_or_queues_more_snapshots() {
        let (op, store) = operator_fixture();
        let library = uuid::Uuid::new_v4().to_string();
        let (h, key) = sync::create_header(&library, "synthetic-sync-password").unwrap();
        storage::create(&op, &h).await.unwrap();
        let state = state(&h, &key, "a");
        let first = storage::publish(&op, &state, state.checkpoint("a").unwrap())
            .await
            .unwrap();
        store.lock().unwrap().uploading = true;
        let error = storage::publish(&op, &state, state.checkpoint("a").unwrap())
            .await
            .unwrap_err();
        assert!(error.contains("iCloud"));
        assert!(store.lock().unwrap().files.contains_key(&first));
        let count = store.lock().unwrap().files.len();
        assert!(
            storage::publish(&op, &state, state.checkpoint("a").unwrap())
                .await
                .is_err()
        );
        assert_eq!(count, store.lock().unwrap().files.len());
        assert!(op.delete(&first).await.is_err());
        assert!(store.lock().unwrap().files.contains_key(&first));
        store.lock().unwrap().uploading = false;
        let newest = storage::publish(&op, &state, state.checkpoint("a").unwrap())
            .await
            .unwrap();
        storage::compact(&op, &library, std::slice::from_ref(&first), &newest)
            .await
            .unwrap();
        assert!(!store.lock().unwrap().files.contains_key(&first));
    }
}
