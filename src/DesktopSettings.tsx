import { useEffect, useState } from "react";
import { call, errorText } from "./api";
import { t as translate } from "./i18n";

type Settings = {
  supported: boolean;
  resident: boolean;
  shortcut: string;
  shortcutRegistered: boolean;
  autostart: boolean;
  autostartSupported: boolean;
};

const autoHideKey = "steamguard.trayAutoHide";
function readAutoHide(): boolean {
  try { return localStorage.getItem(autoHideKey) === "1"; } catch { return false; }
}
function writeAutoHide(enabled: boolean) {
  try { localStorage.setItem(autoHideKey, enabled ? "1" : "0"); } catch { /* 忽略隐私存储限制 */ }
}

/** 将浏览器按键事件格式化为 Tauri 全局快捷键字符串（例如 CmdOrCtrl+Shift+G）。 */
function formatShortcutEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const modifiers: string[] = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("CmdOrCtrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const raw = event.key;
  if (["Control", "Shift", "Alt", "Meta", "Dead", "Process"].includes(raw)) return null;
  if (!modifiers.length) return null;
  const code = event.code;
  let mainKey = "";
  if (/^Key[A-Z]$/.test(code)) mainKey = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) mainKey = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(raw)) mainKey = raw;
  else if (raw === " ") mainKey = "Space";
  else if (raw.length === 1 && /^[a-z0-9]$/i.test(raw)) mainKey = raw.toUpperCase();
  else if (["Tab", "Enter", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(raw)) {
    mainKey = raw.replace(/^Arrow/, "");
  } else {
    return null;
  }
  return [...modifiers, mainKey].join("+");
}

export function DesktopSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [recording, setRecording] = useState(false);
  const [autoHide, setAutoHide] = useState(readAutoHide);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  useEffect(() => {
    void call<Settings>("desktop_settings")
      .then((value) => {
        setSettings(value);
        setShortcut(value.shortcut || "");
      })
      .catch(() => {});
  }, []);

  const save = async (options: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      const value = await call<Settings>("desktop_configure", options);
      setSettings(value);
      setShortcut(value.shortcut || "");
      setRecording(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!settings?.supported) return null;
  return (
    <section className="settings-panel desktop-settings">
      <div className="panel-title"><h2>{translate("桌面")}</h2></div>
      <div className="setting-row">
        <h3>{translate("关闭窗口后常驻托盘")}</h3>
        <button
          className="access-switch"
          role="switch"
          aria-label={translate("关闭窗口后常驻托盘")}
          aria-checked={settings.resident}
          disabled={busy}
          onClick={() => void save({ resident: !settings.resident })}
        ><span /></button>
      </div>
      <div className="setting-row">
        <h3>{translate("复制后自动关闭快捷窗口")}</h3>
        <button
          className="access-switch"
          role="switch"
          aria-label={translate("复制后自动关闭快捷窗口")}
          aria-checked={autoHide}
          disabled={busy}
          onClick={() => {
            const next = !autoHide;
            setAutoHide(next);
            writeAutoHide(next);
          }}
        ><span /></button>
      </div>
      {settings.autostartSupported && (
        <div className="setting-row">
          <h3>{translate("开机启动")}</h3>
          <button
            className="access-switch"
            role="switch"
            aria-label={translate("开机启动")}
            aria-checked={settings.autostart}
            disabled={busy}
            onClick={() => void save({ autostart: !settings.autostart })}
          ><span /></button>
        </div>
      )}
      <div className="desktop-shortcut">
        <label className="field-label" htmlFor="desktop-shortcut">{translate("快捷复制快捷键")}</label>
        <div className="scanner-actions">
          <input
            id="desktop-shortcut"
            value={shortcut}
            placeholder={recording ? translate("按下快捷键") : "CmdOrCtrl+Shift+G"}
            maxLength={128}
            disabled={busy}
            className={recording ? "recording-shortcut" : undefined}
            onChange={(e) => setShortcut(e.target.value)}
            onKeyDown={(e) => {
              if (!recording) return;
              if (e.key === "Escape") {
                e.preventDefault();
                setRecording(false);
                return;
              }
              if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                setShortcut("");
                setRecording(false);
                return;
              }
              const combo = formatShortcutEvent(e);
              if (combo) {
                e.preventDefault();
                setShortcut(combo);
                setRecording(false);
              }
            }}
            onBlur={() => setRecording(false)}
          />
          <button
            type="button"
            className={`button secondary${recording ? " active-record" : ""}`}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setRecording((v) => !v);
              document.getElementById("desktop-shortcut")?.focus();
            }}
          >{recording ? translate("按下快捷键") : translate("录制快捷键")}</button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || shortcut === settings.shortcut}
            onClick={() => void save({ shortcut })}
          >{translate("保存快捷键")}</button>
        </div>
        <p className="form-hint">{translate("支持 CmdOrCtrl、Alt、Shift 组合；留空关闭。↑↓ 选择令牌，Enter 复制，Esc 关闭。")}</p>
        {settings.shortcut && !settings.shortcutRegistered && (
          <p className="form-error">{translate("快捷键被占用，请设置其他组合")}</p>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
