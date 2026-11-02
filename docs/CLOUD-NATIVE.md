# Google Drive 移动端登录接入

Android/iOS 使用 Google 官方原生 SDK；桌面版继续使用系统浏览器和 PKCE。本项目不要求用户搭建服务器，也不借用其他项目的 OAuth 客户端。各平台客户端须登记到同一个 Google Cloud 项目中，并启用 Drive API 和 OAuth 同意屏幕。

## Android

构建环境设置公开的 `STEAMGUARD_GOOGLE_ANDROID_CLIENT_ID`，对应的 Android OAuth 客户端必须匹配 `com.kasen.steamguard` 和当前安装包签名的 SHA-1。测试包使用不同应用 ID 或证书时，需另外登记匹配客户端。官方 SDK 根据包名和签名识别应用，代码不使用 web client secret，也不向服务器交换 refresh token。

原生 `AuthorizationClient` 请求 `drive.file` 与 `openid`。前者仅操作授权给应用的文件，后者用于请求 Google userinfo 的稳定账号 ID，避免默认 Google 账号变化后把同步内容写到另一个网盘。初次连接使用系统账号选择/授权窗口；同步时再次调用 SDK 获取有效 access token，遇到需要交互的授权恢复会要求重新连接，后台同步不会弹出账号选择窗口。Android 需要可用的 Google Play 服务。

依据：[官方授权指南](https://developer.android.com/identity/authorization)、[AuthorizationClient](https://developers.google.com/android/reference/com/google/android/gms/auth/api/identity/AuthorizationClient)。

## iOS

构建环境设置公开的 `STEAMGUARD_GOOGLE_IOS_CLIENT_ID`，对应 iOS OAuth 客户端必须匹配当前 bundle ID。

插件通过 Swift Package Manager 内置 GoogleSignIn SDK。由于 Tauri 只链接 SwiftPM 静态库，插件构建脚本按平台、配置暂存 SDK 的资源包及隐私清单，iOS 工程在签名前通过 `scripts/copy-google-ios-resources.sh` 将它们复制到应用根目录；增量构建也执行该步骤，避免缺少 Google 字体、界面和隐私资源。构建脚本还在 Tauri iOS 工程的 `Info.plist` 添加 `GIDClientID` 和反转客户端 ID 的 URL scheme；缺少 ID 时不注入占位回调。原生插件接收 Tauri 的 iOS URL 打开事件，只转交与已配置 scheme 完全一致的 URL 到 SDK。SDK 负责 state 校验和令牌交换，不把回调内容发送到页面。

SDK 持有自己的系统钥匙串登录状态。同步前先恢复登录，再调用 `refreshTokensIfNeeded`；应用保险库仅加密保存预期账号 ID。账号变化、授权撤销或 SDK 会话丢失时要求重新连接，不会静默切换账号。

依据：[GoogleSignIn 集成](https://developers.google.com/identity/sign-in/ios/sign-in)、[令牌刷新接口](https://developers.google.com/identity/sign-in/ios/reference/Classes/GIDGoogleUser)。

## 本地与构建行为

`cloud-auth` 插件不声明前端 invoke 命令。access token 只在原生 SDK、Rust 和网盘 HTTP 客户端之间传递，离开 Rust 会话对象时清零；不进入页面、二维码、同步文档或导出文件。Android 不自行保存 refresh token；iOS 由官方 SDK 在系统钥匙串管理会话。

没有登记客户端 ID 时仍可编译全部平台，Google 移动登录显示待配置，其他同步方式可正常使用。平台 SDK 的构建检查与真实 Google 登录是两项不同的验收；当前未提供客户端 ID，因此授权、账号选择及重新授权需登记后进行实机验收，本轮不发布安装包。
