import { useEffect, useState } from "react";
import { call, errorText } from "./api";
import { t as translate } from "./i18n";
type Settings = { supported: boolean; resident: boolean; shortcut: string; shortcutRegistered: boolean; autostart: boolean; autostartSupported: boolean };
export function DesktopSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { void call<Settings>("desktop_settings").then(value => { setSettings(value); setShortcut(value.shortcut || ""); }).catch(() => {}); }, []);
  const save = async (options: Record<string, unknown>) => {
    setBusy(true); setError("");
    try { const value = await call<Settings>("desktop_configure", options); setSettings(value); setShortcut(value.shortcut || ""); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (!settings?.supported) return null;
  return <section className="settings-panel">
    <div className="panel-title"><h2>{translate("桌面")}</h2></div>
    <div className="setting-row"><h3>{translate("关闭窗口后常驻托盘")}</h3><button className="access-switch" role="switch" aria-label={translate("关闭窗口后常驻托盘")} aria-checked={settings.resident} disabled={busy} onClick={() => void save({ resident: !settings.resident })}><span /></button></div>
    {settings.autostartSupported && <div className="setting-row"><h3>{translate("开机启动")}</h3><button className="access-switch" role="switch" aria-label={translate("开机启动")} aria-checked={settings.autostart} disabled={busy} onClick={() => void save({ autostart: !settings.autostart })}><span /></button></div>}
    <div className="desktop-shortcut"><label className="field-label" htmlFor="desktop-shortcut">{translate("快捷复制快捷键")}</label><div className="scanner-actions"><input id="desktop-shortcut" value={shortcut} placeholder="CmdOrCtrl+Shift+G" maxLength={128} disabled={busy} onChange={e => setShortcut(e.target.value)} /><button className="button secondary" disabled={busy || shortcut === settings.shortcut} onClick={() => void save({ shortcut })}>{translate("保存快捷键")}</button></div><p className="form-hint">{translate("支持 CmdOrCtrl、Alt、Shift 组合；留空关闭。↑↓ 选择令牌，Enter 复制，Esc 关闭。")}</p>{settings.shortcut && !settings.shortcutRegistered && <p className="form-error">{translate("快捷键被占用，请设置其他组合")}</p>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
