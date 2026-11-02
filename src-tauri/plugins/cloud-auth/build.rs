fn main() {
    println!("cargo:rerun-if-env-changed=STEAMGUARD_GOOGLE_ANDROID_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=STEAMGUARD_GOOGLE_IOS_CLIENT_ID");
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        stage_ios_resources().expect("Cannot stage Google iOS SDK resource bundles");
        let client = std::env::var("STEAMGUARD_GOOGLE_IOS_CLIENT_ID").unwrap_or_default();
        if !client.is_empty() {
            assert!(
                client.ends_with(".apps.googleusercontent.com")
                    && client
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)),
                "Invalid Google iOS client ID"
            );
            let scheme = client.split('.').rev().collect::<Vec<_>>().join(".");
            tauri_plugin::mobile::update_info_plist(|info| {
                info.insert("GIDClientID".into(), client.into());
                let mut url_type = plist::Dictionary::new();
                url_type.insert("CFBundleURLName".into(), "steamguard.google-signin".into());
                url_type.insert(
                    "CFBundleURLSchemes".into(),
                    plist::Value::Array(vec![scheme.into()]),
                );
                if !info.contains_key("CFBundleURLTypes") {
                    info.insert("CFBundleURLTypes".into(), plist::Value::Array(vec![]));
                }
                let entries = info
                    .get_mut("CFBundleURLTypes")
                    .and_then(plist::Value::as_array_mut)
                    .expect("CFBundleURLTypes must be an array");
                entries.retain(|value| {
                    value
                        .as_dictionary()
                        .and_then(|value| value.get("CFBundleURLName"))
                        .and_then(plist::Value::as_string)
                        != Some("steamguard.google-signin")
                });
                entries.push(plist::Value::Dictionary(url_type));
            })
            .expect("Cannot configure Google iOS callback URL");
        }
    }
}

// Tauri links a SwiftPM static library; SwiftPM does not copy its companion
// resource bundles into the host application. Keep platform/profile staging
// separate so an incremental Xcode build cannot pick simulator resources for a
// physical device. The host post-build phase copies these before code signing.
#[cfg(target_os = "macos")]
fn stage_ios_resources() -> std::io::Result<()> {
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    fn products(path: &Path, depth: u8) -> std::io::Result<Option<PathBuf>> {
        if path.join("libtauri-plugin-cloud-auth.a").is_file() {
            return Ok(Some(path.to_owned()));
        }
        if depth == 0 {
            return Ok(None);
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if let Some(found) = products(&entry.path(), depth - 1)? {
                    return Ok(Some(found));
                }
            }
        }
        Ok(None)
    }
    fn copy_changed(source: &Path, target: &Path) -> std::io::Result<()> {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let destination = target.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_changed(&entry.path(), &destination)?;
            } else if entry.file_type()?.is_file() {
                let bytes = fs::read(entry.path())?;
                if fs::read(&destination).ok().as_deref() != Some(bytes.as_slice()) {
                    fs::write(destination, bytes)?;
                }
            }
        }
        for entry in fs::read_dir(target)? {
            let entry = entry?;
            if !source.join(entry.file_name()).exists() {
                if entry.file_type()?.is_dir() {
                    fs::remove_dir_all(entry.path())?;
                } else {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
        .join("swift-rs/tauri-plugin-cloud-auth");
    let source = products(&output, 4)?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "SwiftPM products not found")
    })?;
    let target = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("ios/.tauri-resources")
        .join(std::env::var("TARGET").unwrap())
        .join(std::env::var("PROFILE").unwrap());
    let mut staged = Vec::new();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && entry.path().extension().is_some_and(|ext| ext == "bundle")
        {
            copy_changed(&entry.path(), &target.join(entry.file_name()))?;
            staged.push(entry.file_name());
        }
    }
    if !staged
        .iter()
        .any(|name| name == "GoogleSignIn_GoogleSignIn.bundle")
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "GoogleSignIn resource bundle not found",
        ));
    }
    // Remove obsolete bundles after SDK changes, without touching source files.
    for entry in fs::read_dir(&target)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && !staged.contains(&entry.file_name()) {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
