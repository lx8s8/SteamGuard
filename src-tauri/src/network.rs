use reqwest::{Client, IntoUrl, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    #[default]
    System,
    Direct,
    Manual,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSettings {
    pub mode: ProxyMode,
    pub proxy_url: String,
}

fn manual_proxy(settings: &NetworkSettings) -> Result<Option<reqwest::Proxy>, String> {
    if settings.mode != ProxyMode::Manual {
        return Ok(None);
    }
    let url = url::Url::parse(settings.proxy_url.trim())
        .map_err(|_| "请输入完整的代理地址，例如 http://127.0.0.1:7890")?;
    if !["http", "https", "socks5", "socks5h"].contains(&url.scheme()) || url.host_str().is_none() {
        return Err("代理仅支持 HTTP、HTTPS、SOCKS5 或 SOCKS5H".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/"].contains(&url.path())
    {
        return Err("代理地址只应包含协议、主机和端口，不支持用户名、密码或路径".into());
    }
    reqwest::Proxy::all(url.as_str())
        .map(Some)
        .map_err(|_| "代理地址无效".into())
}

fn build_client(settings: &NetworkSettings) -> Result<Client, String> {
    let proxy = manual_proxy(settings)?;
    let builder = Client::builder()
        .user_agent("okhttp/4.9.2")
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(30));
    let builder = match settings.mode {
        ProxyMode::Direct => builder.no_proxy(),
        ProxyMode::Manual => builder.no_proxy().proxy(proxy.ok_or("代理配置缺失")?),
        ProxyMode::System => {
            #[cfg(target_os = "android")]
            {
                builder.proxy(reqwest::Proxy::custom(crate::android_proxy::system_proxy))
            }
            #[cfg(not(target_os = "android"))]
            {
                builder
            }
        }
    };
    builder
        .build()
        .map_err(|_| "无法创建 Steam 网络客户端".into())
}

pub struct NetworkClient {
    inner: Mutex<(NetworkSettings, Client)>,
}
impl NetworkClient {
    pub fn new() -> Result<Self, String> {
        let settings = NetworkSettings::default();
        let client = build_client(&settings)?;
        Ok(Self {
            inner: Mutex::new((settings, client)),
        })
    }
    pub fn settings(&self) -> NetworkSettings {
        self.inner.lock().unwrap().0.clone()
    }
    pub fn configure(&self, settings: NetworkSettings) -> Result<(), String> {
        let client = build_client(&settings)?;
        *self.inner.lock().map_err(|_| "网络设置暂不可用")? = (settings, client);
        Ok(())
    }
    pub fn get(&self, url: impl IntoUrl) -> RequestBuilder {
        self.inner.lock().unwrap().1.get(url)
    }
    pub fn post(&self, url: impl IntoUrl) -> RequestBuilder {
        self.inner.lock().unwrap().1.post(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_proxy_rejects_credentials_and_non_proxy_urls() {
        for url in [
            "file:///private/test",
            "http://name:private-password@localhost:7890",
            "http://localhost:7890/path",
            "http://localhost:7890/?access_token=private",
        ] {
            let settings = NetworkSettings {
                mode: ProxyMode::Manual,
                proxy_url: url.into(),
            };
            let error = manual_proxy(&settings)
                .err()
                .expect("Invalid proxy must be rejected");
            assert!(!error.contains("private-password") && !error.contains("access_token"));
        }
        for url in [
            "http://127.0.0.1:7890",
            "https://proxy.example:443",
            "socks5h://localhost:1080",
        ] {
            assert!(manual_proxy(&NetworkSettings {
                mode: ProxyMode::Manual,
                proxy_url: url.into()
            })
            .is_ok());
        }
    }
}
