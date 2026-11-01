//! WebDAV transport is provided by Apache OpenDAL; all paths below are app-owned.
use super::{Header, State, MAX_DOCUMENT};
use crate::network::{NetworkSettings, ProxyMode};
use futures::StreamExt;
use opendal::{services::Webdav, ErrorKind, HttpTransporter, OperationContext, Operator};
use opendal::{Buffer, HttpBody, HttpTransport};
use opendal_http_transport_reqwest::ReqwestTransport;

#[derive(Debug)]
struct HttpFailure {
    operation: &'static str,
    status: u16,
}
impl std::fmt::Display for HttpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (HTTP {})", self.operation, self.status)
    }
}
impl std::error::Error for HttpFailure {}
fn http_failure(operation: &'static str, status: u16, kind: ErrorKind) -> opendal::Error {
    opendal::Error::new(kind, "WebDAV request rejected")
        .set_source(HttpFailure { operation, status })
}
fn jianguoyun_compatibility(endpoint: &str) -> bool {
    url::Url::parse(endpoint)
        .ok()
        .is_some_and(|url| url.host_str() == Some("dav.jianguoyun.com"))
}
struct StrictTransport {
    inner: ReqwestTransport,
    missing_parent_conflict: bool,
}
impl HttpTransport for StrictTransport {
    async fn fetch(&self, req: http::Request<Buffer>) -> opendal::Result<http::Response<HttpBody>> {
        let operation = match req.method().as_str() {
            "PROPFIND" => "读取目录信息",
            "MKCOL" => "创建同步目录",
            "PUT" => "上传同步文件",
            "GET" => "下载同步文件",
            "DELETE" => "清理同步旧版本",
            _ => "访问同步网盘",
        };
        let limit = if req.method() == http::Method::GET {
            MAX_DOCUMENT * 2
        } else {
            2 * 1024 * 1024
        };
        if req.extensions().get::<opendal::HttpRedirect>().is_some() {
            return Err(opendal::Error::new(
                ErrorKind::Unexpected,
                "redirects are disabled",
            ));
        }
        let response = self.inner.fetch(req).await?;
        let status = response.status().as_u16();
        // Jianguoyun reports a missing parent collection as 409 for PROPFIND.
        // OpenDAL's recursive MKCOL walks parents only for NotFound errors.
        if self.missing_parent_conflict && status == 409 && operation == "读取目录信息" {
            return Err(http_failure(operation, status, ErrorKind::NotFound));
        }
        if status == 401 || status == 403 {
            return Err(http_failure(operation, status, ErrorKind::PermissionDenied));
        }
        if status == 429 {
            return Err(http_failure(operation, status, ErrorKind::RateLimited));
        }
        if (300..400).contains(&status) || (status >= 400 && ![404, 405].contains(&status)) {
            return Err(http_failure(operation, status, ErrorKind::Unexpected));
        }
        if response
            .headers()
            .get(http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|n| n > limit as u64)
        {
            return Err(opendal::Error::new(
                ErrorKind::Unexpected,
                "WebDAV response exceeds size limit",
            ));
        }
        let (parts, body) = response.into_parts();
        let body = body.map_inner(move |stream| {
            let mut remaining = limit;
            Box::new(stream.map(move |chunk| {
                let chunk = chunk?;
                remaining = remaining.checked_sub(chunk.len()).ok_or_else(|| {
                    opendal::Error::new(ErrorKind::Unexpected, "WebDAV response exceeds size limit")
                })?;
                Ok(chunk)
            }))
        });
        Ok(http::Response::from_parts(parts, body))
    }
}

fn error(e: opendal::Error) -> String {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(current) = cause {
        if let Some(f) = current.downcast_ref::<HttpFailure>() {
            let reason = match f.status {
                401 | 403 => "网盘拒绝访问，请检查账号、应用密码和目录权限",
                429 => "网盘请求过于频繁，请稍后重试",
                300..=399 => "网盘地址发生重定向，请填写最终 HTTPS WebDAV 地址",
                400 => "网盘不接受此目录或请求格式，请检查 WebDAV 地址和服务兼容性",
                409 => "上级目录不存在或无法创建，请检查目录权限",
                423 => "网盘文件暂时被占用，请稍后重试",
                507 => "网盘存储空间不足，请清理空间后重试",
                500..=599 => "网盘服务暂时不可用，请稍后重试",
                _ => "网盘拒绝了此操作，请检查目录权限或服务限制",
            };
            return format!("{}失败（HTTP {}）：{}", f.operation, f.status, reason);
        }
        if let Some(network) = current.downcast_ref::<reqwest_sync::Error>() {
            if network.is_timeout() {
                return "连接同步网盘超时，请检查网络或代理后重试".into();
            }
        }
        cause = current.source();
    }
    match e.kind() {
        ErrorKind::PermissionDenied => "网盘拒绝访问，请检查账号、应用密码和目录权限",
        ErrorKind::NotFound => "未找到同步库，请核对地址和同步库编号",
        ErrorKind::RateLimited => "网盘请求过于频繁，请稍后重试",
        ErrorKind::AlreadyExists => "同步目录已存在",
        _ => "连接同步网盘失败，请检查网络、HTTPS 证书和目录地址",
    }
    .into()
}
pub fn validate_endpoint(endpoint: &str) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint.trim()).map_err(|_| "请输入完整的 HTTPS WebDAV 地址")?;
    let allowed = url.scheme() == "https";
    #[cfg(test)]
    let allowed = allowed
        || url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| h == "127.0.0.1" || h == "localhost");
    if !allowed
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebDAV 仅支持 HTTPS，地址中不能包含账号、密码、参数或片段".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url.to_string())
}
pub fn client(
    endpoint: &str,
    username: &str,
    password: &str,
    network: &NetworkSettings,
) -> Result<Operator, String> {
    let endpoint = validate_endpoint(endpoint)?;
    client_with_compatibility(
        &endpoint,
        username,
        password,
        network,
        jianguoyun_compatibility(&endpoint),
    )
}
fn client_with_compatibility(
    endpoint: &str,
    username: &str,
    password: &str,
    network: &NetworkSettings,
    missing_parent_conflict: bool,
) -> Result<Operator, String> {
    let endpoint = validate_endpoint(endpoint)?;
    // Use the same WebPKI trust roots as the Steam client on every platform.
    // reqwest 0.13's default Android verifier otherwise needs an extra JVM component.
    let provider = rustls::crypto::ring::default_provider();
    let _ = provider.clone().install_default();
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS 配置无效")?
        .with_root_certificates(rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
        .with_no_client_auth();
    let builder = reqwest_sync::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest_sync::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(35))
        .user_agent("SteamGuard/Sync");
    #[cfg(not(test))]
    let builder = builder.https_only(true);
    let builder = match network.mode {
        ProxyMode::Direct => builder.no_proxy(),
        ProxyMode::Manual => builder
            .no_proxy()
            .proxy(reqwest_sync::Proxy::all(&network.proxy_url).map_err(|_| "同步代理配置无效")?),
        ProxyMode::System => {
            #[cfg(target_os = "android")]
            {
                builder.proxy(reqwest_sync::Proxy::custom(
                    crate::android_proxy::system_proxy,
                ))
            }
            #[cfg(not(target_os = "android"))]
            {
                builder
            }
        }
    };
    let client = builder.build().map_err(|_| "无法创建同步网络连接")?;
    let op = Operator::new(
        Webdav::default()
            .endpoint(endpoint.trim_end_matches('/'))
            .username(username)
            .password(password),
    )
    .map_err(error)?;
    Ok(op.with_context(
        OperationContext::new().with_http_transport(HttpTransporter::new(StrictTransport {
            inner: ReqwestTransport::new(client),
            missing_parent_conflict,
        })),
    ))
}
fn root(library: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(library).map_err(|_| "同步库编号无效")?;
    Ok(format!("steamguard-sync-v1/{id}/"))
}
/// Discover only application-owned directories. No keys or token contents are read.
pub async fn libraries(op: &Operator) -> Result<Vec<String>, String> {
    const DIRECTORY: &str = "steamguard-sync-v1/";
    let mut list = match op.lister(DIRECTORY).await {
        Ok(list) => list,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(error(e)),
    };
    let mut ids = std::collections::BTreeSet::new();
    let mut count = 0;
    while let Some(entry) = list.next().await {
        let entry = entry.map_err(error)?;
        count += 1;
        if count > 512 {
            return Err("网盘中的同步目录过多，请手动输入同步库编号".into());
        }
        let Some(relative) = entry.path().strip_prefix(DIRECTORY) else {
            return Err("网盘返回了目录外路径".into());
        };
        if !entry.metadata().is_dir() {
            continue;
        }
        let name = relative.trim_end_matches('/');
        if name.is_empty() || name.contains('/') {
            continue;
        }
        if let Ok(id) = uuid::Uuid::parse_str(name) {
            // Use the same canonical paths as existing libraries.
            if id.to_string() == name {
                ids.insert(name.to_string());
            }
        }
    }
    Ok(ids.into_iter().collect())
}
pub async fn create(op: &Operator, header: &Header) -> Result<(), String> {
    let root = root(&header.library)?;
    op.create_dir(&format!("{root}states/"))
        .await
        .map_err(error)?;
    op.write(
        &format!("{root}header.json"),
        serde_json::to_vec(header).map_err(|_| "无法编码同步库信息")?,
    )
    .await
    .map_err(error)?;
    let check = read(op, &format!("{root}header.json"), 16 * 1024).await?;
    if check != serde_json::to_vec(header).map_err(|_| "同步库校验失败")? {
        return Err("同步库写入校验失败".into());
    }
    Ok(())
}
pub async fn header(op: &Operator, library: &str) -> Result<Vec<u8>, String> {
    read(op, &format!("{}header.json", root(library)?), 16 * 1024).await
}
async fn optional_read(op: &Operator, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let meta = match op.stat(path).await {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    if meta.content_length() > limit as u64 {
        return Err("云端文件超过同步大小限制".into());
    }
    let bytes = match op.read_with(path).range(0..meta.content_length()).await {
        Ok(b) => b.to_vec(),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    if bytes.len() > limit {
        return Err("云端同步文件过大".into());
    }
    Ok(Some(bytes))
}
async fn read(op: &Operator, path: &str, limit: usize) -> Result<Vec<u8>, String> {
    optional_read(op, path, limit)
        .await?
        .ok_or_else(|| "未找到同步库，请核对地址和同步库编号".into())
}
pub async fn snapshots(op: &Operator, state: &State) -> Result<Vec<(String, Vec<u8>)>, String> {
    let directory = format!("{}states/", root(&state.library)?);
    // Another device may compact an entry between PROPFIND and GET. Relist the
    // directory so its replacement checkpoint is included before anything is deleted.
    for _ in 0..3 {
        let mut list = op.lister(&directory).await.map_err(error)?;
        let mut entries = vec![];
        while let Some(entry) = list.next().await {
            let entry = entry.map_err(error)?;
            let path = entry.path().to_string();
            let Some(name) = path.strip_prefix(&directory) else {
                return Err("网盘返回了目录外路径".into());
            };
            if name.is_empty() {
                continue;
            }
            if let Some(id) = name.strip_suffix(".sgsync") {
                if uuid::Uuid::parse_str(id).is_err() || name.contains('/') {
                    return Err("云端同步文件名称无效".into());
                }
            } else {
                continue;
            }
            if entries.len() >= 128 {
                return Err("云端待合并版本过多，请稍后重试".into());
            }
            entries.push(path);
        }
        let mut out = vec![];
        let mut total = 0;
        let mut changed = false;
        for path in entries {
            let Some(bytes) = optional_read(op, &path, MAX_DOCUMENT * 2).await? else {
                changed = true;
                break;
            };
            total += bytes.len();
            if total > 64 * 1024 * 1024 {
                return Err("云端同步数据过大".into());
            }
            out.push((path, bytes));
        }
        if !changed {
            return Ok(out);
        }
    }
    Err("其他设备正在合并云端版本，请稍后重试".into())
}
pub async fn publish(op: &Operator, state: &State, bytes: Vec<u8>) -> Result<String, String> {
    let path = format!(
        "{}states/{}.sgsync",
        root(&state.library)?,
        uuid::Uuid::new_v4()
    );
    op.write(&path, bytes.clone()).await.map_err(error)?;
    let verify = read(op, &path, MAX_DOCUMENT * 2).await?;
    if verify != bytes {
        return Err("云端写入校验失败，已保留原版本".into());
    }
    Ok(path)
}
pub async fn compact(
    op: &Operator,
    library: &str,
    old: &[String],
    keep: &str,
) -> Result<(), String> {
    let prefix = format!("{}states/", root(library)?);
    for path in old {
        if path == keep || !path.starts_with(&prefix) {
            continue;
        }
        let Some(id) = path
            .strip_prefix(&prefix)
            .and_then(|s| s.strip_suffix(".sgsync"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        op.delete(path).await.map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };
    pub(crate) struct Dav {
        pub endpoint: String,
        pub files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        pub replace_on_get: Arc<AtomicBool>,
        pub fail_after_put: Arc<AtomicBool>,
        pub provider_rules: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Dav {
        pub fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/dav/", listener.local_addr().unwrap());
            let files = Arc::new(Mutex::new(BTreeMap::<String, Vec<u8>>::from([(
                "/dav/".into(),
                vec![],
            )])));
            let shared = files.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let replace_on_get = Arc::new(AtomicBool::new(false));
            let replace = replace_on_get.clone();
            let fail_after_put = Arc::new(AtomicBool::new(false));
            let fail = fail_after_put.clone();
            let provider_rules = Arc::new(AtomicBool::new(false));
            let rules = provider_rules.clone();
            let mut fail_path = String::new();
            let thread = std::thread::spawn(move || {
                for socket in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut socket = socket.unwrap();
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut request = vec![];
                    let mut byte = [0];
                    while !request.ends_with(b"\r\n\r\n") {
                        if socket.read(&mut byte).unwrap_or(0) == 0 {
                            break;
                        }
                        request.push(byte[0]);
                        if request.len() > 16384 {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let mut lines = text.lines();
                    let first = lines
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .collect::<Vec<_>>();
                    if first.len() < 2 {
                        continue;
                    }
                    let method = first[0];
                    let path = first[1];
                    let headers = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
                        .collect::<BTreeMap<_, _>>();
                    let mut body = vec![
                        0u8;
                        headers
                            .get("content-length")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0)
                    ];
                    if socket.read_exact(&mut body).is_err() {
                        continue;
                    }
                    let (status, mut content, extra) = if headers
                        .get("authorization")
                        .map(String::as_str)
                        != Some("Basic Zml4dHVyZTpzeW50aGV0aWM=")
                    {
                        (401, vec![], String::new())
                    } else if path.starts_with("/dav/redirect/") {
                        (
                            302,
                            vec![],
                            "Location: http://127.0.0.1:1/stolen\r\n".into(),
                        )
                    } else if method == "GET" && path == fail_path {
                        fail_path.clear();
                        (503, vec![], String::new())
                    } else {
                        let mut files = shared.lock().unwrap();
                        if method == "GET"
                            && path.ends_with(".sgsync")
                            && replace.swap(false, Ordering::SeqCst)
                        {
                            if let Some(bytes) = files.remove(path) {
                                let parent = path.rsplit_once('/').unwrap().0;
                                files.insert(
                                    format!("{parent}/{}.sgsync", uuid::Uuid::new_v4()),
                                    bytes,
                                );
                            }
                        }
                        match method {
                            "MKCOL" => {
                                files.entry(path.to_string()).or_default();
                                (201, vec![], String::new())
                            }
                            "PUT" => {
                                if path.ends_with(".sgsync") && fail.swap(false, Ordering::SeqCst) {
                                    fail_path = path.to_string();
                                }
                                files.insert(path.to_string(), body);
                                (201, vec![], String::new())
                            }
                            "DELETE" => {
                                files.remove(path);
                                (204, vec![], String::new())
                            }
                            "GET" => match files.get(path) {
                                None => (404, vec![], String::new()),
                                Some(bytes) => {
                                    if let Some(range) = headers
                                        .get("range")
                                        .and_then(|v| v.strip_prefix("bytes="))
                                        .and_then(|v| v.split_once('-'))
                                    {
                                        let start = range.0.parse::<usize>().unwrap();
                                        let end = range
                                            .1
                                            .parse::<usize>()
                                            .unwrap_or(bytes.len().saturating_sub(1))
                                            .min(bytes.len().saturating_sub(1));
                                        if start >= bytes.len() {
                                            (416, vec![], String::new())
                                        } else {
                                            (
                                                206,
                                                bytes[start..=end].to_vec(),
                                                format!(
                                                    "Content-Range: bytes {start}-{end}/{}\r\n",
                                                    bytes.len()
                                                ),
                                            )
                                        }
                                    } else {
                                        (200, bytes.clone(), String::new())
                                    }
                                }
                            },
                            "PROPFIND" => {
                                if !files.contains_key(path) {
                                    let relative = path
                                        .strip_prefix("/dav/")
                                        .unwrap_or("")
                                        .trim_end_matches('/');
                                    let first = relative.split('/').next().unwrap_or("");
                                    let missing_sandbox =
                                        !files.contains_key(&format!("/dav/{first}/"));
                                    let status = if rules.load(Ordering::SeqCst)
                                        && relative.contains('/')
                                        && missing_sandbox
                                    {
                                        409
                                    } else {
                                        404
                                    };
                                    (
                                        status,
                                        b"synthetic-private-account must never enter diagnostics"
                                            .to_vec(),
                                        String::new(),
                                    )
                                } else {
                                    let depth =
                                        headers.get("depth").map(String::as_str).unwrap_or("0");
                                    let mut xml = String::from(
                                        "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\">",
                                    );
                                    for (key, bytes) in files.iter().filter(|(k, _)| {
                                        k.as_str() == path
                                            || (depth == "1"
                                                && k.starts_with(path)
                                                && !k[path.len()..]
                                                    .trim_end_matches('/')
                                                    .contains('/'))
                                    }) {
                                        xml.push_str(&format!("<D:response><D:href>{key}</D:href><D:propstat><D:prop><D:resourcetype>{}</D:resourcetype><D:getcontentlength>{}</D:getcontentlength><D:getlastmodified>Sat, 31 Oct 2026 00:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",if key.ends_with('/') {"<D:collection/>"}else{""},bytes.len()));
                                    }
                                    xml.push_str("</D:multistatus>");
                                    (
                                        207,
                                        xml.into_bytes(),
                                        "Content-Type: application/xml\r\n".into(),
                                    )
                                }
                            }
                            _ => (405, vec![], String::new()),
                        }
                    };
                    let header=format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",content.len());
                    let _ = socket.write_all(header.as_bytes());
                    let _ = socket.write_all(&content);
                    content.clear();
                }
            });
            Self {
                endpoint,
                files,
                stop,
                thread: Some(thread),
                replace_on_get,
                fail_after_put,
                provider_rules,
            }
        }
        pub fn op(&self, password: &str) -> Operator {
            client(
                &self.endpoint,
                "fixture",
                password,
                &NetworkSettings {
                    mode: ProxyMode::Direct,
                    proxy_url: String::new(),
                },
            )
            .unwrap()
        }
    }
    impl Drop for Dav {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let u = url::Url::parse(&self.endpoint).unwrap();
            let _ = TcpStream::connect((u.host_str().unwrap(), u.port().unwrap()));
            if let Some(t) = self.thread.take() {
                t.join().unwrap();
            }
        }
    }
    #[tokio::test]
    async fn standard_webdav_roundtrip_keeps_concurrent_uploads_and_rejects_bad_auth() {
        let dav = Dav::new();
        let op = dav.op("synthetic");
        let library = uuid::Uuid::new_v4().to_string();
        let (h, key) = super::super::create_header(&library, "synthetic-sync-password").unwrap();
        create(&op, &h).await.unwrap();
        let mut a = crate::vault::VaultData {
            sync: Some(State::new(
                dav.endpoint.clone(),
                "fixture".into(),
                "synthetic".into(),
                &h,
                &key,
                "a".into(),
            )),
            ..Default::default()
        };
        a.tokens.push(crate::models::Token::new(
            "private-token-name".into(),
            "totp".into(),
            b"private-token-secret".to_vec(),
        ));
        super::super::record_local(&mut a, "a").unwrap();
        let state = a.sync.as_ref().unwrap();
        let first = publish(&op, state, state.checkpoint("a").unwrap())
            .await
            .unwrap();
        let listed = snapshots(&op, state).await.unwrap();
        assert_eq!(listed.len(), 1);
        let mut b = State::new(
            dav.endpoint.clone(),
            "fixture".into(),
            "synthetic".into(),
            &h,
            &key,
            "b".into(),
        );
        b.merge_bytes(&listed[0].1, "b").unwrap();
        let concurrent = publish(&op, &b, b.checkpoint("b").unwrap()).await.unwrap();
        let newest = publish(&op, state, state.checkpoint("a").unwrap())
            .await
            .unwrap();
        compact(&op, &library, std::slice::from_ref(&first), &newest)
            .await
            .unwrap();
        let remaining = snapshots(&op, state).await.unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|v| v.0 == concurrent));
        assert!(remaining.iter().any(|v| v.0 == newest));
        assert!(remaining.iter().all(|v| v.0 != first));
        dav.replace_on_get.store(true, Ordering::SeqCst);
        let raced = snapshots(&op, state).await.unwrap();
        assert_eq!(raced.len(), 2);
        for (_, bytes) in raced {
            b.merge_bytes(&bytes, "b").unwrap();
        }
        let error = header(&dav.op("wrong"), &library).await.unwrap_err();
        assert!(error.contains("拒绝访问"));
        assert!(!error.contains("wrong"));
        for bytes in dav.files.lock().unwrap().values() {
            let s = String::from_utf8_lossy(bytes);
            assert!(!s.contains("private-token-name"));
            assert!(!s.contains("private-token-secret"));
        }
    }
    #[tokio::test]
    async fn discovery_is_read_only_lists_existing_libraries_and_handles_empty_accounts() {
        let dav = Dav::new();
        dav.provider_rules.store(true, Ordering::SeqCst);
        let op = client_with_compatibility(
            &dav.endpoint,
            "fixture",
            "synthetic",
            &NetworkSettings {
                mode: ProxyMode::Direct,
                proxy_url: String::new(),
            },
            true,
        )
        .unwrap();
        let before = dav.files.lock().unwrap().clone();
        assert!(libraries(&op).await.unwrap().is_empty());
        assert_eq!(*dav.files.lock().unwrap(), before);
        let ids = [
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        ];
        for id in &ids {
            let (header, _) = super::super::create_header(id, "synthetic-sync-password").unwrap();
            create(&op, &header).await.unwrap();
        }
        {
            let mut files = dav.files.lock().unwrap();
            files.insert("/dav/private-unrelated-file".into(), b"private".to_vec());
            files.insert("/dav/steamguard-sync-v1/not-a-library/".into(), vec![]);
            files.insert(
                format!("/dav/steamguard-sync-v1/{}", uuid::Uuid::new_v4()),
                vec![],
            );
        }
        let before = dav.files.lock().unwrap().clone();
        let mut expected = ids.to_vec();
        expected.sort();
        assert_eq!(libraries(&op).await.unwrap(), expected);
        assert_eq!(*dav.files.lock().unwrap(), before);
        assert!(libraries(&dav.op("wrong"))
            .await
            .unwrap_err()
            .contains("拒绝访问"));
    }
    #[tokio::test]
    async fn redirects_and_non_https_credentials_in_urls_are_rejected() {
        let dav = Dav::new();
        let op = client(
            &format!("{}redirect/", dav.endpoint),
            "fixture",
            "synthetic",
            &NetworkSettings::default(),
        )
        .unwrap();
        assert!(header(&op, &uuid::Uuid::new_v4().to_string())
            .await
            .is_err());
        for endpoint in [
            "http://example.com/dav/",
            "https://user:password@example.com/dav/",
            "https://example.com/dav/?token=secret",
            "file:///tmp/data",
        ] {
            assert!(validate_endpoint(endpoint).is_err());
        }
    }
    #[test]
    fn jianguoyun_compatibility_only_matches_the_official_host() {
        for endpoint in [
            "https://dav.jianguoyun.com/dav/",
            "https://dav.jianguoyun.com/dav/custom/",
        ] {
            assert!(jianguoyun_compatibility(endpoint));
        }
        for endpoint in [
            "https://dav.jianguoyun.com.evil.example/dav/",
            "https://example.com/dav/",
        ] {
            assert!(!jianguoyun_compatibility(endpoint));
        }
    }
    #[tokio::test]
    async fn provider_missing_parent_conflict_is_walked_without_changing_existing_paths() {
        let dav = Dav::new();
        dav.provider_rules.store(true, Ordering::SeqCst);
        let network = NetworkSettings {
            mode: ProxyMode::Direct,
            proxy_url: String::new(),
        };
        let (h, key) = super::super::create_header(
            &uuid::Uuid::new_v4().to_string(),
            "synthetic-sync-password",
        )
        .unwrap();
        let generic =
            client_with_compatibility(&dav.endpoint, "fixture", "synthetic", &network, false)
                .unwrap();
        let failure = create(&generic, &h).await.unwrap_err();
        assert!(failure.contains("HTTP 409"));
        assert!(!failure.contains("synthetic-private-account"));
        let op = client_with_compatibility(&dav.endpoint, "fixture", "synthetic", &network, true)
            .unwrap();
        create(&op, &h).await.unwrap();
        let state = State::new(
            dav.endpoint.clone(),
            "fixture".into(),
            "synthetic".into(),
            &h,
            &key,
            "device".into(),
        );
        let path = publish(&op, &state, state.checkpoint("actor").unwrap())
            .await
            .unwrap();
        let files = snapshots(&op, &state).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, path);
        assert!(dav
            .files
            .lock()
            .unwrap()
            .keys()
            .any(|p| p.starts_with("/dav/steamguard-sync-v1/")));
        assert!(!dav
            .files
            .lock()
            .unwrap()
            .keys()
            .any(|p| p.starts_with("/dav/SteamGuard/")));
        let missing = format!(
            "{}missing/header.json",
            root(&uuid::Uuid::new_v4().to_string()).unwrap()
        );
        assert!(optional_read(&op, &missing, 16384).await.unwrap().is_none());
    }
    #[tokio::test]
    #[ignore = "Explicit user-authorized WebDAV probe; credentials via hidden stdin, synthetic tokens only"]
    async fn live_jianguoyun_encrypted_sync_probe() {
        use zeroize::{Zeroize, Zeroizing};
        #[derive(serde::Deserialize)]
        struct Credentials {
            username: String,
            password: String,
        }
        impl Drop for Credentials {
            fn drop(&mut self) {
                self.username.zeroize();
                self.password.zeroize();
            }
        }
        let input = Zeroizing::new(
            rpassword::prompt_password("WebDAV credentials JSON (hidden): ").expect("hidden input"),
        );
        let credentials: Credentials =
            serde_json::from_str(&input).expect("credential input must be JSON");
        let endpoint = "https://dav.jianguoyun.com/dav/";
        let network = NetworkSettings {
            mode: ProxyMode::Direct,
            proxy_url: String::new(),
        };
        let library = uuid::Uuid::new_v4().to_string();
        let (h, key) =
            super::super::create_header(&library, &uuid::Uuid::new_v4().to_string()).unwrap();
        let legacy = client_with_compatibility(
            endpoint,
            &credentials.username,
            &credentials.password,
            &network,
            false,
        )
        .unwrap();
        let absent = format!(
            "sgcheck{}/{}/states/",
            &uuid::Uuid::new_v4().simple().to_string()[..8],
            uuid::Uuid::new_v4()
        );
        let baseline = legacy.stat(&absent).await.unwrap_err();
        assert!(error(baseline).contains("HTTP 409"));
        eprintln!("Missing-parent HTTP 409 from real provider: reproduced");
        let op = client(
            endpoint,
            &credentials.username,
            &credentials.password,
            &network,
        )
        .unwrap();
        assert!(op
            .stat(&absent)
            .await
            .is_err_and(|e| e.kind() == ErrorKind::NotFound));
        eprintln!("Missing-parent compatibility: passed");
        let mut paths = vec![];
        let result: Result<(), String> = async {
            create(&op, &h).await?;
            eprintln!("Original storage layout and encrypted header: passed");
            if !libraries(&op).await?.contains(&library) {
                return Err("synthetic library was not discovered".into());
            }
            eprintln!("Existing-library discovery on real provider: passed");
            let mut a = crate::vault::VaultData {
                sync: Some(State::new(
                    endpoint.into(),
                    credentials.username.clone(),
                    credentials.password.clone(),
                    &h,
                    &key,
                    "synthetic-a".into(),
                )),
                ..Default::default()
            };
            a.tokens.push(crate::models::Token::new(
                "Synthetic sync probe".into(),
                "totp".into(),
                b"synthetic-not-a-user-token".to_vec(),
            ));
            a.groups.push("Synthetic".into());
            super::super::record_local(&mut a, "actor-a")?;
            let state = a.sync.as_ref().unwrap();
            paths.push(publish(&op, state, state.checkpoint("actor-a")?).await?);
            let files = snapshots(&op, state).await?;
            let mut b = crate::vault::VaultData {
                sync: Some(State::new(
                    endpoint.into(),
                    credentials.username.clone(),
                    credentials.password.clone(),
                    &h,
                    &key,
                    "synthetic-b".into(),
                )),
                ..Default::default()
            };
            for (_, bytes) in files {
                b.sync.as_mut().unwrap().merge_bytes(&bytes, "actor-b")?;
            }
            super::super::apply(&mut b, "actor-b")?;
            if b.tokens.len() != 1
                || b.tokens[0].secret != a.tokens[0].secret
                || b.groups != a.groups
            {
                return Err("synthetic roundtrip mismatch".into());
            }
            b.tokens[0].name = "Synthetic merged edit".into();
            super::super::record_local(&mut b, "actor-b")?;
            let state = b.sync.as_ref().unwrap();
            paths.push(publish(&op, state, state.checkpoint("actor-b")?).await?);
            compact(&op, &library, &paths[..1], &paths[1]).await?;
            let remaining = snapshots(&op, state).await?;
            if remaining.len() != 1 {
                return Err("synthetic compaction mismatch".into());
            }
            a.sync
                .as_mut()
                .unwrap()
                .merge_bytes(&remaining[0].1, "actor-a")?;
            super::super::apply(&mut a, "actor-a")?;
            if a.tokens[0].name != "Synthetic merged edit" {
                return Err("synthetic merge mismatch".into());
            }
            for token in &mut a.tokens {
                token.erase();
            }
            for token in &mut b.tokens {
                token.erase();
            }
            eprintln!("Encrypted upload/readback, second device, merge and compaction: passed");
            Ok(())
        }
        .await;
        for p in &paths {
            op.delete(p)
                .await
                .map_err(error)
                .expect("remove synthetic checkpoint");
        }
        for p in [
            format!("{}header.json", root(&library).unwrap()),
            format!("{}states/", root(&library).unwrap()),
            root(&library).unwrap(),
        ] {
            if op.stat(&p).await.is_ok() {
                op.delete(&p)
                    .await
                    .map_err(error)
                    .expect("remove synthetic library");
            }
        }
        eprintln!("Synthetic library cleanup: passed");
        assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    }
}
