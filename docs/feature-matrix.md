# 功能范围与验证矩阵

本项目提取本地令牌与 Steam 手机认证相关能力，不包含原项目的网络加速、游戏管理、挂机、成就、原项目云账号同步等模块。

## 本地令牌

| 能力 | 实现范围 | 验证 |
| --- | --- | --- |
| 原始 WattToolkit `.mpo` 导入 | 兼容提供文件所用的 MessagePack、LZ4、内置 AES；支持二级密码 | 提供的真实文件私有测试通过，2 条 Steam 记录；加密保存/恢复通过 |
| 原格式 `.mpo` 导出 | 生成原始映射与平台 union，保留 Steam 附加字段；可加二级密码 | 合成 Steam/HOTP 往返与私有真实文件再导出/导入均通过 |
| 其他格式 | `.maFile`、JSON、OTP URI、Google 迁移 URI、WinAuth 未加密 XML | 有代表性解析与无效输入测试 |
| TOTP/HOTP | SHA1、SHA256、SHA512；自定义位数、周期和计数器 | RFC 4226 / RFC 6238 向量通过 |
| Steam 动态码 | Steam 字符表和 30 秒周期 | 使用相同 HMAC 计算路径；原始密钥成功解析 |
| 本机保存与 `.sgvault` | Argon2id + AES-256-GCM；随机盐和 nonce；主密码解锁 | 加密往返、错误密码、篡改拒绝测试通过 |
| 管理 | 搜索、复制、重命名、删除、备份、HOTP 递增、OTP 二维码与单令牌导出 | 界面测试覆盖导入预览、筛选、Guard/QR、审批核对、绑定及布局等流程 |
| 锁定 | 手动锁定、空闲锁定及前端后台锁定 | 清理界面数据与原生会话；不依赖页面刷新保护密钥 |

界面导入入口限制为 10 MiB、每批 1,000 个令牌；底层解析器另有 16 MiB 解压与 10,000 条记录的保护上限。任一记录失败会拒绝本次导入，不将残缺结果当作成功。

## Steam

| 能力 | 已提供实现 | 已完成验证 |
| --- | --- | --- |
| 密码登录 | RSA 加密、MobileApp 会话、Guard/邮箱验证、轮询、账号身份匹配 | 本机授权账号真实密码与本地令牌登录通过，MobileApp 会话用途校验通过 |
| 网络连接 | 系统代理、直连、手动 HTTP/HTTPS/SOCKS；分步骤诊断；时间请求修复 HTTP 411 | 请求体及敏感 URL 隐藏回归通过，本机系统代理下认证/时间/社区检测及真实账号登录通过；Android JNI 已通过真机构建交叉编译 |
| 二维码登录 | 创建登录二维码、轮询手机审批结果 | 本地协议及 URL 约束测试；需用户账号联调 |
| 登录二维码审批 | 查询粘贴的 Steam 二维码详情、明确批准/拒绝 | HMAC-SHA256 和可信主机测试；未批准真实登录 |
| 会话保存 | 加密保存 access/refresh token、刷新、退出 | 本地账号绑定及 token 用途校验测试 |
| 交易确认 | 拉取确认列表、校验已读取记录、逐笔接受/拒绝 | HMAC-SHA1 签名向量通过；真实确认列表只读获取通过，未接受或拒绝交易 |
| 市场 | 获取挂单、规范化显示信息、Steam 官方页面链接；原生层提供公开搜索 | 未使用真实账号验证挂单；不提供自动购买、自动出售或批量交易 |
| 新绑定 | 请求新令牌、先保存恢复信息、短信激活 | 协议实现；未修改真实账号 |
| 短信转移 | 发短信挑战、验证并保存替换令牌 | 协议实现；未转移真实令牌 |
| 恢复码解绑 | 用户显式输入恢复码后调用解绑接口 | 协议实现；未解绑真实令牌 |

账号操作仍受 Steam 手机绑定、地区、风控、交易冷却与接口变化影响。原项目市场管理 ViewModel 为空，本项目补上了挂单查询与官方页面入口，不将未实现的交易功能描述为已完成。

## 平台

| 平台 | 布局与工程 | 构建方式 | 已验证结果 |
| --- | --- | --- | --- |
| macOS | 桌面侧栏、自适应窗口，Tauri 原生工程 | 本机或 GitHub macOS runner；`.app`/`.dmg` | ARM64 本机发布与原生界面验证完成；ARM64/Intel 两项 CI 构建及上传通过 |
| Windows | 桌面侧栏、自适应窗口，同一 Rust/React 代码 | GitHub Windows runner 或本机 Windows；NSIS/MSI | x64 CI 编译、NSIS/MSI 打包与上传通过；未执行真机安装 |
| Android | 手机底部导航、安全区域、原生文件保存 | Android SDK/NDK；正式 APK/AAB | ARM64 调试 APK 与未签名发布 APK/AAB 本机编译通过，调试 APK 签名已校验 |
| iOS/iPadOS 15+ | 手机/平板响应式布局，Xcode 工程 | macOS/Xcode；模拟器 `.app` 与未签名真机归档 | 本机模拟器安装启动、未签名真机归档通过；两项 CI 构建及上传均通过 |
| LiveContainer IPA | 真机 ARM64 应用，标准 `Payload/*.app` 目录 | `npm run package:ios:ipa`；Actions 单独上传 IPA | IPA 结构、真机平台、可执行权限和未加密状态已检查；未进行 LiveContainer 实机启动验证 |

macOS、Windows、iOS 及前端测试的成功任务见 [Actions 运行记录](https://github.com/lx8s8/SteamGuard/actions/workflows/package.yml)。Android 已完成本机调试和发布出包，工作流已采用准确的 SDK 包标识 `platforms;android-37.0`，远端结果以修正后的运行记录为准。iOS 模拟器包与未签名归档均不是可直接分发的真机安装包。

默认 Rust 测试为 55 项通过、6 项选择性跳过；另行执行的真实 `.mpo` 私有往返测试和只读 Steam RSA 探测通过。Playwright 的 30 项测试使用明确的合成桥接响应验证界面逻辑，不能替代真实 Steam 账号联调或各系统 WebView 的真机测试。

## 暂不支持

- WattToolkit 新版 MemoryPack 导出、v1 压缩 `.dat`、启用本机保护且不在原机器解密的备份。
- WinAuth 加密 XML、Battle.net 在线恢复与绑定、微软/谷歌在线账号登录。
- 直接从相机或屏幕截图识别二维码；可以粘贴已解码的 OTP / Steam 二维码链接。
- 与原项目账号的云同步、WattToolkit 网络服务及全部非令牌插件。
- 自动下单、自动出售、批量自动确认、Steam 客户端游戏登录或游戏会话模拟。
- Apple Developer ID 公证、常规 iOS 分发及公共 CA 信任的 Windows 代码签名；Android 已使用固定发布密钥。

## Mobile quick access (1.1.0)

| Feature | Android | iOS | macOS / Windows |
| --- | --- | --- | --- |
| Phone layout, no page pinch zoom | Yes | Yes | Responsive narrow layout |
| Optional read-only OTP preview | Keystore protected cache key | Device-only Keychain cache key | Password required |
| Biometric full-vault unlock | Class 3 fingerprint / supported face | Touch ID / Face ID | Password required |
| Password fallback and encrypted backup | Yes | Yes | Yes |

Both quick-access settings are off by default and device-local. Preview allows code viewing/copying only. LiveContainer must support the app's Keychain and biometric API access; ordinary password unlock remains available.

## Groups and backups (1.2.0)

| Feature | Availability |
| --- | --- |
| Custom groups, rename/delete, token assignment and filtering | All platforms; preview can filter existing groups |
| Automatic encrypted snapshots, bounded retention, export and merge restore | All platforms |
| Encrypted snapshot export from locked screen | All platforms; metadata and encrypted files only |
| iOS system backup eligibility | Application Support included, device-only quick access excluded; system settings control upload |
| iCloud Drive / CloudKit realtime sync | Not implemented |

Versions before 1.2.0 use a different private data directory and are no longer distributed. See INSTALLATION.md for migration and BACKUP.md for storage, retention and restore behavior.

## Encrypted WebDAV sync (1.3.0)

| Feature | Availability |
| --- | --- |
| User-owned HTTPS WebDAV, Jianguoyun preset | All platforms; no app-hosted storage |
| Encrypted token/group sync, independent sync password | Argon2id + AES-256-GCM; Steam sessions excluded |
| Offline merge and explicit same-field conflicts | Automerge causal history; immutable checkpoint uploads |
| HOTP primary device and transfer | Secondary devices hide codes and cannot advance |
| Automatic foreground sync, pause/manual sync/disconnect | Full unlock required; preview never starts sync |
| Backup/restore of sync credentials | Excluded from portable and automatic snapshots; reconnect after restore |

See [SYNC.md](SYNC.md) for setup, limits and validation scope. WebDAV tests use a local protocol server and synthetic data. Version 1.3.1 also passed an authorized Jianguoyun service probe with synthetic tokens, encrypted roundtrips, merge and compaction; other providers and LiveContainer networking remain environment-specific verification.
