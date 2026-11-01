# 构建签名配置

本文供维护者配置构建环境。普通用户按[安装说明](INSTALLATION.md)选择安装包即可。

## 初始化与保管

首次配置可运行：

```sh
python3 scripts/create-signing.py
```

脚本默认拒绝覆盖已有配置，生成的私有文件保存在仓库外的本机配置目录。请单独备份并限制文件访问权限，后续发布沿用已有配置以保持升级兼容性。

## CI 配置

将生成的配置写入仓库 Actions Secret `STEAMGUARD_SIGNING`。正式版本构建从 Secret 加载配置并写入 runner 临时目录；运行日志对敏感字段进行遮蔽。缺少配置或校验失败时，正式发布任务会停止。

仓库的 `certificates/` 仅供维护者与 CI 核对构建身份，不作为 Releases 附件。发布收集脚本只允许平台安装包、`LICENSE.txt` 和 `SHA256SUMS`，发现额外文件时会停止。

## 平台分发

Windows、macOS 和常规 iOS 分发分别受对应平台的信任与分发要求约束。Developer ID、公证、TestFlight 和 App Store 发布需要相应开发者账号及平台配置，详见[构建文档](BUILDING.md)。
