fn main() {
    println!("cargo:rerun-if-env-changed=STEAMGUARD_APP_GROUP");
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let group = std::env::var("STEAMGUARD_APP_GROUP").unwrap_or_default();
        if !group.is_empty() {
            assert!(
                group.starts_with("group.")
                    && group.len() <= 200
                    && group
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)),
                "Invalid Apple App Group"
            );
        }
        tauri_plugin::mobile::update_info_plist(|info| {
            if !group.is_empty() {
                info.insert("SteamGuardAppGroup".into(), group.into());
            }
            let mut entry = plist::Dictionary::new();
            entry.insert("CFBundleURLName".into(), "steamguard.system-entry".into());
            entry.insert(
                "CFBundleURLSchemes".into(),
                plist::Value::Array(vec!["steamguard".into()]),
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
                    .and_then(|v| v.get("CFBundleURLName"))
                    .and_then(plist::Value::as_string)
                    != Some("steamguard.system-entry")
            });
            entries.push(plist::Value::Dictionary(entry));
        })
        .expect("Cannot configure system-entry URL handler");
    }
}
