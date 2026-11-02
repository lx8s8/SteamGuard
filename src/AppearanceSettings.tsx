import { t as translate } from "./i18n";
import { useEffect, useState } from "react";
import { call, native } from "./api";
export type ThemePreference = "system" | "light" | "dark";
const themeKey = "steamguard.theme";
const sizeKey = "steamguard.textSize";
function readPreference(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePreference(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* appearance can still be used for this session */ } }
let previousTheme = "";
export function applyAppearance() {
  const theme = readPreference(themeKey, "system"), size = readPreference(sizeKey, "100");
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--text-scale", String(["100", "112", "125"].includes(size) ? Number(size) / 100 : 1));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111821" : "#ffffff");
  if (native && !new URLSearchParams(location.search).has("view") && theme !== previousTheme) {
    previousTheme = theme;
    void call("appearance_configure", { theme: ["light", "dark"].includes(theme) ? theme : "system" }).catch(() => { previousTheme = ""; });
  }
}
applyAppearance();
const media = matchMedia("(prefers-color-scheme: dark)");
media.addEventListener("change", applyAppearance);
window.addEventListener("storage", applyAppearance);
export function AppearanceSettings() {
  const [theme, setTheme] = useState(readPreference(themeKey, "system"));
  const [size, setSize] = useState(readPreference(sizeKey, "100"));
  useEffect(() => { applyAppearance(); }, [theme, size]);
  return <section className="settings-panel">
    <div className="panel-title"><h2>{translate("外观")}</h2></div>
    <div className="setting-row"><label htmlFor="appearance-theme">{translate("主题")}</label><select id="appearance-theme" value={theme} onChange={e => { writePreference(themeKey, e.target.value); setTheme(e.target.value); applyAppearance(); }}><option value="system">{translate("跟随系统")}</option><option value="light">{translate("浅色")}</option><option value="dark">{translate("深色")}</option></select></div>
    <div className="setting-row"><label htmlFor="appearance-size">{translate("文字大小")}</label><select id="appearance-size" value={size} onChange={e => { writePreference(sizeKey, e.target.value); setSize(e.target.value); applyAppearance(); }}><option value="100">{translate("标准")}</option><option value="112">{translate("较大")}</option><option value="125">{translate("大")}</option></select></div>
  </section>;
}
