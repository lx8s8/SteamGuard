//! Fixed-purpose Apple iCloud document access. No generic filesystem or credential
//! commands are exposed to JavaScript; only encrypted sync files cross this bridge.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub supported: bool,
    pub configured: bool,
    pub available: bool,
    pub revision: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Entry {
    pub path: String,
    pub directory: bool,
    pub size: u64,
}
#[derive(Deserialize)]
struct Response {
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    status: String,
    #[serde(default)]
    session: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    data: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    directory: bool,
    #[serde(default)]
    entries: Vec<Entry>,
}
#[derive(Clone, Debug)]
pub struct Failure(pub String);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for Failure {}
impl Failure {
    pub fn message(&self) -> &'static str {
        match self.0.as_str() {
            "notFound" => "未找到 iCloud 同步文件",
            "pending" => "iCloud 正在上传或下载，请稍后重试",
            "cancelled" => "iCloud 同步已取消",
            "conflict" => "iCloud 文件存在版本冲突，请稍后重试",
            "bounds" => "iCloud 同步文件或目录超过限制",
            "account" => "iCloud 账号已变化，请重新连接同步库",
            _ => "iCloud 暂不可用，请检查系统账号、网络及应用授权",
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe extern "C" {
    fn steamguard_icloud_call(request: *const u8, length: usize) -> *mut std::ffi::c_char;
    fn steamguard_icloud_free(value: *mut std::ffi::c_char);
}
fn invoke(value: serde_json::Value) -> Result<Response, Failure> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let bytes = serde_json::to_vec(&value).map_err(|_| Failure("bounds".into()))?;
        let pointer = unsafe { steamguard_icloud_call(bytes.as_ptr(), bytes.len()) };
        if pointer.is_null() {
            return Err(Failure("unavailable".into()));
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr(pointer) }.to_bytes();
        let result = if bytes.len() <= 48 * 1024 * 1024 {
            serde_json::from_slice::<Response>(bytes).map_err(|_| Failure("bounds".into()))
        } else {
            Err(Failure("bounds".into()))
        };
        unsafe { steamguard_icloud_free(pointer) };
        let result = result?;
        if result.status != "ok" {
            return Err(Failure(result.status));
        }
        Ok(result)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = value;
        Err(Failure("unavailable".into()))
    }
}
fn container() -> &'static str {
    option_env!("STEAMGUARD_ICLOUD_CONTAINER_ID").unwrap_or("")
}
fn valid_container(value: &str) -> bool {
    value.starts_with("iCloud.")
        && value.len() > 7
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
}
#[derive(Default)]
struct SessionState {
    id: Option<String>,
    generation: u64,
    opening: bool,
}
#[derive(Clone, Default)]
pub struct ICloud {
    session: Arc<Mutex<SessionState>>,
}
impl ICloud {
    pub fn configured(&self) -> bool {
        cfg!(any(target_os = "macos", target_os = "ios")) && valid_container(container())
    }
    pub async fn availability(&self) -> Availability {
        let supported = cfg!(any(target_os = "macos", target_os = "ios"));
        let configured = self.configured();
        if !configured {
            return Availability {
                supported,
                configured,
                available: false,
                revision: 0,
            };
        }
        let this = self.clone();
        let result=tauri::async_runtime::spawn_blocking(move||{
            let session=this.session.lock().ok().and_then(|v|v.id.clone());
            invoke(serde_json::json!({"op":"availability","container":container(),"session":session.unwrap_or_default()}))
        }).await.ok().and_then(Result::ok);
        Availability {
            supported,
            configured,
            available: result.is_some(),
            revision: result.map(|r| r.revision).unwrap_or(0),
        }
    }
    pub fn generation(&self) -> u64 {
        self.session
            .lock()
            .map(|s| s.generation)
            .unwrap_or(u64::MAX)
    }
    pub async fn connect_at(&self, expected: u64) -> Result<Session, Failure> {
        if !self.configured() {
            return Err(Failure("unavailable".into()));
        }
        let this = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            {
                let mut slot = this
                    .session
                    .lock()
                    .map_err(|_| Failure("unavailable".into()))?;
                if slot.generation != expected {
                    return Err(Failure("cancelled".into()));
                }
                if let Some(id) = &slot.id {
                    return Ok(Session { id: id.clone() });
                }
                if slot.opening {
                    return Err(Failure("pending".into()));
                }
                slot.opening = true;
            }
            // Never hold the Rust mutex while Foundation synchronizes on main.
            let opened = invoke(serde_json::json!({"op":"open","container":container()}));
            let mut slot = this
                .session
                .lock()
                .map_err(|_| Failure("unavailable".into()))?;
            if slot.generation != expected {
                drop(slot);
                if let Ok(response) = opened {
                    let _ = invoke(serde_json::json!({"op":"close","session":response.session}));
                }
                return Err(Failure("cancelled".into()));
            }
            slot.opening = false;
            let response = opened?;
            if response.session.is_empty() || response.session.len() > 100 {
                return Err(Failure("unavailable".into()));
            }
            slot.id = Some(response.session.clone());
            Ok(Session {
                id: response.session,
            })
        })
        .await
        .map_err(|_| Failure("unavailable".into()))?
    }
    pub fn stop(&self) {
        let id = if let Ok(mut slot) = self.session.lock() {
            slot.generation = slot.generation.wrapping_add(1);
            slot.opening = false;
            slot.id.take()
        } else {
            None
        };
        if let Some(id) = id {
            let _ = invoke(serde_json::json!({"op":"close","session":id}));
        }
    }
}
#[derive(Clone, Debug)]
pub struct Session {
    id: String,
}
impl Session {
    async fn call(&self, op: &str, path: &str, data: Option<String>) -> Result<Response, Failure> {
        validate_path(path)?;
        let request = serde_json::json!({"op":op,"session":self.id,"path":path,"data":data});
        tauri::async_runtime::spawn_blocking(move || invoke(request))
            .await
            .map_err(|_| Failure("unavailable".into()))?
    }
    pub async fn stat(&self, path: &str) -> Result<Entry, Failure> {
        let r = self.call("stat", path, None).await?;
        Ok(Entry {
            path: path.into(),
            directory: r.directory,
            size: r.size,
        })
    }
    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, Failure> {
        let r = self.call("list", path, None).await?;
        if r.entries.len() > 512 {
            return Err(Failure("bounds".into()));
        }
        for e in &r.entries {
            validate_path(&e.path)?;
        }
        Ok(r.entries)
    }
    pub async fn mkdir(&self, path: &str) -> Result<(), Failure> {
        self.call("mkdir", path, None).await.map(|_| ())
    }
    pub async fn read(&self, path: &str) -> Result<Vec<u8>, Failure> {
        use base64::Engine;
        let r = self.call("read", path, None).await?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(r.data)
            .map_err(|_| Failure("bounds".into()))?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(Failure("bounds".into()));
        }
        Ok(bytes)
    }
    pub async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), Failure> {
        use base64::Engine;
        validate_encrypted(path, bytes)?;
        self.call(
            "write",
            path,
            Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        )
        .await
        .map(|_| ())
    }
    pub async fn delete(&self, path: &str) -> Result<(), Failure> {
        if !path.ends_with(".sgsync") {
            return Err(Failure("bounds".into()));
        }
        self.call("delete", path, None).await.map(|_| ())
    }
}
pub fn validate_path(path: &str) -> Result<(), Failure> {
    let parts = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    let uuid = |value: &str| {
        value.len() == 36
            && value.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
                }
            })
    };
    let valid = matches!(parts.as_slice(), ["steamguard-sync-v1"])
        || matches!(parts.as_slice(),["steamguard-sync-v1",id] if uuid(id))
        || matches!(parts.as_slice(),["steamguard-sync-v1",id,"states"] if uuid(id))
        || matches!(parts.as_slice(),["steamguard-sync-v1",id,"header.json"] if uuid(id))
        || matches!(parts.as_slice(),["steamguard-sync-v1",id,"states",file] if uuid(id)&&file.strip_suffix(".sgsync").is_some_and(uuid));
    if !valid || path.len() > 200 {
        Err(Failure("bounds".into()))
    } else {
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedEnvelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedHeader {
    format: String,
    version: u8,
    library: String,
    kdf: String,
    salt: String,
    check: EncryptedEnvelope,
}
fn validate_encrypted(path: &str, data: &[u8]) -> Result<(), Failure> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    validate_path(path)?;
    let invalid = || Failure("bounds".into());
    if data.is_empty() || data.len() > 32 * 1024 * 1024 {
        return Err(invalid());
    }
    let envelope = if path.ends_with("/header.json") {
        if data.len() > 16384 {
            return Err(invalid());
        }
        let header: EncryptedHeader = serde_json::from_slice(data).map_err(|_| invalid())?;
        if header.format != "SteamGuard Sync"
            || header.version != 1
            || header.kdf != "argon2id-v19-m19456-t2-p1"
            || Some(header.library.as_str()) != path.split('/').nth(1)
            || STANDARD.decode(header.salt).map_err(|_| invalid())?.len() != 16
        {
            return Err(invalid());
        }
        header.check
    } else if path.ends_with(".sgsync") {
        serde_json::from_slice(data).map_err(|_| invalid())?
    } else {
        return Err(invalid());
    };
    if envelope.version != 1
        || STANDARD
            .decode(envelope.nonce)
            .map_err(|_| invalid())?
            .len()
            != 12
        || STANDARD
            .decode(envelope.ciphertext)
            .map_err(|_| invalid())?
            .len()
            < 16
    {
        return Err(invalid());
    }
    Ok(())
}
pub trait ICloudExt<R: Runtime>: Manager<R> {
    fn icloud_sync(&self) -> &ICloud {
        self.state::<ICloud>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> ICloudExt<R> for T {}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("icloud-sync")
        .setup(|app, _| {
            app.manage(ICloud::default());
            Ok(())
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<ICloud>().stop();
            }
        })
        .build()
}
#[cfg(test)]
mod tests {
    use super::*;
    const ROOT: &str = "steamguard-sync-v1/11111111-1111-4111-8111-111111111111";
    #[test]
    fn rejects_unscoped_paths_and_native_validator_matches() {
        let paths=["../vault.sgvault","steamguard-sync-v1/a/header.json","/steamguard-sync-v1/","steamguard-sync-v1//states/","steamguard-sync-v1////","steamguard-sync-v1/11111111-1111-4111-8111-111111111111/states/../header.json","steamguard-sync-v1/","steamguard-sync-v1/11111111-1111-4111-8111-111111111111/","steamguard-sync-v1/11111111-1111-4111-8111-111111111111/states/22222222-2222-4222-8222-222222222222.sgsync"];
        for (index, path) in paths.iter().enumerate() {
            let valid = validate_path(path).is_ok();
            assert_eq!(valid, index >= 6, "{path}");
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                unsafe extern "C" {
                    fn steamguard_icloud_validate_path(path: *const std::ffi::c_char) -> i32;
                }
                let value = std::ffi::CString::new(*path).unwrap();
                assert_eq!(
                    unsafe { steamguard_icloud_validate_path(value.as_ptr()) } != 0,
                    valid,
                    "native: {path}"
                );
            }
        }
        assert!(valid_container("iCloud.com.example.Authenticator"));
        assert!(!valid_container("iCloud.test/path"));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_root_rejects_symlinks_in_documents_or_app_directory() {
        use std::{
            ffi::CString,
            fs,
            os::unix::fs::symlink,
            time::{SystemTime, UNIX_EPOCH},
        };
        unsafe extern "C" {
            fn steamguard_icloud_root_valid(path: *const std::ffi::c_char) -> i32;
        }
        let dir = std::env::temp_dir().join(format!(
            "steamguard-icloud-synthetic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let base = dir.join("container");
        let documents = base.join("Documents");
        let app = documents.join("SteamGuard");
        let outside = dir.join("outside");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let path = CString::new(base.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { steamguard_icloud_root_valid(path.as_ptr()) }, 1);
        fs::remove_dir(&app).unwrap();
        symlink(&outside, &app).unwrap();
        assert_eq!(unsafe { steamguard_icloud_root_valid(path.as_ptr()) }, 0);
        fs::remove_file(&app).unwrap();
        fs::remove_dir(&documents).unwrap();
        symlink(&outside, &documents).unwrap();
        assert_eq!(unsafe { steamguard_icloud_root_valid(path.as_ptr()) }, 0);
        fs::remove_file(documents).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn encrypted_bridge_rejects_extra_plaintext_and_malformed_envelopes() {
        let path = format!("{ROOT}/states/22222222-2222-4222-8222-222222222222.sgsync");
        let envelope = serde_json::json!({"version":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA=="});
        assert!(validate_encrypted(&path, &serde_json::to_vec(&envelope).unwrap()).is_ok());
        let mut extra = envelope.clone();
        extra["notes"] = serde_json::json!("private plaintext");
        assert!(validate_encrypted(&path, &serde_json::to_vec(&extra).unwrap()).is_err());
        for field in ["nonce", "ciphertext"] {
            let mut bad = envelope.clone();
            bad[field] = serde_json::json!("bad");
            assert!(validate_encrypted(&path, &serde_json::to_vec(&bad).unwrap()).is_err());
        }
        assert!(validate_encrypted(&path, br#"{"secret":"plaintext"}"#).is_err());
        let mut header = serde_json::json!({"format":"SteamGuard Sync","version":1,"library":"11111111-1111-4111-8111-111111111111","kdf":"argon2id-v19-m19456-t2-p1","salt":"AAAAAAAAAAAAAAAAAAAAAA==","check":envelope});
        assert!(validate_encrypted(
            &format!("{ROOT}/header.json"),
            &serde_json::to_vec(&header).unwrap()
        )
        .is_ok());
        header["library"] = serde_json::json!("22222222-2222-4222-8222-222222222222");
        assert!(validate_encrypted(
            &format!("{ROOT}/header.json"),
            &serde_json::to_vec(&header).unwrap()
        )
        .is_err());
    }
    #[test]
    fn stop_invalidates_an_inflight_open_without_touching_an_account() {
        let cloud = ICloud::default();
        let epoch = cloud.generation();
        {
            let mut state = cloud.session.lock().unwrap();
            state.opening = true;
        }
        cloud.stop();
        let state = cloud.session.lock().unwrap();
        assert_ne!(state.generation, epoch);
        assert!(!state.opening);
        assert!(state.id.is_none());
    }
}
