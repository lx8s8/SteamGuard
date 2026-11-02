import React from "react";
import ReactDOM from "react-dom/client";
import { useTranslation } from "react-i18next";
import "./i18n";
import App from "./App";
import TrayApp from "./TrayApp";
import "./styles.css";
import "./mobile.css";
import "./compact.css";
import "./appearance.css";
const isTray = new URLSearchParams(window.location.search).get("view") === "tray";
if (isTray) document.documentElement.classList.add("tray-window");

function LocalizedApp() {
  // Re-render the whole UI on locale changes while preserving component/vault state.
  useTranslation();
  return isTray ? <TrayApp /> : <App />;
}
// Vite may re-run this entry while catalog files change. Reuse the existing root.
const root = import.meta.hot?.data.root ?? ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <React.StrictMode><LocalizedApp /></React.StrictMode>,
);
