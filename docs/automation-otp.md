# 自动化 OTP 接口

桌面源码提供本机 HTTP 取码，用于受控测试账号。默认关闭，仅监听 `127.0.0.1`；Android/iOS 不启动服务。保险库必须通过应用正常解锁，手动锁定或空闲到期后拒绝取码，HTTP 请求不会延长解锁时间。

## 启用

解锁应用，打开目标测试令牌的“管理令牌 → 令牌详情”，点击“复制令牌 ID”；该只读 ID 就是配置中的 `tokenId`，不需要导出 OTP 密钥。复制沿用应用的剪贴板定时清理设置，也可从只读输入框手动复制。

在仓库外保存配置。示例保持关闭；填好白名单再改为 `true`：

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "port": 49188,
  "bindings": [
    {
      "accountAlias": "demo-dev-user",
      "environment": "dev",
      "brand": "demo",
      "tokenId": "替换为测试令牌的 UUID"
    }
  ]
}
```

从启动应用的进程注入：

- `STEAMGUARD_AUTOMATION_OTP_CONFIG`：配置文件的绝对路径
- `STEAMGUARD_AUTOMATION_OTP_TOKEN`：独立随机 Bearer 凭据，32–512 字符，仅允许字母、数字及 `._~+/=-`

配置与凭据只在启动时读取，修改后重启应用。无配置或 `enabled: false` 不监听端口；启用后的配置错误、凭据缺失或端口冲突会阻止此次应用启动。凭据不要写入仓库、命令参数或测试报告。macOS 双击应用不会自动继承终端变量；开发时可从已注入变量的终端运行 `npm run tauri dev`。

桌面无界面操作超过 900 秒（15 分钟）后取码返回 `423`，即使主窗口仍可见；再次正常解锁后才能继续。桌面隐藏窗口不会启动 60 秒后台计时，60 秒后台锁定属于移动端策略，移动端不提供此 HTTP 服务。因此长时间无人值守的 Mac mini 任务仍需单独解决正常解锁与会话安排，不能依靠轮询 API 保持解锁。

## 调用

`POST http://127.0.0.1:49188/v1/otp/resolve`

请求头：`Authorization: Bearer <凭据>`、`Content-Type: application/json`。

```json
{
  "accountAlias": "demo-dev-user",
  "environment": "dev",
  "brand": "demo",
  "minValiditySeconds": 8,
  "runId": "run-20261104-001"
}
```

`accountAlias`、`environment`、`brand` 必须与同一白名单项完全匹配，仅接受小写字母、数字及 `_.-`，最多 64 字符；`runId` 是最多 128 字符的运行标识。`minValiditySeconds` 为 1–60，默认 8。

成功返回 `200`：

```json
{
  "accountAlias": "demo-dev-user",
  "kind": "totp",
  "code": "001234",
  "expiresAt": "2026-11-04T00:00:30Z",
  "serverTime": "2026-11-04T00:00:00Z"
}
```

`code` 始终为保留前导零的字符串，仅支持 6/8 位 TOTP。时间采用秒精度 UTC；调用方应扣除网络耗时检查有效期。响应禁止缓存，不返回密钥、令牌列表或原始底层错误。

| 状态 | 含义 |
| --- | --- |
| 400 / 405 / 415 | 请求格式、方法或内容类型不支持 |
| 401 | 凭据无效 |
| 403 / 404 | 环境或品牌不匹配、浏览器请求、别名或令牌不存在 |
| 409 | 当前码有效期不足，按整数秒 `Retry-After` 等待后重新取码 |
| 413 / 429 | 请求过大或超过 4 个并发连接 |
| 422 / 423 | 非 6/8 位 TOTP，或保险库已锁定/到期 |
| 503 | 保险库忙或服务暂不可用 |

错误正文为固定 JSON，例如 `{"error":"locked"}`。请求头上限 8 KiB、正文 16 KiB、连接处理超时 5 秒；不接受浏览器 Origin、重定向、分块上传或批量查询。接口不提供 HTTP 解锁、HOTP 递增、Steam 验证码或密钥导出。

## 验证

```sh
cargo test --manifest-path src-tauri/Cargo.toml automation_otp --locked
```

定向测试使用公开 RFC 密钥、合成账号和临时 loopback 服务，覆盖白名单、锁定、取码、有效期、鉴权、报文限制与服务停止。未读取真实保险库，也未进行真实账号登录联调。
