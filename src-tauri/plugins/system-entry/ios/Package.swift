// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "tauri-plugin-system-entry", platforms: [.iOS(.v15)], products: [.library(name:"tauri-plugin-system-entry",type:.static,targets:["tauri-plugin-system-entry"])], dependencies:[.package(name:"Tauri",path:"../.tauri/tauri-api")], targets:[.target(name:"tauri-plugin-system-entry",dependencies:[.byName(name:"Tauri")],path:"Sources")],swiftLanguageModes:[.v5])
