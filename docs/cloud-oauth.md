# 网盘登录接入

用户将加密同步文件保存在自己的网盘中。SteamGuard 不提供中转服务器，不接收用户的账号密码、OAuth 令牌或二次认证密钥。专用登录复用 WebDAV 已有的加密格式、同步库发现、加入与合并流程，设备必须选择同一个库编号。

仓库不包含已登记的 OAuth 客户端。未填写开发者配置的构建仍可正常编译、使用 WebDAV；对应专用网盘显示“此版本尚未启用此网盘登录”。不要借用其他软件的客户端 ID，也不要向应用内填入网盘账号密码。

| 服务 | 授权方式 | 权限 / 存储目录 |
| --- | --- | --- |
| Google Drive 桌面 | 系统浏览器、随机回环端口、Authorization Code + S256 PKCE | `drive.file`，应用创建的 `SteamGuard` 目录 |
| Google Drive Android / iOS | 官方原生 SDK，平台客户端登记后启用 | `drive.file`，SDK 管理登录凭据，应用本地记录预期账号（Android 另外请求 `openid` 用于校验账号） |
| OneDrive 所有平台 | Microsoft 公共客户端设备码登录 | `Files.ReadWrite.AppFolder offline_access`，应用专属目录 |
| Dropbox 所有平台 | 系统浏览器、S256 PKCE，粘贴官网显示的授权码 | Dropbox 登记为 App folder，只访问应用专属目录 |

浏览器回调授权码、refresh token 和 SDK access token 不进入前端；前端只持有短期、不透明的本机授权句柄。Dropbox 手动授权码由用户粘贴到输入框后传给原生层，成功或取消后清除，不持久化或记录日志。浏览器回调绑定随机 state、拒绝重复参数。授权句柄在锁定时销毁，最多有效十分钟。桌面 / OneDrive / Dropbox 的 refresh token 仅存入本机加密保险库，不进入同步文档、导出备份中的连接配置或加入二维码。OneDrive 返回的更新 refresh token 会在本机加密保存后使用。Google 移动端由 SDK 刷新 access token，账号不一致时要求重新登录。

## Google Drive

1. 创建自己的 Google Cloud 项目，启用 **Google Drive API**，配置 OAuth 同意屏幕。测试阶段添加测试用户，正式公开使用前按控制台要求发布应用并完成必要审核。处于测试状态的外部应用可能收到短期有效的 refresh token。
2. 创建 **Desktop app** 客户端。通过构建环境传入桌面客户端的 ID 和其生成的 desktop client secret；这是 Google 对公共原生客户端的参数，不能替换为保密的 Web 应用 secret。应用同时使用 PKCE，不依赖该值保密。
3. Android 创建 **Android** 客户端：包名 `com.kasen.steamguard`、实际安装包签名的 SHA-1。开发签名和正式签名分别登记；填写 `STEAMGUARD_GOOGLE_ANDROID_CLIENT_ID` 以启用官方原生授权入口。
4. iOS 创建 **iOS** 客户端：Bundle ID `com.kasen.steamguard`，填写 `STEAMGUARD_GOOGLE_IOS_CLIENT_ID`，并按原生插件配置生成反向客户端 ID URL scheme。更换 Bundle ID 的测试构建应单独登记。
5. **桌面、Android、iOS 客户端必须属于同一 Google Cloud 项目。** `drive.file` 按应用授权可见文件，使用互不相关的 Cloud 项目会看不到另一端创建的文件。不要扩大到整个网盘权限来掩盖客户端登记错误。

```sh
export STEAMGUARD_GOOGLE_DESKTOP_CLIENT_ID='your-desktop-client.apps.googleusercontent.com'
export STEAMGUARD_GOOGLE_DESKTOP_CLIENT_SECRET='your-desktop-public-client-secret'
export STEAMGUARD_GOOGLE_ANDROID_CLIENT_ID='your-android-client.apps.googleusercontent.com'
export STEAMGUARD_GOOGLE_IOS_CLIENT_ID='your-ios-client.apps.googleusercontent.com'
```

桌面使用 `http://127.0.0.1:<随机端口>/oauth/callback`，符合 Desktop app 回环授权方式。移动端使用原生 SDK，不能给移动客户端套用桌面回环授权或已废弃的 Google 手动复制授权码流程。原生插件实现与平台依赖见 [`src-tauri/plugins/cloud-auth`](../src-tauri/plugins/cloud-auth)。

## OneDrive

1. Microsoft Entra 管理中心新建应用登记，支持希望面向的组织账号和个人 Microsoft 账号。
2. 作为 **public client / mobile and desktop application**，开启允许公共客户端流（设备码登录）。不创建客户端 Secret。
3. 增加 Microsoft Graph **delegated** 权限 `Files.ReadWrite.AppFolder`。用户登录时申请 `offline_access`，不申请整个网盘读写权限，也不申请 application-only 权限。
4. 在构建环境传入 Application (client) ID。若组织管理员禁止设备码登录，需管理员调整策略或改用 WebDAV，应用不能绕过租户限制。

```sh
export STEAMGUARD_MICROSOFT_CLIENT_ID='00000000-0000-0000-0000-000000000000'
```

应用访问 `/me/drive/special/approot` 获取当前应用的实际专属目录，按返回的父路径和名称定位，因此移动或重命名后仍可查找同步库。目录列表在大小限制内规范化 Graph 的编码路径，兼容中文、空格和分页，并拒绝目录外记录。文件内容的 HTTPS 临时下载地址最多跟随一次，且不会将 Graph bearer token 转发给下载主机。

## Dropbox

1. Dropbox App Console 新建 **Scoped access** 应用，选择 **App folder**，不要选择 Full Dropbox。
2. 开启 `files.metadata.read`、`files.content.read`、`files.content.write` 权限，按控制台要求申请生产访问。
3. 使用 App key，不需要向公共客户端分发 App secret。当前使用 Dropbox 官方支持的无 redirect URI 授权码流程：用户在系统浏览器同意后，将官网显示的授权码粘贴回应用。应用使用 PKCE 校验授权码并请求 offline refresh token。

```sh
export STEAMGUARD_DROPBOX_APP_KEY='your-dropbox-app-key'
```

## 构建与验收

上述变量在编译时读取。配置变更后重新编译原生项目；它们不是用户自己的网盘账号，不应出现在普通用户设置页面。仓库工作流已读取同名 Actions Variables：三个 Google 平台客户端 ID、Microsoft 客户端 ID、Dropbox App key。Google 的桌面客户端参数 `STEAMGUARD_GOOGLE_DESKTOP_CLIENT_SECRET` 从同名 Actions Secret 读取；不要填入保密 Web 应用凭据。缺少值时保持对应登录未启用，其他平台及 WebDAV 可正常构建。

不要提交真实用户 token、签名文件或保险库。仓库当前没有登记信息，因此自动测试使用合成数据，不连接真实网盘账号。配置这些值不会自动发布；仍按既有版本标签流程构建。

登记完成后，逐项验收：取消登录、超时重试、切换账号、锁定时取消、撤销授权后重新登录、token 到期刷新、两台设备发现同一库、同一库合并、离线修改重连。首次在新设备使用应先查找并加入原库，避免创建另一独立库。正式版发布沿用统一版本标签流程。

官方资料：

- [Google 原生应用 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive 权限选择](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Android 授权访问 Google 数据](https://developers.google.com/identity/authorization/android)
- [Google Sign-In for iOS](https://developers.google.com/identity/sign-in/ios/sign-in)
- [Microsoft 设备码授权](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [OneDrive 应用专属目录](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)
- [Dropbox OAuth Guide](https://developers.dropbox.com/oauth-guide)
