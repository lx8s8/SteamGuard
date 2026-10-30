# 发布签名

发布者为 **kasen**。公开证书及指纹位于 `certificates/`，该目录不含私钥。

首次生成离线身份：

```sh
python3 scripts/create-signing.py
```

工具默认拒绝覆盖已有身份。Android 使用 3072 位 RSA、SHA256withRSA、10,000 天有效期的 JKS 发布密钥；Windows 使用 3072 位 RSA、SHA-256、代码签名扩展用途、10 年有效期的自签名证书。

私有备份默认在 `~/.config/SteamGuard/signing/`，目录权限 700、文件权限 600：

- `credentials.json`：随机生成的 keystore/key/PFX 密码、别名和路径。
- `kasen-android-release.jks`：Android 长期发布身份，后续升级必须沿用。
- `kasen-windows-signing.pfx`、加密 `.key`：Windows 自签名代码签名身份。
- `github-signing-secret.json`：写入仓库 Actions Secret `STEAMGUARD_SIGNING` 的内容。

请将整个目录另行安全备份。禁止提交或上传为构建产物；公开仓库只保存证书公钥及指纹。开发工程仍保留原 application ID，已有令牌库目录不会因本次版本更新而改变。

CI 仅在正式版本标签构建中加载签名 Secret，解码到临时 runner 目录和已忽略的 `keystore.properties`。密码作为环境变量/文件传递，不嵌入工作流命令；分字段注册日志遮蔽。Android 发布 APK/AAB 和 Windows 应用/EXE/MSI 均校验签名身份，版本标签缺少签名资料会阻止正式发布。

Windows 自签名证书不能替代公共 CA 信任或 SmartScreen 声誉，不会自动导入受信任根。macOS 使用 ad-hoc 签名；Developer ID、公证及常规 iOS 分发需要 Apple 开发者资格、账户权限和供应描述文件，不能仅凭生成随机密钥完成。现有其他项目/公司的证书不用于本项目。

完整构建、测试和签名验证通过后，版本标签触发的 Release 任务才会集中收集安装器、校验和及公开证书，先上传到草稿，再发布为非预发布的正式版。不会上传私钥或模拟器/归档 ZIP。
