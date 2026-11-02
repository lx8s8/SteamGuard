//! Fixed-purpose native Google authorization. This plugin declares no frontend
//! invoke commands: access tokens travel SDK -> Rust -> HTTP client only.
use serde::Deserialize;
#[cfg(mobile)]
use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSession {
    pub account_id: String,
    pub access_token: String,
}
impl NativeSession {
    #[cfg(any(mobile, test))]
    fn validate(&self, expected: Option<&str>) -> Result<(), String> {
        if self.account_id.is_empty()
            || self.account_id.len() > 256
            || self.account_id.chars().any(char::is_control)
            || self.access_token.is_empty()
            || self.access_token.len() > 16384
            || self.access_token.chars().any(char::is_control)
        {
            return Err("Google 原生登录未返回有效凭据".into());
        }
        if expected.is_some_and(|value| value != self.account_id) {
            return Err("Google 登录账号已改变，请重新连接同步网盘".into());
        }
        Ok(())
    }
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    client_id: &'a str,
    expected_account_id: Option<&'a str>,
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Availability {
    available: bool,
}
pub struct CloudAuth<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}
fn client_id() -> &'static str {
    #[cfg(target_os = "android")]
    {
        option_env!("STEAMGUARD_GOOGLE_ANDROID_CLIENT_ID").unwrap_or("")
    }
    #[cfg(target_os = "ios")]
    {
        option_env!("STEAMGUARD_GOOGLE_IOS_CLIENT_ID").unwrap_or("")
    }
    #[cfg(not(mobile))]
    {
        ""
    }
}
fn valid_client_id(id: &str) -> bool {
    id.len() > ".apps.googleusercontent.com".len()
        && id.len() <= 256
        && id.ends_with(".apps.googleusercontent.com")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
}
impl<R: Runtime> CloudAuth<R> {
    pub fn configured(&self) -> bool {
        valid_client_id(client_id())
    }
    pub async fn availability(&self) -> Result<bool, String> {
        if !self.configured() {
            return Ok(false);
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin_async::<Availability>(
                    "availability",
                    Request {
                        client_id: client_id(),
                        expected_account_id: None,
                    },
                )
                .await
                .map(|result| result.available)
                .map_err(|_| "无法读取 Google 原生登录状态".into())
        }
        #[cfg(not(mobile))]
        {
            Ok(false)
        }
    }
    pub async fn authorize(&self) -> Result<NativeSession, String> {
        self.session(None).await
    }
    pub async fn token(&self, expected_account_id: &str) -> Result<NativeSession, String> {
        if expected_account_id.is_empty() || expected_account_id.len() > 256 {
            return Err("Google 登录账号无效，请重新连接".into());
        }
        self.session(Some(expected_account_id)).await
    }
    async fn session(&self, expected: Option<&str>) -> Result<NativeSession, String> {
        if !self.configured() {
            return Err("此构建尚未配置 Google 移动端登录，请使用其他同步方式".into());
        }
        #[cfg(mobile)]
        {
            let result: NativeSession = self
                .handle
                .run_mobile_plugin_async(
                    if expected.is_some() {
                        "token"
                    } else {
                        "authorize"
                    },
                    Request {
                        client_id: client_id(),
                        expected_account_id: expected,
                    },
                )
                .await
                .map_err(|_| "Google 授权已取消或已失效，请重新连接同步网盘")?;
            result.validate(expected)?;
            Ok(result)
        }
        #[cfg(not(mobile))]
        {
            let _ = expected;
            Err("此平台使用浏览器登录 Google Drive".into())
        }
    }
}
pub trait CloudAuthExt<R: Runtime>: Manager<R> {
    fn cloud_auth(&self) -> &CloudAuth<R> {
        self.state::<CloudAuth<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> CloudAuthExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_cloud_auth);
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cloud-auth")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin("com.kasen.steamguard.cloudauth", "CloudAuthPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_cloud_auth)?;
            #[cfg(not(mobile))]
            let _ = api;
            app.manage(CloudAuth::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _runtime: std::marker::PhantomData,
            });
            Ok(())
        })
        .on_event(|app, event| {
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = event {
                if !valid_client_id(client_id()) {
                    return;
                }
                let scheme = client_id().split('.').rev().collect::<Vec<_>>().join(".");
                for url in urls
                    .iter()
                    .filter(|url| url.scheme() == scheme && url.as_str().len() <= 16384)
                {
                    #[derive(Serialize)]
                    struct Callback<'a> {
                        url: &'a str,
                    }
                    let handle = app.clone();
                    let url = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle
                            .cloud_auth()
                            .handle
                            .run_mobile_plugin_async::<()>("handleUrl", Callback { url: &url })
                            .await;
                    });
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (app, event);
        })
        .build()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_config_and_account_switch_are_rejected() {
        for id in [
            "",
            "other",
            "apps.googleusercontent.com",
            "a.apps.googleusercontent.com/redirect",
            "a\n.apps.googleusercontent.com",
        ] {
            assert!(!valid_client_id(id));
        }
        assert!(valid_client_id("123-synthetic.apps.googleusercontent.com"));
        let session = NativeSession {
            account_id: "synthetic-account".into(),
            access_token: "synthetic-local-token".into(),
        };
        assert!(session.validate(Some("synthetic-account")).is_ok());
        assert!(session.validate(Some("other-account")).is_err());
        let empty = NativeSession {
            account_id: "synthetic-account".into(),
            access_token: "".into(),
        };
        assert!(empty.validate(None).is_err());
    }
}
