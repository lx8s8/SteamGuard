# 复制与剪贴板

验证码、备用恢复码和 OTP 链接统一由原生层复制。复制验证码时重新生成当前值，HOTP 不会因复制而递增；副设备的 HOTP 保持不可复制。

在「设置 → 验证码复制」中选择 15、30、60、120 秒后清除，或关闭定时清除。默认 30 秒，仅影响本机，修改后用于下一次复制。

清除操作核对原生剪贴板的变更编号或本次复制的随机标识，不读取其他应用的剪贴板文字。用户之后复制了其他内容，即使文字相同，应用也不会删除它。短暂占用或 Android 暂无前台焦点时保留待清除标识，稍后及恢复前台时重试。

- **iOS**：使用本机剪贴板与系统到期时间，不通过通用剪贴板传往其他设备。
- **Android**：为内容设置系统敏感标志，避免系统预览显示验证码；清除需系统允许应用访问剪贴板。后台受限、进程被终止或厂商策略可能延后清除。
- **Windows**：设置排除剪贴板历史记录、云剪贴板的原生格式。
- **macOS**：标记为临时、隐私内容，供支持这些约定的剪贴板管理器识别。

桌面端正常退出时也会尝试清除仍属于应用的复制内容。手机系统可能直接终止进程，iOS 依靠系统到期时间，Android 需运行中的前台重试。定时清除和隐私标志无法约束不遵循平台规则的剪贴板工具，也不等同于撤回已经粘贴的内容。

实现细节及平台依据：[Apple UIPasteboard](https://developer.apple.com/documentation/uikit/uipasteboard)、[Android 剪贴板](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste)、[Windows 标准剪贴板格式](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)。
