# 安装与迁移

从 [GitHub Releases](https://github.com/lx8s8/SteamGuard/releases/latest) 下载正式安装包。历史版本和附件保持不变。

| 平台 | 安装包 |
| --- | --- |
| Android | `android-universal.apk`；`.aab` 用于分发平台，不能直接安装 |
| Windows x64 | `-setup.exe` 或 `.msi` |
| macOS Apple Silicon | `_aarch64.dmg` |
| macOS Intel | `_x64.dmg` |
| iOS / LiveContainer | `ios-arm64-LiveContainer.ipa` |

Android 正式版本使用一致的签名身份。Windows 安装器使用自签名代码证书，可能显示未知发布者或 SmartScreen 提示；不需要将随附证书导入系统根证书库。macOS 使用 ad-hoc 签名，尚未完成 Developer ID 公证，首次打开可能需要在系统「隐私与安全性」中允许。

`SHA256SUMS` 用于校验文件完整性；公开证书和指纹文件用于核对签名身份。

## 从旧版本迁移

从 1.2.0 起，应用标识统一为 `com.kasen.steamguard`。旧版使用 `dev.local.steamguard`，手机系统会将新旧版本识别为不同应用，无法直接读取对方的私有数据。

1. 在旧版中解锁保险库，导出 `.sgvault` 加密备份，确认已保存文件和密码。
2. 安装新版，创建保险库并导入备份。
3. 核对令牌与验证码后，再决定是否卸载旧版。
4. 在新版重新设置免密码预览或生物认证；设备认证密钥不会迁移。Steam 账号可能需要重新登录。

已生成的旧版 GitHub 安装包不删除、不替换。新标识的后续版本可正常覆盖升级。桌面版也使用新的数据目录，请通过导出、导入迁移，不要直接覆盖旧目录。

## iOS 与 LiveContainer

选择真机 IPA 导入 LiveContainer。Actions 下载的文件可能有外层 ZIP，需先解压取得其中的 `.ipa`。`.xcarchive`、归档 ZIP 和模拟器包不能直接安装到 iPhone。

提供的 IPA 未进行常规 iOS 分发签名，供 LiveContainer 导入。Face ID、Keychain、文件选择器及系统备份是否可用，取决于容器提供的系统能力；主密码仍可用于解锁。备份建议见[自动备份与恢复](BACKUP.md)。

通过 App Store、TestFlight 或常规签名安装，需要自行配置 Apple 开发者账号和签名。详见[构建文档](BUILDING.md)。
