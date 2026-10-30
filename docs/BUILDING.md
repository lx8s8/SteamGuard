# 构建与安装

安装各平台依赖以 [Tauri 2 前置依赖文档](https://v2.tauri.app/start/prerequisites/) 为准。项目使用 Node.js 24、Rust stable、Tauri 2；`npm ci` 和 Cargo 锁文件保证应用依赖可复现。

```sh
npm ci
npm run check
npm run test:core -- --locked
npm run build
npx playwright install chromium
npm run test:ui
```

真实账户导出只放在仓库外。`.gitignore` 排除 `.mpo`、`.maFile`、`.sgvault`、证书、环境变量与构建产物。运行私有导入测试使用 `WATT_TEST_MPO`，不要把真实备份变成测试夹具。

## macOS

需要 Xcode Command Line Tools；若同时构建 iOS，需要完整 Xcode。

```sh
npm run build:mac
```

默认当前架构，产物位于 `src-tauri/target/release/bundle/macos/SteamGuard.app` 和 `src-tauri/target/release/bundle/dmg/`。指定架构时：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg --ci
npm run tauri -- build --target x86_64-apple-darwin --bundles app,dmg --ci
```

此时产物目录为 `src-tauri/target/<target>/release/bundle/`。默认构建使用 ad-hoc 签名，不完成 Developer ID 签名与公证。公开分发需按 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/) 配置证书与公证凭据。

本机已完成 ARM64 发布构建：未压缩 `.app` 约 6.83 MiB、DMG 约 3.38 MiB；调试构建也完成了原生界面检查。GitHub Actions 的 ARM64、Intel macOS 两项构建与产物上传均已通过。

## Windows

在 Windows 安装 Visual Studio C++ Build Tools、WebView2 与 Rust MSVC 工具链。

```powershell
npm ci
npm run build:win
```

NSIS 安装器位于 `src-tauri/target/release/bundle/nsis/`，MSI 位于 `src-tauri/target/release/bundle/msi/`。Windows x64 的 CI 编译、NSIS/MSI 打包和产物上传均已通过。正式 CI 安装包使用 kasen 自签名代码证书；未在 Windows 真机上执行安装或账号联调。

## Android

当前原生工程使用 SDK Platform 37.0、Build Tools 37.0.0、NDK 28.2.13676358。安装 Android Studio、JDK 21、SDK Command-line Tools，并设置 `JAVA_HOME`、`ANDROID_HOME` 与 `NDK_HOME`。macOS 上的 `scripts/mobile.mjs` 可自动发现默认 Android Studio JDK 和 SDK 目录。

SDK 管理器中的准确包标识为 `platforms;android-37.0`，不是 `platforms;android-37`；Gradle 的 `compileSdk`/`targetSdk` 保持整数 `37`。

```sh
sdkmanager 'platforms;android-37.0' 'build-tools;37.0.0' 'ndk;28.2.13676358'
rustup target add aarch64-linux-android x86_64-linux-android
# 首次生成工程时使用；仓库已有工程时不必重复。
npm run init:android -- --ci --skip-targets-install
npm run build:android -- --debug --target aarch64 x86_64 --ci
```

本机 ARM64 调试 APK 已完成编译，实际路径为 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。生成的原生工程使用 `universal` product flavor，因此 CI 按 `outputs/apk/**/*.apk` 收集产物。调试包使用 Android 调试签名，只用于开发测试。

```sh
node scripts/mobile.mjs android build --apk --aab --target aarch64 x86_64 --ci
```

正式 CI 同时生成 `app-universal-release.apk` 和 `app-universal-release.aab`，包含 ARM64/x86_64，并使用 kasen 的持久发布密钥签名。APK 可直接安装；AAB 供分发平台使用。APK 和 AAB 的证书指纹必须与 `certificates/fingerprints.json` 一致。

本机签名构建时，从仓库外的私有文件提供 `STEAMGUARD_SIGNING` 给 `node scripts/prepare-signing.mjs android`，再运行发布构建。不要将密钥内容直接放进终端命令。没有 `keystore.properties` 的开发构建仍输出未签名发布包，不能作为正式 Release 附件。

旧调试版与正式发布版签名不同；先导出并保留加密令牌备份。若 Android 要求卸载旧包，重装正式版后恢复备份。后续正式版本沿用相同签名，可覆盖升级。密钥保管及 CI 配置见 [签名说明](SIGNING.md)。

Android 的原生文件保存使用系统文件选择器；不需要将令牌库写到公共存储目录。

## iOS 与 iPadOS

仅能在 macOS 构建，需要完整 Xcode、CocoaPods、XcodeGen 与 Rust iOS targets。项目最低部署版本为 iOS/iPadOS 15.0，与当前 Xcode 27 的构建要求一致。

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
brew install cocoapods xcodegen
# 首次生成工程时使用；仓库已有工程时不必重复。
npm run init:ios -- --ci --skip-targets-install
npm run build:ios:sim -- --no-sign --ci
```

ARM64 模拟器 `.app` 的实际输出路径为 `src-tauri/gen/apple/build/arm64-sim/SteamGuard.app`，已在本机完成编译、安装与启动。安装到已启动的 ARM64 iOS 模拟器：

```sh
xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/SteamGuard.app
xcrun simctl launch booted dev.local.steamguard
```

无需 Apple 发布证书的真机归档：

```sh
npm run build:ios -- --no-sign --archive-only --ci
```

实际输出为 `src-tauri/gen/apple/build/steamguard_iOS.xcarchive`，已在本机编译通过，ZIP 约 5.2 MiB。该 `.xcarchive` 是 Xcode 构建归档，不能直接装到 iPhone，也不能直接导入 LiveContainer。通过常规 iOS 安装、TestFlight 或 App Store 分发需要选择自己的 Apple Development Team、签名证书与 provisioning profile，再执行签名导出。仓库不预设任何公司或个人的开发团队。

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run build:ios -- --export-method debugging --ci
```

具体签名和分发方式见 [Tauri iOS 签名文档](https://v2.tauri.app/distribute/sign/ios/)。

### LiveContainer 导入 IPA

[LiveContainer 官方安装说明](https://github.com/LiveContainer/LiveContainer#installing-apps)要求选择 IPA。它不是 `.xcarchive` ZIP 或模拟器 `.app` ZIP；只修改扩展名也不能转换格式。必须使用真机应用并采用以下 ZIP 内部目录：

```text
Payload/
  SteamGuard.app/
    Info.plist
    SteamGuard
    ...
```

完整构建并打包：

```sh
npm run build:ios:ipa
```

已有真机归档时无需重新编译，直接执行：

```sh
npm run package:ios:ipa
```

产物是 `artifacts/SteamGuard-iOS-arm64-unsigned.ipa`。打包脚本检查 `iPhoneOS` 平台、ARM64 真机可执行文件、未加密状态、`Payload/*.app` 目录及 ZIP 完整性，并保留可执行权限；传入模拟器应用会被拒绝。不会使用本机 Apple 发布证书。

Actions 单独上传 **`iOS-arm64-device-IPA-unsigned`**。在 iPhone 上先解压 GitHub 下载的外层 ZIP，取出里面的 `.ipa`，再在 LiveContainer 点“+”选择它。不要把外层 Actions ZIP、归档 ZIP 或 `.xcarchive` 文件夹当作 IPA 导入。

这是供 LiveContainer 导入测试的未签名真机 IPA，不是可在普通 iOS 安装流程中直接安装的签名包。是否能在 LiveContainer 内启动、文件选择器和其他插件能否正常使用，尚未进行 LiveContainer 实机验证，不能由打包检查替代。

## GitHub Actions

`.github/workflows/package.yml` 构建 Apple Silicon / Intel macOS、Windows x64、Android ARM64/x64，以及 ARM64 iOS 模拟器、未签名真机归档和单独的真机 IPA。触发方式为主分支提交、版本标签、相关 Pull Request 或手动运行。

独立的 Linux 前端任务只安装 Node.js 与 Chromium，运行 TypeScript 检查和 Playwright 界面测试，不编译 Rust。原生构建任务分别使用对应平台工具链。

所有构建产物作为 Actions artifacts 保留 14 天。仅正式版本标签使用配置的签名身份；主分支、Pull Request 和手动开发构建不加载签名 Secret。macOS/iOS 使用 `ditto` 保留可执行权限，不加载本机真实令牌备份或 Steam 密码。

推送与应用版本一致的 `v*` 标签后，所有测试及原生构建成功才会触发集中发布任务，收集四平台安装器、公开证书与 SHA-256 校验和；先完成草稿上传，再将 GitHub Release 发布为正式版。只有发布任务具有 `contents: write` 权限，其他任务维持只读权限。不会自动上传到应用商店。
