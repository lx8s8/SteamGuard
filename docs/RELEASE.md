SteamGuard 首个正式发布版，基于 Tauri 2，发布者 kasen。

提供本地 Steam/TOTP/HOTP 令牌、WattToolkit 原格式 `.mpo` 导入导出、加密备份、Steam 手机登录与交易确认界面。令牌库使用主密码加密，Steam 密码不保存在令牌库中。

本版修复 Steam 时间接口 HTTP 411、Windows/Android 系统代理读取、磁盘保存失败后本地状态未回滚，以及锁定期间完成二维码请求的边界处理。设置页支持系统代理、直连、手动 HTTP/SOCKS 代理和分步骤网络诊断。

下载对应平台的文件：

- **Android**：`android-universal.apk` 可直接安装，包含 ARM64/x86_64，使用 kasen 长期发布密钥签名；`.aab` 供分发平台使用，不能直接安装。旧调试版签名与正式版不同，升级前请导出加密备份；若系统要求卸载，重装后再导入备份。后续正式版沿用同一密钥。
- **Windows x64**：选择 `-setup.exe` 或 `.msi`。应用与安装器均使用 kasen 自签名代码证书签名；该证书不属于系统默认信任的证书机构，系统仍可能显示未知发布者或 SmartScreen 提示。随附 `.cer` 仅用于检查签名身份，不需要将其导入系统受信任根证书库。
- **macOS**：Apple Silicon 选择 `_aarch64.dmg`，Intel 选择 `_x64.dmg`。采用 ad-hoc 签名，尚未取得 Apple Developer ID 公证，首次打开可能需要在“隐私与安全性”中允许。
- **iOS / LiveContainer**：选择 `ios-arm64-LiveContainer.ipa`，直接导入 LiveContainer；这是标准 `Payload/*.app` 真机 IPA，不是 `.xcarchive` 或模拟器包，也不能按普通已签名 IPA 直接安装。

`SHA256SUMS` 可核对下载完整性；`fingerprints.json` 和公开证书可核对 Android/Windows 的签名身份。私钥、证书密码及真实令牌备份均不作为 Release 附件发布。

发布前执行了原生回归、界面与响应式布局测试、四平台构建和签名检查。授权账号已在本机完成真实密码/令牌登录及只读确认查询。Windows/Android 真机网络、LiveContainer 内运行、新绑定、短信转移、解绑与真实交易批准/拒绝仍需对应设备和业务场景验证；未用测试账号执行交易或改变令牌绑定。
