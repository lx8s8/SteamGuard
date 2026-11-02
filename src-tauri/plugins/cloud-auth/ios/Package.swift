// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "tauri-plugin-cloud-auth",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-cloud-auth", type: .static, targets: ["tauri-plugin-cloud-auth"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/google/GoogleSignIn-iOS", exact: "10.1.0")
    ],
    targets: [.target(name: "tauri-plugin-cloud-auth", dependencies: [.byName(name: "Tauri"), .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS")], path: "Sources")],
    swiftLanguageModes: [.v5]
)
