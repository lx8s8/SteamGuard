# 安装与迁移

从 [GitHub Releases](https://github.com/lx8s8/SteamGuard/releases/latest) 下载适合设备的安装包。现提供 1.2.0 及后续版本；更早版本已停止分发。

| 平台 | 安装包 |
| --- | --- |
| Android | `android-universal.apk`；`.aab` 用于分发平台，不能直接安装 |
| Windows x64 | `-setup.exe` 或 `.msi` |
| macOS Apple Silicon | `_aarch64.dmg` |
| macOS Intel | `_x64.dmg` |
| iOS / LiveContainer | `ios-arm64-LiveContainer.ipa` |

Windows 和 macOS 首次打开时可能显示系统安全提示，请确认文件来自本项目的 Releases。macOS 可按系统提示在“隐私与安全性”中允许打开。

如需检查下载文件是否完整，可使用同一版本的 `SHA256SUMS`。各平台安装包之外，仅附带开源许可证和文件校验和。

## 从旧版本迁移

1.2.0 调整了应用数据存储，系统会将更早的版本识别为独立应用，新版无法直接读取旧版的私有数据。已安装旧版的用户，请先完成以下迁移：

1. 在旧版中解锁保险库，导出 `.sgvault` 加密备份，确认已保存文件和密码。
2. 安装新版，创建保险库并导入备份。
3. 核对令牌与验证码后，再决定是否卸载旧版。
4. 在新版重新设置免密码预览或生物认证。Steam 账号可能需要重新登录。

1.2.0 及后续正式版本可覆盖升级。桌面版首次从更早版本迁移时，也请通过导出、导入恢复数据。

## iOS 与 LiveContainer

选择 `ios-arm64-LiveContainer.ipa` 导入 LiveContainer。Actions 下载的文件可能有外层 ZIP，需先解压取得其中的 `.ipa`。`.xcarchive`、归档 ZIP 和模拟器包不能直接安装到 iPhone。

Face ID、Keychain、文件选择器及系统备份是否可用，取决于容器提供的系统能力；主密码仍可用于解锁。备份建议见[自动备份与恢复](BACKUP.md)。

如需通过 App Store、TestFlight 或其他分发方式安装，请参考[构建文档](BUILDING.md)。
