# 导入、导出与兼容格式

二维码识别与文件处理均在本机完成；迁移协议解析、解密与令牌校验由 Rust 处理。原始账户文件、密钥、恢复码、账号名和生成的动态码不会写入测试日志。导入以整个文件为单位验证；任一记录损坏或无法解密时不会部分写入保险库。

## 支持矩阵

| 格式 | 导入 | 导出 | 范围 |
| --- | --- | --- | --- |
| WattToolkit 2.x `.mpo` | 支持 | 支持 | 原始 MessagePack 对象映射和平台 union，原始 LZ4BlockArray / LZ4Block 压缩，内置 AES，二级密码 AES |
| 启用本机加密的 `.mpo` | 明确拒绝 | 不生成 | 需在原电脑的 WattToolkit 关闭本机加密后重新导出 |
| 新版本 MemoryPack 格式 | 暂不支持 | 不生成 | 不将无法识别的数据当作导入成功；此实现针对所提供 2024 年文件使用的 MessagePack 格式 |
| SDA `.maFile` / Steam Guard JSON | 支持 | 支持单个 Steam 令牌 | `shared_secret`、`identity_secret`、`steamid`、`account_name`、`device_id`；兼容嵌套 `Session.SteamID` |
| `otpauth://` 文本 | 支持 | 支持单个令牌 | 多行、注释、TOTP/HOTP、SHA1/SHA256/SHA512、位数、周期和计数器；支持 `encoder=steam` |
| Google Authenticator `otpauth-migration://` | 支持 | 不生成 | MigrationPayload v1 的 TOTP/HOTP；支持相机、批量图片、多码图片与多行链接；收齐同一次导出的全部二维码后统一确认 |
| Aegis 未加密 JSON | 支持 | 不生成 | 外层 v1、内容 v1–v3；TOTP/HOTP/Steam、算法、周期、计数及分组；多个分组时保留第一个可识别分组 |
| 2FAS 未加密 `.2fas` / JSON | 支持 | 不生成 | schema v1–v4 的 services/otp，保留账号、算法、位数、周期、计数及分组 |
| Aegis / 2FAS 加密备份 | 明确拒绝 | 不生成 | 请在原软件导出未加密文件，再导入本机加密保险库 |
| WinAuth 未加密 XML | 支持 | 不生成 | `WinAuthAuthenticator`、十六进制 `secretdata`、Steam/HOTP/Battle.net 和普通 TOTP 附加数据 |
| WinAuth 加密 XML | 明确拒绝 | 不生成 | 先从 WinAuth 导出未加密 XML 或 otpauth 文本 |
| WattToolkit v1 压缩 `.dat` | 暂不支持 | 不生成 | 可先经原软件转换为 `.mpo` 或 otpauth 文本 |
| 普通 OTP JSON | 支持 | 不直接生成 | 单个对象、数组或 `{ "tokens": [...] }`，Base32 `secret`，可指定 `kind/name/issuer/algorithm/digits/period/counter` |
| 本项目 `.sgvault` | 支持 | 支持 | 由保险库模块处理，AES-256-GCM + Argon2id 密码派生；与 `.mpo` 分开识别 |

界面导入命令限制文件为 10 MiB、每次最多 1,000 个令牌。底层解析器限制文件和解压后的数据为 16 MiB、最多 10,000 条记录，MessagePack 深度和压缩嵌套层数有限制。普通 OTP 位数为 4–10、周期为 1–86,400 秒；不支持的算法会报错。

## 扫码导入与 Google 多张二维码

1. 在 SteamGuard 中点击“添加令牌 → 扫码 / 图片”。
2. Google Authenticator 中选择“转移账号 → 导出账号”，选择账号后显示一张或多张二维码；参见[Google 官方迁移说明](https://support.google.com/accounts/answer/1066447)。
3. 使用另一台设备的相机扫码，或点击“选择二维码图片”。可以多选图片，也支持一张图片中出现多个二维码。
4. Google 导出会显示“已收集 X/Y 张”和缺少的序号。可乱序扫描；重复二维码不会重复加入。同序号的不同内容会被拒绝；携带批次编号时也会拒绝混入其他导出批次。已收集的有效内容保留，请始终使用同一次导出的全部二维码。
5. 收齐后点击“预览令牌”，核对名称和数量，再“确认导入”。收集与预览阶段均不写入保险库。已有令牌按类型和密钥匹配，HOTP 保留较大的计数。

Google 导出使用 `otpauth-migration://offline?data=…`，内容为 Base64 编码的 Protobuf。支持已验证的迁移格式版本 0、1 和 2，校验总张数和当前序号。部分 iOS 版本 2 导出省略批次编号，按 Protobuf 默认值 0 读取；应用仍校验页数、序号、重复内容及完整性，但无法可靠区分来自不同无编号导出的互补页面，因此不能混扫不同次导出的二维码。解析采用 Prost，字段与 Aegis 当前维护的[迁移协议定义](https://github.com/beemdevelopment/Aegis/blob/master/app/src/main/proto/google_auth.proto)对照。文本导入同样检查批次完整性，不能通过逐张粘贴跳过缺页检查。

普通 `otpauth://` 设置码可以连续收集多个，适用于能导出标准设置码的 Aegis、Ente Auth、2FAS 等软件以及网站的双重验证设置页。完整备份文件按上面的格式矩阵支持，不把专有云同步或加密备份当作标准 OTP 码。

- 相机仅在点击扫码后开启。完成单次识别、停止、关闭导入窗口、锁定或切入后台时释放相机；无相机、拒绝权限或扫描超时可改用图片或文本。
- 手机采用 Tauri 官方原生扫码插件；Android 使用随包附带的 ML Kit 模型，避免依赖首次 Google Play 模型下载。iOS / LiveContainer 的相机权限仍由系统与宿主环境控制。
- 图片和桌面相机使用随应用分发的 ZXing-C++ WebAssembly，运行时不从 CDN 下载识别组件。原始二维码内容不会写入浏览器持久存储或诊断日志。
- 每次最多收集 128 张不同二维码、1000 个令牌；单个二维码文本不超过 64 KiB，总文本不超过 1 MiB。图片每张不超过 12 MiB，超过 4000 万像素会提示裁剪；识别画面会缩放以控制内存占用。
- 离开扫码页会丢弃本次收集，需重新开始；原生预览缓存 5 分钟过期，关闭或锁定时清理。请把同一次 Google 导出的所有码收齐后再离开。

## `.mpo` 的原始结构

顶层为 `AccountPlatformAuthenticator` 映射数组，记录包含 `Index`、加密 `Name`、加密 `Value`、`IsNotLocal`、`IsNeedSecondaryPassword`、`Created`、`LastUpdate`。`Value` 解密后为 `[platform, fields]`：Steam=1、Microsoft=5、Battle.net=11、Google=12、HOTP=13、TOTP=14。

MessagePack-CSharp 的 LZ4BlockArray 是 `[Ext(98, 各分段解压长度), Binary(压缩分段), ...]`；LZ4Block 使用 Ext(99)。解压长度是 MessagePack 整数编码，而非固定的原始整数。

WattToolkit 加密数据开头是 4 字节小端模式号：1 为内置 AES；2 为内置 AES + 本机保护；3 为内置 AES + 二级密码；4 为内置 AES + 二级密码 + 本机保护。模式 1 的下一层是 4 字节内置密钥版本（0），随后 AES-256-CBC/PKCS7 密文。模式 3 外包一层密码算法编号（0）及 AES-192-CBC/PKCS7 密文；原算法的密码派生为 SHA1(password) 拼接 CRC32 大端结果，IV 为 MD5(password)。

内置参数来自用户电脑现有 `/Applications/Steam++.app/Contents/MonoBundle/BD.WTTS.MicroServices.ClientSDK.dll` 中公开随应用分发的 `BD.WTTS.Properties.Resources.resources` / `aes-key` 资源。这是格式兼容参数，并非用户的 Steam 密钥。导出使用原始格式，不绑定本机；Steam 的附加 JSON（含恢复信息）和交易确认所需字段保留。旧 `.mpo` 算法未提供认证标签，现代本地保存和备份使用本项目的 `.sgvault`。

## 验证

提供的 2024-12-04 导出文件实际包含 2 条 Steam 记录，均未开启本机绑定和二级密码。已经在本机私有测试中完成原文件解压、解密、字段解析。没有将原文件或解密结果复制到项目内。

```sh
cd src-tauri
cargo test import::tests --lib
WATT_TEST_MPO='/absolute/path/to/private-export.mpo' cargo test real_mpo_private_import --lib -- --ignored
```

`real_mpo_private_import` 默认跳过，避免把真实账户文件变成仓库依赖。可选 `WATT_TEST_PASSWORD` 提供原导出密码。测试仅断言密钥和 Steam 确认字段存在，不打印账户信息。

## 参考源码

- 当前项目的 `src/BD.WTTS.Client.Plugins.Authenticator/Repositories/AccountPlatformAuthenticatorRepository.cs`、`Entities/AccountPlatformAuthenticator.cs`、`UI/ViewModels/AuthenticatorImportPageViewModel.cs`。
- [BeyondDimension/Common – SecurityService](https://github.com/BeyondDimension/Common/blob/main/src/BD.Common.Security/Services/Implementation/SecurityService.cs)、[内置 AES provider](https://github.com/BeyondDimension/Common/blob/main/src/BD.Common.Security/Services/Implementation/EmbeddedAesDataProtectionProviderBase.cs)、[二级密码 provider](https://github.com/BeyondDimension/Common/blob/main/src/BD.Common.Security/Services/Implementation/SecondaryPasswordDataProtectionProvider.cs)、[AESUtils](https://github.com/BeyondDimension/Common/blob/main/src/BD.Common/Security/Cryptography/AESUtils.cs)。
- [BeyondDimension/WinAuth – 平台 union](https://github.com/BeyondDimension/WinAuth/blob/main/src/WinAuth/BD.WTTS/Models/Abstractions/IAuthenticatorValueDTO.cs)、[SecretData 格式](https://github.com/BeyondDimension/WinAuth/blob/main/src/WinAuth/WinAuth/Authenticator.cs)、[Steam 附加字段](https://github.com/BeyondDimension/WinAuth/blob/main/src/WinAuth/WinAuth/SteamAuthenticator.cs)。
- [MessagePack-CSharp – LZ4 编解码](https://github.com/MessagePack-CSharp/MessagePack-CSharp/blob/master/src/MessagePack/MessagePackSerializer.cs)。

提取与改写部分保留上游 WattToolkit / WinAuth 来源，项目随附 GPL-3.0 许可。
