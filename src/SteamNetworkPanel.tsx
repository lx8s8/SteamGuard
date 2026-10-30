import { useEffect, useId, useState } from "react";
import {
  Check,
  CircleHelp,
  Globe2,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { api, errorText } from "./api";
import type { NetworkReport, NetworkSettings } from "./types";

export function SteamNetworkPanel() {
  const id = useId();
  const [settings, setSettings] = useState<NetworkSettings>({
    mode: "system",
    proxyUrl: "",
  });
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<NetworkReport | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .networkSettings()
      .then((value) => {
        if (active) {
          setSettings(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (diagnose: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (diagnose) setReport(await api.networkDiagnostics());
      else {
        await api.configureNetwork(settings);
        setReport(null);
        setMessage("连接方式已保存，对后续 Steam 请求生效");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-panel network-panel">
      <div className="panel-title">
        <span className="overview-icon blue">
          <Globe2 size={20} />
        </span>
        <div>
          <h2>Steam 网络连接</h2>
          <p>选择连接方式，检查认证、时间和社区接口</p>
        </div>
      </div>
      <label className="field-label" htmlFor={`${id}-mode`}>
        连接方式
      </label>
      <select
        id={`${id}-mode`}
        disabled={!ready || busy}
        value={settings.mode}
        onChange={(e) => {
          setSettings({
            ...settings,
            mode: e.target.value as NetworkSettings["mode"],
          });
          setMessage("");
        }}
      >
        <option value="system">使用系统代理（推荐）</option>
        <option value="direct">直接连接</option>
        <option value="manual">手动代理</option>
      </select>
      {settings.mode === "manual" && (
        <>
          <label className="field-label" htmlFor={`${id}-proxy`}>
            代理地址
          </label>
          <input
            id={`${id}-proxy`}
            value={settings.proxyUrl}
            disabled={busy}
            onChange={(e) =>
              setSettings({ ...settings, proxyUrl: e.target.value })
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:7890"
          />
          <p className="form-hint">
            支持 HTTP、HTTPS、SOCKS5 /
            SOCKS5H。请填写当前设备的实际代理地址；地址中不支持用户名和密码。
          </p>
        </>
      )}
      {settings.mode === "system" && (
        <p className="form-hint">
          读取 Windows 系统代理或 Android
          系统代理配置。若代理软件仅开放本地端口，请选择手动代理。
        </p>
      )}
      <div className="network-actions">
        <button
          className="button primary"
          disabled={!ready || busy}
          onClick={() => void run(false)}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          保存连接方式
        </button>
        <button
          className="button secondary"
          disabled={!ready || busy}
          onClick={() => void run(true)}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          检测已保存配置
        </button>
      </div>
      {message && (
        <p className="network-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {report && (
        <ul className="network-results" aria-label="Steam 网络检测结果">
          {report.checks.map((check) => (
            <li key={check.name} className={check.ok ? "ok" : "failed"}>
              {check.ok ? <Check size={16} /> : <CircleHelp size={16} />}
              <div>
                <strong>{check.name}</strong>
                <span>
                  {check.ok ? `连接正常 · ${check.latencyMs} ms` : check.error}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
