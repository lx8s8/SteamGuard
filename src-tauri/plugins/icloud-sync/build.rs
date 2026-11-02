fn main() {
    println!("cargo:rerun-if-env-changed=STEAMGUARD_ICLOUD_CONTAINER_ID");
    tauri_plugin::Builder::new(&[]).build();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "macos" || os == "ios" {
        println!("cargo:rerun-if-changed=apple/icloud.m");
        cc::Build::new()
            .file("apple/icloud.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-Werror")
            .compile("steamguard_icloud");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
