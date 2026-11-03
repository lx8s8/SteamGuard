# 桌面快捷访问

桌面版提供免密码预览和设备认证两种独立开关。启用时仍验证保险库主密码；关闭、重置主密码会清除对应设备凭据。预览只开放验证码，不开放交易确认、导出、编辑或其他保险库权限。设备凭据留在当前操作系统用户下，不参与备份、导出和网盘同步。

## macOS

- 预览密钥保存到当前用户的登录钥匙串，使用当前应用的访问控制。
- Touch ID 凭据保存到 **Data Protection Keychain**，由 `biometryCurrentSet` 访问约束保护。每次读取创建新的 `LAContext`，禁止复用上一次认证。密钥只在当前设备使用，不同步 iCloud。增加、删除已登记的指纹后，需要用主密码重新启用。
- 应用标识来自 Tauri 配置；正式版与 `.qa` 等测试标识使用不同的钥匙串服务名，不能互读。

Touch ID 的持久保护需要 Apple 授权的应用签名及匹配的 provisioning profile，单纯自签名或 ad-hoc 签名不能获得 Data Protection Keychain 权限。默认源码和现有 ad-hoc 配置继续可编译运行，提供主密码和预览；界面会解释 Touch ID 的签名条件，不会退化成“弹出指纹窗口后读取普通钥匙串”的实现。

接入签名时：

1. 在开发者账号登记正式 bundle ID，启用 Keychain Sharing，生成匹配的 macOS profile。
2. 复制 [授权模板](examples/macos-keychain.entitlements.example) 到私有构建目录，替换 `TEAM_ID` 和实际 bundle ID。所有值必须与 profile 授权一致；不能仅添加模板而缺少 profile。
3. 通过私有 Tauri config overlay 设置 `bundle.macOS.signingIdentity`、`bundle.macOS.entitlements`，并在 `bundle.macOS.files` 配置 `"embedded.provisionprofile": "/private/path/profile.provisionprofile"`。该目标路径相对 `.app/Contents`。签名证书和 profile 均不提交仓库。
4. 打包后检查 `codesign -d --entitlements :- <app>` 和 `security cms -D -i <app>/Contents/embedded.provisionprofile`，核对应用 ID、团队 ID、授权组，再进行设备验收。

原理和平台要求见 Apple [TN3137](https://developer.apple.com/documentation/Technotes/tn3137-on-mac-keychains)、[生物特征约束](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)。

## Windows

预览密钥使用当前用户的 DPAPI 保护；生物认证开关使用 Windows Hello（PIN、指纹或人脸）控制的 `KeyCredential`。

本地解锁凭据通过 AES-256-GCM 封装。随机挑战经过 Windows Hello 私钥签名后，签名在内存中派生封装密钥，随即清零。磁盘只保存挑战、随机 nonce 和认证密文，不保存签名、派生密钥或明文凭据。解锁必须重新经过系统签名操作；没有把 `UserConsentVerifier` 的验证结果当作本地密钥。

这里调用的是桌面程序可用的 `KeyCredentialManager`，不要求将 NSIS/MSI 应用改成 UWP。WinRT 操作在独立 MTA 线程执行，避免阻塞 UI 的 STA 消息循环。微软的 [Windows Hello 实现指南](https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello)明确使用 SHA256 和 PKCS#1 验证签名；[KeePassXC 的桌面实现](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/WindowsHello.cpp)也采用签名派生本地加密密钥的方式。

启用时会验证两次签名结果一致，因此可能出现多次系统确认。如果平台提供程序改成随机签名算法，应用拒绝启用，保留主密码路径。重置 Windows Hello/PIN、删除系统凭据或迁移到另一台设备后，本地认证封装不能解开，需要用主密码重新启用；不会静默重建密钥绕过系统认证。当前用户下的完整权限程序仍属于操作系统的信任边界，不声称能阻挡已经接管当前用户会话的程序。

## 验证范围

自动验证覆盖本地封装篡改、错误密钥/应用标识/版本、参数边界和界面的可用性状态。macOS 原生桥可编译、Windows Rust 目标可交叉检查。真正的系统确认、取消、Hello/PIN 重置、指纹变化、正式签名 profile 和应用升级后的读取，仍需后续多端实机验收。正式包不代表已完成上述实机验收。
