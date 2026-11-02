# SteamGuard

开源双重验证器，支持 macOS、Windows、Android 和 iOS。可独立管理通用验证码，也支持 Steam 令牌、账号登录、交易确认与社区市场。

[下载正式版](https://github.com/lx8s8/SteamGuard/releases/latest) · [安装与迁移](docs/INSTALLATION.md) · [更新日志](CHANGELOG.md) · [备份与恢复](docs/BACKUP.md) · [多端同步](docs/SYNC.md)

以下介绍当前源码功能。尚未发布的改动记录在更新日志的 Unreleased 部分，已发布安装包以对应版本说明为准。

## 功能

- **本地验证码**：支持 Steam Guard、TOTP 和 HOTP，提供手动添加、搜索、自定义分组、置顶、排序与批量管理。
- **Steam 账号**：密码或二维码登录，支持 Steam Guard、邮箱验证、手机交易确认与市场挂单查询；可扫描登录二维码后核对并审批。
- **备份与迁移**：支持 Google Authenticator 多码导入与兼容二维码批量导出、Aegis / 2FAS 明文或密码加密备份、WattToolkit `.mpo`、Steam `.maFile` 与 OTP 链接；提供自动加密快照、外部备份目录、差异预览与逐项恢复。
- **恢复与管理**：本机加密回收站，支持撤销、还原和永久删除；可修改保险库主密码，HOTP 恢复不会降低计数。
- **多端同步**：使用坚果云或兼容 HTTPS WebDAV 的网盘，端到端加密同步令牌与分组，可选择已有同步库、合并误建库、核对冲突，支持库别名、无密码加入配置与单独更换网盘凭据。
- **快捷访问**：手机可选择免密码预览验证码，或使用指纹、Touch ID / Face ID 解锁完整保险库。
- **简洁界面**：首页直接显示验证码，未添加 Steam 令牌时隐藏交易与市场入口；支持服务图标、自定义头像、浅色 / 深色主题与文字大小。
- **桌面托盘**：macOS 菜单栏和 Windows 任务栏常驻，点击令牌即可复制；提供全局快捷键、键盘导航与可选开机启动。
- **多语言**：内置 16 种语言，可跟随系统或手动切换，支持阿拉伯语从右向左布局。详见[语言说明](docs/LANGUAGES.md)。

![桌面界面](docs/screenshots/desktop.png)

[查看手机界面](docs/screenshots/mobile.png)

截图中的账户和验证码均为演示数据，首次启动没有预置账户。

令牌菜单可选择服务图标或上传头像；自定义头像保存在加密保险库中，并随 `.sgvault` 备份和 WebDAV 同步。启用头像同步前，请将所有设备更新到 1.5.0 或更新版本。

## 开始使用

1. 从 [Releases](https://github.com/lx8s8/SteamGuard/releases/latest) 下载适合设备的安装包。
2. 创建保险库并妥善保管主密码。
3. 扫描验证器二维码或导入已有备份；如需绑定 Steam，在添加窗口选择“其他添加方式”。
4. 按需设置分组与快捷访问，并将一份加密备份另存到其他设备或云盘。

从 1.1.x 及更早版本迁移时，请先导出加密备份，再安装新版并导入。详细步骤见[迁移说明](docs/INSTALLATION.md#从旧版本迁移)。

## 数据与隐私

保险库使用 Argon2id 和 AES-256-GCM 加密。主密码用于本机解密，应用不保存 Steam 登录密码。免密码预览仅开放验证码查看和复制，交易确认、令牌管理和导出仍需解锁。

修改主密码后，旧备份仍需生成时的密码，设备快捷访问需重新启用。回收站保存在本机加密保险库中。应用不提供云端存储，加入配置二维码不包含网盘密码或同步密码。

自动快照沿用保险库主密码，不依赖设备认证密钥恢复。iOS 可由系统备份收录加密数据，系统是否执行备份取决于设备设置；它不是跨设备实时同步。请参考[备份方案与恢复说明](docs/BACKUP.md)。跨平台同步可连接自己的 WebDAV 网盘，详见[多端同步](docs/SYNC.md)。

## 开发

基于 Tauri 2、Rust 和 React。需要 Node.js 24、Rust 及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run tauri dev
```

```sh
npm run check
npm run test:core -- --locked
npm run test:ui
npm run test:i18n
npm run test:release
npm run build
```

浏览器模式可预览界面；导入、加密存储和 Steam 功能需要通过 Tauri 应用运行。各平台打包命令及 CI 配置见[构建文档](docs/BUILDING.md)。

日常源码提交不触发正式版发布；正式版通过版本标签统一构建。

## 文档与反馈

- [安装与迁移](docs/INSTALLATION.md)
- [自动备份与恢复](docs/BACKUP.md)
- [WebDAV 多端同步](docs/SYNC.md)
- [导入格式兼容性](docs/import-format.md)
- [功能范围](docs/feature-matrix.md)
- [语言与翻译](docs/LANGUAGES.md)
- [Steam 集成](docs/steam.md)
- [问题反馈](https://github.com/lx8s8/SteamGuard/issues)

## 来源与许可

本项目从 [WattToolkit / SteamTools](https://github.com/BeyondDimension/SteamTools) 本地令牌模块提取，并以 Rust / Tauri 改写，采用 [GPL-3.0](LICENSE) 许可。第三方来源见 [NOTICE](NOTICE)。

本项目与 Valve 无隶属关系。Steam 和 Steam Guard 为其各自权利人的商标。
