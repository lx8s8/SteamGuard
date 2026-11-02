# 语言与翻译

应用内置以下 16 种语言，运行时不请求在线翻译服务。

| 语言 | 标识 |
| --- | --- |
| 简体中文 | zh-CN |
| 繁體中文 | zh-TW |
| English | en |
| 日本語 | ja |
| 한국어 | ko |
| Deutsch | de |
| Français | fr |
| Español | es |
| Português (Brasil) | pt-BR |
| Русский | ru |
| Italiano | it |
| العربية | ar |
| हिन्दी | hi |
| Bahasa Indonesia | id |
| Türkçe | tr |
| Tiếng Việt | vi |

## 使用

解锁页和「设置 → 语言」均可切换。默认跟随系统；不支持的系统语言回退为英语。中文优先识别 Hans / Hant，其次识别地区。选择立即生效，不清空当前表单，重新启动后保留。

语言偏好仅保存在当前设备，不随令牌同步。桌面应用菜单与托盘菜单跟随应用语言。阿拉伯语使用从右向左布局；验证码、Steam 字母码、账号标识和用户名称保留原始内容。日期与数量按所选语言格式显示。

设备认证提示跟随应用语言。Apple 相机、Face ID 和照片权限说明也内置 16 种语言，系统权限弹窗按系统选择的应用语言显示。

## 贡献翻译

资源位于 `src/i18n/locales/<语言标识>.json`。中文源文案作为键，资源随应用打包，不使用运行时 DOM 文本替换。

- 保留 `{{name}}`、`{{count}}` 等插值名称，可按目标语言调整变量位置。
- 不翻译协议值、URL、扩展名、用户名称或验证码。
- 新文案使用 `t(...)` 或 `translate(...)`，动态值通过插值传入，避免拼接不完整句子。
- 原生错误只翻译已登记的完整消息和锚定模板，未知诊断保留原文。
- 修改后检查按钮长度、窄屏溢出与 RTL 顺序，并运行以下检查。

```sh
node scripts/i18n.mjs extract-native
node scripts/i18n.mjs extract
node scripts/i18n.mjs native-permissions
npm run test:i18n
npx playwright test tests/i18n-ui.spec.ts
```

提取命令生成源码目录，新增键仍需在所有语言资源中补齐。检查会拒绝缺译、空值和插值不一致。静态源码工具不读取保险库、备份或二维码；提交翻译时也请只使用应用文案与合成数据。

Apple 权限说明来自 `src/i18n/permission-messages.json`，生成到 `src-tauri/locales/*.lproj/InfoPlist.strings`。修改翻译后重新生成，避免直接改动生成文件。
