import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { useTranslation } from "react-i18next";
import "./i18n";
import "./styles.css";
import "./mobile.css";
import "./compact.css";
import "./appearance.css";

// 托盘浮窗与主应用路由级拆分，避免托盘弹出时解析主界面的全部代码。
const App = lazy(() => import("./App"));
const TrayApp = lazy(() => import("./TrayApp"));
const isTray = new URLSearchParams(window.location.search).get("view") === "tray";
if (isTray) document.documentElement.classList.add("tray-window");

function LocalizedApp() {
  // 语言切换时重渲染界面，同时保留表单与保险库状态。
  useTranslation();
  return <Suspense fallback={null}>{isTray ? <TrayApp /> : <App />}</Suspense>;
}
// Vite 在目录热更新时可能重跑入口，复用已有根节点。
const root = import.meta.hot?.data.root ?? ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <React.StrictMode><LocalizedApp /></React.StrictMode>,
);
