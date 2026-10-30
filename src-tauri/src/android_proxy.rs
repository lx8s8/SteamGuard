//! Android's system proxy/PAC configuration is exposed through ProxySelector.
//! reqwest's system-proxy feature covers desktop platforms, but not Android.
use jni::{
    objects::{JString, JValue},
    JavaVM,
};

pub fn system_proxy(url: &url::Url) -> Option<String> {
    // Only supply the origin to PAC/proxy selection, never a URL with Steam tokens.
    let origin = url.origin().ascii_serialization();
    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let result = env.with_local_frame(32, |env| -> jni::errors::Result<Option<String>> {
        let selector = env
            .call_static_method(
                "java/net/ProxySelector",
                "getDefault",
                "()Ljava/net/ProxySelector;",
                &[],
            )?
            .l()?;
        if selector.is_null() {
            return Ok(None);
        }
        let text = env.new_string(&origin)?;
        let uri = env.new_object(
            "java/net/URI",
            "(Ljava/lang/String;)V",
            &[JValue::Object(text.as_ref())],
        )?;
        let proxies = env
            .call_method(
                selector,
                "select",
                "(Ljava/net/URI;)Ljava/util/List;",
                &[JValue::Object(&uri)],
            )?
            .l()?;
        if env.call_method(&proxies, "size", "()I", &[])?.i()? == 0 {
            return Ok(None);
        }
        // Honor the system's first route. A DIRECT route must not be replaced by
        // a proxy from another application or a guessed localhost port.
        let proxy = env
            .call_method(proxies, "get", "(I)Ljava/lang/Object;", &[JValue::Int(0)])?
            .l()?;
        let kind = env
            .call_method(&proxy, "type", "()Ljava/net/Proxy$Type;", &[])?
            .l()?;
        let kind = env
            .call_method(kind, "name", "()Ljava/lang/String;", &[])?
            .l()?;
        let kind: String = env.get_string(&JString::from(kind))?.into();
        let scheme = match kind.as_str() {
            "DIRECT" => return Ok(None),
            "HTTP" => "http",
            "SOCKS" => "socks5h",
            _ => return Ok(None),
        };
        let address = env
            .call_method(proxy, "address", "()Ljava/net/SocketAddress;", &[])?
            .l()?;
        if address.is_null() || !env.is_instance_of(&address, "java/net/InetSocketAddress")? {
            return Ok(None);
        }
        let host = env
            .call_method(&address, "getHostString", "()Ljava/lang/String;", &[])?
            .l()?;
        let host: String = env.get_string(&JString::from(host))?.into();
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host
        };
        let port = env.call_method(address, "getPort", "()I", &[])?.i()?;
        if !(1..=65535).contains(&port) {
            return Ok(None);
        }
        let mut proxy_url =
            url::Url::parse(&format!("{scheme}://localhost")).expect("Static proxy scheme");
        if proxy_url.set_host(Some(&host)).is_err()
            || proxy_url.set_port(Some(port as u16)).is_err()
        {
            return Ok(None);
        }
        Ok(Some(proxy_url.to_string()))
    });
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result.ok().flatten()
}
