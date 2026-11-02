import { useEffect, useState } from "react";
import { api, errorText } from "./api";
export function DesktopSettings() {
  const [settings, setSettings] = useState<{
    supported: boolean;
    resident: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api
      .desktopSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);
  if (!settings?.supported) return null;
  return (
    <section className="settings-panel">
      <div className="panel-title">
        <h2>桌面</h2>
      </div>
      <div className="setting-row">
        <div>
          <h3>关闭窗口后常驻托盘</h3>
          <p>点击菜单栏或任务栏图标，查看并复制验证码。</p>
        </div>
        <button
          className="access-switch"
          role="switch"
          aria-label="关闭窗口后常驻托盘"
          aria-checked={settings.resident}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setSettings(await api.desktopConfigure(!settings.resident));
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <span />
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
