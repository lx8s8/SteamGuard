fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=macos/clipboard.m");
        cc::Build::new()
            .file("macos/clipboard.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-Werror")
            .compile("steamguard_clipboard");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
