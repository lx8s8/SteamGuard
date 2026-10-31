//! WebDAV transport is provided by Apache OpenDAL; all paths below are app-owned.
use super::{Header, State, MAX_DOCUMENT};
use crate::network::{NetworkSettings, ProxyMode};
use futures::StreamExt;
use opendal::{services::Webdav, ErrorKind, HttpTransporter, OperationContext, Operator};
use opendal::{Buffer, HttpBody, HttpTransport};
use opendal_http_transport_reqwest::ReqwestTransport;

struct StrictTransport(ReqwestTransport);
impl HttpTransport for StrictTransport {
    async fn fetch(&self, req: http::Request<Buffer>) -> opendal::Result<http::Response<HttpBody>> {
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
        let response = self.0.fetch(req).await?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return Err(opendal::Error::new(
                ErrorKind::PermissionDenied,
                "WebDAV authentication or permission denied",
            ));
        }
        if status == 429 {
            return Err(opendal::Error::new(
                ErrorKind::RateLimited,
                "WebDAV request limit",
            ));
        }
        if (300..400).contains(&status) {
            return Err(opendal::Error::new(
                ErrorKind::Unexpected,
                "WebDAV redirects are disabled",
            ));
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
        OperationContext::new().with_http_transport(HttpTransporter::new(StrictTransport(
            ReqwestTransport::new(client),
        ))),
    ))
}
fn root(library: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(library).map_err(|_| "同步库编号无效")?;
    Ok(format!("steamguard-sync-v1/{id}/"))
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
                                    (404, vec![], String::new())
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
        compact(&op, &library, &[first.clone()], &newest)
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
}
