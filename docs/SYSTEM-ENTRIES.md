# 手机系统快捷入口

在设置的「手机快捷入口」中启用并选择最多 4 个令牌。系统入口显示所选名称；点击后进入应用，完成现有的密码或生物识别解锁，再点击复制。HOTP 也沿用应用原来的计数与主设备限制。

| 平台 | 已实现的入口 | 要求 |
| --- | --- | --- |
| Android | 桌面小组件、长按应用图标的快捷操作、快捷设置磁贴 | Android 7.0+；图标快捷操作需要 Android 7.1+ |
| iOS | 小、中、大号 WidgetKit 小组件 | iOS 15+；显示令牌名称需要 App Group 授权 |
| iOS | 快捷指令中的打开应用、复制验证码操作 | iOS 16+；验证码复制仍需在应用内点击确认 |

Android 在桌面的小组件选择器中添加 SteamGuard，在快捷设置编辑页中添加 SteamGuard 磁贴。长按图标可将快捷操作拖到桌面。小组件会随尺寸调整显示行数，最多显示 4 行；启动器可能限制图标快捷操作数量。

iOS 小组件的打开应用入口默认可用。启用选定名称列表时，主应用和小组件必须由同一开发者团队签名，并在对应描述文件中授权同一个 App Group。没有共享授权时，设置页会提示，小组件继续显示打开应用。LiveContainer 等容器安装方式是否允许系统发现扩展由安装环境决定，容器内启动应用不等于系统已注册 WidgetKit 扩展。

## iOS 签名配置

默认工程不包含虚构的团队或 App Group 授权，可以直接进行未签名的编译验证。小组件目标是 `SteamGuardWidgets`，包名为 `com.kasen.steamguard.widgets`，与主应用版本一致，并已加入嵌入扩展构建阶段。

`scripts/mobile.mjs ios build/dev/run` 会先从 Tauri JSON 配置同步主应用与小组件的版本，支持 `bundle.iOS.bundleVersion`、JSON `--config` 覆盖和 `--build-number`。直接使用 Xcode 前可运行 `node scripts/ios-versions.mjs` 更新工程源文件；这条命令只同步版本，不编译或打包。两个目标的快捷入口文本内置 16 种语言。

1. 在 Apple Developer 为主应用、小组件开启同一个 App Group，并更新两个目标的描述文件。
2. 在本地生成已获授权的共享组配置：

   ```sh
   STEAMGUARD_APP_GROUP=group.example.authenticator \
     python3 scripts/configure-ios-system-entries.py --generate
   ```

3. 在 Xcode 中为两个目标选择实际的团队和授权描述文件。构建时保留相同的 `STEAMGUARD_APP_GROUP` 环境变量。脚本生成的 `src-tauri/gen/apple/system-entry.generated.yml` 和 `.system-entry/` 已被 Git 忽略，不会把团队配置带入默认工程。

如同时使用 iCloud 授权，通过 `--app-entitlements /path/to/authorized-app.entitlements` 传入主应用 entitlement 文件；脚本保留现有能力，只增加共享组，小组件只申请 App Group。直接运行普通 `xcodegen generate --spec src-tauri/gen/apple/project.yml` 可恢复默认无共享组工程；重新启用时需再次使用生成的覆盖配置。

## 数据与路由

- 选择只保存在当前设备，默认关闭，不作为云端同步设置。
- Rust 从已解锁的保险库读取所选 ID 和名称；前端不能向系统发布任意名称。共享数据只有 `enabled`、`entries[].id`、`entries[].label`，不存储密钥、验证码、恢复码、备注或 Steam 会话。
- 关闭后清除系统列表。Android 启动器拥有用户固定的快捷图标，应用会禁用旧快捷操作并清除其名称；启动器可能保留图标，需要用户自行移除。
- 系统入口只发送 `steamguard://entry/open` 或 `steamguard://entry/copy?id=<UUID>`。Rust 拒绝其他路径、额外参数、过期请求和不在选定列表中的 ID。请求最长保留 120 秒；保险库锁定时不消费请求。
- 外部 URL、快捷指令和小组件都不能直接生成或复制验证码，也不会批准 Steam 交易。应用使用现有解锁流程，展示相应令牌供用户操作。
- 主应用在解锁与令牌变动后刷新系统元数据。设备锁定时保留用户主动展示的名称；iOS 视图标记为 `privacySensitive`，系统可根据遮盖设置隐藏名称。

## 编译验证

仅检查源码，不创建发布包：

```sh
xcodegen generate --spec src-tauri/gen/apple/project.yml
xcodebuild -project src-tauri/gen/apple/steamguard.xcodeproj \
  -target SteamGuardWidgets -sdk iphonesimulator -configuration debug \
  CODE_SIGNING_ALLOWED=NO build
```

Android 插件使用项目 Gradle 配置执行 `:tauri-plugin-system-entry:compileDebugKotlin`。实际模块名由 Tauri 的生成设置决定。接口测试包含 URL 参数约束、选项数量与共享快照字段范围；主界面测试覆盖选择保存、入口仅定位和显式复制。

实现参考：[Android 快捷设置磁贴](https://developer.android.com/develop/ui/views/quicksettings-tiles)、[Android 应用快捷操作](https://developer.android.com/develop/ui/views/launch/shortcuts/creating-shortcuts)、[WidgetKit 场景链接](https://developer.apple.com/documentation/widgetkit/linking-to-specific-app-scenes-from-your-widget-or-live-activity)、[WidgetKit 交互](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)。
