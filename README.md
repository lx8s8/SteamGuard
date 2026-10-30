# SteamGuard

基于 Tauri 2、Rust 和 React 的本地令牌工具，从 WattToolkit / SteamTools 的本地令牌与 Steam 手机验证流程提取、改写。桌面使用侧栏布局，手机使用底部导航，适配 macOS、Windows、Android 和 iOS。

令牌在本机生成；令牌库由主密码通过 Argon2id 派生密钥，以 AES-256-GCM 加密。Steam 登录与交易确认由 Rust 调用 Steam 接口，密码不保存，登录会话只写入加密令牌库。

## 功能

- 直接导入 WattToolkit 2.x 原始 `.mpo`，支持原格式压缩、内置 AES 和二级密码；无需先转成 JSON。
- 导入 Steam `.maFile`、Steam Guard JSON、TOTP/HOTP、`otpauth://`、Google Authenticator 迁移链接和未加密 WinAuth XML。
- 显示动态验证码与剩余时间、复制、搜索、重命名、删除；提供加密备份和跨设备迁移。
- Steam 密码登录、Steam Guard/邮箱验证、二维码登录、会话续期、多个账号分别保存。
- 获取 Steam 手机交易确认，逐笔核对后接受或拒绝；查看市场挂单并打开 Steam 官方市场。
- 提供 Steam 令牌绑定、短信激活、短信转移、恢复码解绑与登录二维码审批流程。

实现范围和验证边界见 [功能矩阵](docs/feature-matrix.md)。Steam 的短信、账号限制和交易状态取决于账号与服务端；编译通过不代表已用真实账户完成交易。

## 开发

需要 Node.js 24、Rust 与 [Tauri 各平台前置依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run tauri dev
```

普通浏览器可以运行 `npm run dev` 预览布局。实际导入、加密保存和 Steam 功能需要在 Tauri 应用中运行。

```sh
npm run check
npm run test:core -- --locked
npm run build
npx playwright install chromium
npm run test:ui
```

## 原格式导入验证

用户提供的 2024-12-04 `.mpo` 已在本机私有测试中成功读取，包含 2 条 Steam 令牌，并完成加密令牌库保存/恢复及原始 `.mpo` 再导出、再导入的往返验证。原文件及解密内容未复制进本仓库；测试不输出账号、密钥、恢复码或动态码。

如需在自己的电脑验证其他导出文件：

```sh
WATT_TEST_MPO='/absolute/path/to/private-export.mpo' npm run test:core -- real_mpo_private_import --lib -- --ignored
```

有二级密码时设置 `WATT_TEST_PASSWORD`。启用原机器保护的备份需先在原设备导出可迁移版本。MemoryPack 新格式和 WattToolkit v1 `.dat` 尚不支持，详见 [导入兼容文档](docs/import-format.md)。

已通过 20 项 Rust 默认测试和 10 项界面交互/响应式布局测试；3 项需要真实文件或网络的测试默认跳过。另行运行的私有原文件往返测试与真实 Steam 只读 RSA 协议探测均已通过。macOS 调试 `.app`/`.dmg` 和 ARM64 iOS 模拟器 `.app` 已在本机编译成功；其他平台构建结果见功能矩阵和实际 CI 记录。

## 打包

| 平台 | 命令 | 产物 |
| --- | --- | --- |
| macOS | `npm run build:mac` | `.app`、`.dmg`，默认当前架构 |
| Windows | `npm run build:win` | NSIS `.exe`、MSI `.msi`，在 Windows 构建 |
| Android | `npm run build:android -- --debug --target aarch64 --ci` | 可安装的调试 APK |
| iOS 模拟器 | `npm run build:ios:sim -- --no-sign --ci` | ARM64 模拟器 `.app`，在 macOS 构建 |
| iOS 真机归档 | `npm run build:ios -- --no-sign --archive-only --ci` | 未签名 `.xcarchive`，不能直接安装到真机 |

首次进行移动端开发可运行 `npm run init:android -- --ci` 或 `npm run init:ios -- --ci`。项目已包含原生工程，不必每次重新初始化。

GitHub Actions 在主分支提交、版本标签、Pull Request 或手动触发时构建桌面和移动端产物。工作流提供开发/未签名包，未配置发布证书，不自动发布商店。安装与签名细节见 [构建说明](docs/BUILDING.md)。

## 来源与许可

本项目是对 [WattToolkit / SteamTools](https://github.com/BeyondDimension/SteamTools) 本地令牌模块的独立提取与 Rust/Tauri 改写，保留 GPL-3.0 许可。格式兼容参考 BeyondDimension/Common、WinAuth、MessagePack-CSharp；具体源码位置与协议参考见 [格式文档](docs/import-format.md) 和 [Steam 集成文档](docs/steam.md)。

项目与 Valve 无隶属关系。Steam 与 Steam Guard 为其各自权利人的商标。
