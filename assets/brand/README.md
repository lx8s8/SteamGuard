# 应用图标

`app-icon.svg` 是可编辑母版：靛紫底色、环形轨迹、勾形与圆点。`mark.svg` 用于应用内标识和 Android 单色图标；`tray.svg` 使用紧凑画布，供 macOS 模板图标显示。

```sh
npm ci
npm run icons:generate
```

生成脚本更新 macOS / Windows 图标、iOS AppIcon、Android 各密度与自适应图标、单色图标、菜单栏图标及浏览器图标。它只生成图标资源，不打包应用。

iOS 从母版导出不带圆角的完整背景，系统负责裁切；所有 AppIcon 尺寸以现有 `Contents.json` 为准。Android 背景覆盖完整图层，前景位于系统遮罩安全区域；Android 13 及更新系统可使用单色主题图标。

图标几何同时用于 `src/AppMark.tsx`。修改形状时应同步更新母版、标记与 React 组件，并检查 16–32 像素下的辨识度。项目 UI 的中性色与靛紫交互色参考 [Magpie](https://github.com/demo007x/Magpie)，图标为本项目设计。
