// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-private-clipboard",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-private-clipboard", type: .static, targets: ["tauri-plugin-private-clipboard"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-private-clipboard", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
