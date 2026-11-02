# iCloud 同步

macOS 和 iOS 可使用系统当前登录账号的 iCloud Drive 保存加密同步库，无需网盘应用密码或自建服务器。其他平台继续使用 WebDAV、Google Drive、OneDrive 或 Dropbox。iCloud 不是跨 Apple / Windows / Android 的通用同步入口；需要这些平台共同使用时，应选择各端都支持的同一种网盘。

应用中选择「多端同步 → iCloud Drive」，先查找已有同步库。另一台设备加入同一编号的库并填写该库的独立同步密码。本机保险库主密码可以不同；相同同步密码不会自动合并两个独立库。连接配置二维码只含服务、固定账号标签和库编号，没有密码或令牌密钥。

## 数据与更新方式

原生桥使用 `URLForUbiquityContainerIdentifier`，只访问注册容器中的 `Documents/SteamGuard/steamguard-sync-v1/`。上传内容与其他网盘采用相同格式：随机库编号、KDF 参数、加密校验头，以及 AES-256-GCM 加密的不可变 Automerge 快照。令牌、备注、恢复码和自定义头像均在快照内加密。账号密码、保险库解锁密钥、Steam 登录会话和钥匙串项目不参与同步；不启用 iCloud Keychain 同步。

`NSMetadataQuery` 检测远端文档变化，应用解锁且处于前台时检测修订并运行原有合并流程，同时保留定期重试。锁定、预览、暂停同步、退到后台或退出应用会停止查询并取消文件协调。iCloud 的上传、下载与推送由系统调度，因此不是承诺即时送达的后台服务。

读取使用 `NSFileCoordinator`，先请求下载云端占位文件，再进行有大小限制的读取。目录发现同时检查原生元数据，避免把尚未下载的同步库误判为空。写入使用唯一文件名和原子落盘，不覆盖不同内容的文件；只有系统确认新快照已上传，才允许清理已被该快照覆盖的旧文件。上传未完成时保留现有历史并停止堆积新快照，下次前台同步重试。原生文件冲突不会擅自选择版本。单文件 32 MiB、单目录 512 项，下载、查询与上传有等待上限；账号变化会取消当前连接。

## 开发者接入配置

默认构建没有登记 iCloud 容器，仍可编译全部平台，界面显示未配置。仅设置环境变量不代表 Apple 授权成功；有效签名、App ID 能力、容器和 provisioning profile 必须一致。临时签名、无 iCloud 授权的重签名包以及 LiveContainer 的宿主签名不能自动获得本应用容器权限。

1. 在 Apple Developer 为 macOS、iOS App ID 启用 iCloud Documents，并为两者关联同一个容器。选择属于自己开发团队的容器 ID。重新生成包含该能力的描述文件。此容器与小组件所用 App Group 是独立能力，不应互相替代。
2. 将 [entitlements 模板](examples/icloud.entitlements.example.plist) 的三个 iCloud 键合并到各平台现有 entitlements。将示例 `iCloud.com.example.authenticator` 替换成已登记 ID，保留现有相机、应用标识、钥匙串、App Group 等键。签名中的团队和 application identifier 应来自实际描述文件。
3. 将 [Info.plist 模板](examples/icloud-info.example.plist) 的 `NSUbiquitousContainers` 合并到应用 Info.plist，使用相同容器 ID。容器设为非公开文档范围，不向 Files/Finder 暴露一套可编辑的令牌文档。无需 `UIFileSharingEnabled`、CloudKit database 或 iCloud KV-store 权限。
4. 在构建 Rust 原生插件的环境中设置公开配置 `STEAMGUARD_ICLOUD_CONTAINER_ID`，并使用已授权的证书和描述文件签名。这是公开容器 ID，不是用户账号，也不是 client secret。不要把密码、签名私钥、描述文件或真实用户数据放入模板。

macOS 可将合并后的文件保存在已忽略的 `src-tauri/icloud.local/` 目录，并参考 [Tauri overlay 示例](examples/tauri.icloud.example.json)，通过 `tauri build --config src-tauri/icloud.local/config.json` 选择私有配置。签名 identity 使用实际开发团队的证书。iOS 在 Xcode **主应用 target** 的 Signing & Capabilities 中配置相同容器，把 Info.plist 合并项及实际 entitlements 保留在本地构建配置；不要给 Widget/Intent extension 复制主应用的 iCloud 权限。Tauri 的 iOS 配置没有通用 `entitlements` 字段，应在 Xcode app target 指定。重新生成工程后检查这些本地设置。

应用运行时同时检查平台、编译容器配置、系统 iCloud 身份和实际容器可用性。尚未授权、系统未登录或 iCloud Drive 关闭时，不创建同步库。系统账号切换后，请先断开并确认目标账号与库，再重新连接。

## 验证范围

自动测试使用合成凭据和内存云端，覆盖加密库发现、正确/错误同步密码、快照合并、并发文件保留、上传未完成时保留历史、路径限制与禁止明文写入。原生桥检查 macOS / iOS 编译和路径协议。没有登记开发者容器时，不连接真实 iCloud、不创建云端文件。

登记后仍需使用同一 iCloud 账号在两台 Apple 设备验证首次加入、云端占位下载、网络中断恢复、账号切换、锁定/后台停止，以及并发修改。该验收与编译检查分开记录，不以构建成功代替实机结果。

依据：[Apple iCloud Documents](https://developer.apple.com/library/archive/documentation/General/Conceptual/iCloudDesignGuide/Chapters/DesigningForDocumentsIniCloud.html)、[NSFileCoordinator](https://developer.apple.com/documentation/foundation/nsfilecoordinator)、[NSMetadataQuery](https://developer.apple.com/documentation/foundation/nsmetadataquery)、[Tauri macOS 配置](https://v2.tauri.app/distribute/macos-application-bundle/)、[Tauri 配置字段](https://v2.tauri.app/reference/config/)。
