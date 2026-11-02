fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=macos/secure_access.m");
        cc::Build::new()
            .file("macos/secure_access.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-Werror")
            .compile("steamguard_secure_access");
        for framework in ["Foundation", "Security", "LocalAuthentication"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
