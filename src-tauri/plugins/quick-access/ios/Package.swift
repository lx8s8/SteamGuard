// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-quick-access",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-quick-access", type: .static, targets: ["tauri-plugin-quick-access"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-quick-access", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
