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

此时产物目录为 `src-tauri/target/<target>/release/bundle/`。默认构建不使用用户 Apple 发布证书，也不完成 Developer ID 签名与公证。公开分发需按 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/) 配置证书与公证凭据。

本机已完成 ARM64 发布构建：未压缩 `.app` 约 6.83 MiB、DMG 约 3.38 MiB；调试构建也完成了原生界面检查。GitHub Actions 的 ARM64、Intel macOS 两项构建与产物上传均已通过。

## Windows

在 Windows 安装 Visual Studio C++ Build Tools、WebView2 与 Rust MSVC 工具链。

```powershell
npm ci
npm run build:win
```

NSIS 安装器位于 `src-tauri/target/release/bundle/nsis/`，MSI 位于 `src-tauri/target/release/bundle/msi/`。Windows x64 的 CI 编译、NSIS/MSI 打包和产物上传均已通过。默认安装包未进行 Windows 代码签名；未在 Windows 真机上执行安装或账号联调。

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

本机 ARM64 发布构建也已通过，生成 `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk` 和 `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`。CI 按 `outputs/bundle/**/*.aab` 收集发布 bundle。

AAB 不能直接作为 APK 安装，未签名发布 APK 也需签名后安装。上架或发布正式 APK 前，按 [Tauri Android 签名文档](https://v2.tauri.app/distribute/sign/android/) 配置自己的 keystore。不要将 keystore 或密码提交到 Git。

本机还提供约 9.07 MiB 的优化测试 APK：发布 APK 使用 Android 默认调试证书重新签名，并通过 `apksigner verify`。它用于安装测试；正式分发仍应使用自己的发布密钥。未签名发布 APK 约 9.00 MiB、AAB 约 5.57 MiB。

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

实际输出为 `src-tauri/gen/apple/build/steamguard_iOS.xcarchive`，已在本机编译通过，ZIP 约 5.2 MiB。该 `.xcarchive` 是未签名构建归档，不能直接装到 iPhone。真机安装、TestFlight 或 App Store 分发需要选择自己的 Apple Development Team、签名证书与 provisioning profile，再执行签名导出。仓库不预设任何公司或个人的开发团队。

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run build:ios -- --export-method debugging --ci
```

具体签名和分发方式见 [Tauri iOS 签名文档](https://v2.tauri.app/distribute/sign/ios/)。

## GitHub Actions

`.github/workflows/package.yml` 构建 Apple Silicon / Intel macOS、Windows x64、Android ARM64/x64，以及 ARM64 iOS 模拟器和未签名真机归档。触发方式为主分支提交、版本标签、相关 Pull Request 或手动运行。

独立的 Linux 前端任务只安装 Node.js 与 Chromium，运行 TypeScript 检查和 Playwright 界面测试，不编译 Rust。原生构建任务分别使用对应平台工具链。

所有产物作为 Actions artifacts 保留 14 天，不自动创建 GitHub Release，也不提交到应用商店。macOS/iOS 目录使用 `ditto` 打包为 ZIP，以保留应用可执行权限。工作流只使用只读仓库权限，不需要 Steam 密钥，也不加载本机真实令牌备份。

已完成的远端任务包括前端测试、macOS ARM64/Intel、Windows x64、iOS 模拟器和未签名真机归档；Android 调试与发布 APK/AAB 已在本机编译通过。Android 工作流使用修正后的 `platforms;android-37.0`，远端结果以对应运行记录为准。正式发布需配置各平台签名，并使用自有账号完成登录、短信流程与交易确认联调。
