import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TrayApp from "./TrayApp";
import "./styles.css";
import "./mobile.css";
import "./compact.css";
const isTray =
  new URLSearchParams(window.location.search).get("view") === "tray";
if (isTray) document.documentElement.classList.add("tray-window");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isTray ? <TrayApp /> : <App />}</React.StrictMode>,
);
