import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { t } from "./i18n";
import type { CloudAuthorization, CloudAvailability, CloudProvider, CloudStarted } from "./types";

export function cloudProvider(endpoint: string): CloudProvider | undefined {
  return (["google", "onedrive", "dropbox"] as const).find(provider => endpoint === `steamguard-cloud://${provider}/`);
}
export function CloudLogin({ provider, onAuthorized, disabled = false }: {
  provider: CloudProvider;
  onAuthorized: (authorization: CloudAuthorization) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [availability, setAvailability] = useState<CloudAvailability | null>(null);
  const [session, setSession] = useState<CloudStarted | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const generation = useRef(0);
  const sessionHandle = useRef<string | null>(null);
  const activeProvider = useRef(provider);
  activeProvider.current = provider;
  const authorized = useRef(onAuthorized);
  authorized.current = onAuthorized;
  const cancelSession = () => {
    const handle = sessionHandle.current;
    sessionHandle.current = null;
    if (handle) void api.cloudAuthCancel(handle).catch(() => {});
  };
  useEffect(() => {
    const request = ++generation.current;
    setAvailability(null); setSession(null); setCode(""); setError(""); setComplete(false);
    void api.cloudProviders().then(list => {
      if (request === generation.current) setAvailability(list?.find(item => item.provider === provider) ?? null);
    }).catch(e => { if (request === generation.current) setError(errorText(e)); });
    return () => { ++generation.current; cancelSession(); };
  }, [provider]);
  const poll = async (handle: string, request: number, manualCode?: string) => {
    const result = await api.cloudAuthPoll(handle, manualCode);
    if (request !== generation.current || sessionHandle.current !== handle || activeProvider.current !== provider) return;
    if (result.handle !== handle || cloudProvider(result.endpoint) !== provider) throw new Error(t("网盘登录响应无效"));
    if (!result.pending) {
      await authorized.current(result);
      if (request === generation.current) { setComplete(true); setCode(""); }
    }
  };
  useEffect(() => {
    if (!session || session.flow === "manual" || complete) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = generation.current;
    const run = async () => {
      try { await poll(session.handle, request); }
      catch (e) { if (!disposed && request === generation.current) { setError(errorText(e)); setSession(null); } return; }
      if (!disposed && request === generation.current) timer = setTimeout(() => void run(), 1500);
    };
    timer = setTimeout(() => void run(), session.flow === "complete" ? 0 : 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [session, complete]);
  const start = async () => {
    const request = ++generation.current;
    cancelSession(); setSession(null); setBusy(true); setError(""); setComplete(false); setCode("");
    try {
      const result = await api.cloudAuthStart(provider);
      if (request !== generation.current || activeProvider.current !== provider) { void api.cloudAuthCancel(result.handle).catch(() => {}); return; }
      sessionHandle.current = result.handle;
      setSession(result);
    } catch (e) { if (request === generation.current) setError(errorText(e)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <div className="cloud-login">
    {!availability?.supported && availability ? <p className="form-hint">{t("此平台暂不支持此网盘登录。")}</p>
      : availability && !availability.configured ? <p className="form-hint">{t("此版本尚未启用此网盘登录。")}</p>
      : complete ? <p role="status">{t("已登录网盘")}</p>
      : <button type="button" className="button secondary" disabled={disabled || busy || !availability} onClick={() => void start()}>{busy ? t("正在处理…") : session ? t("重新登录") : t("登录网盘")}</button>}
    {session && !complete && <div>
      {session.flow === "device" && <p role="status">{t("在浏览器输入此代码完成登录：")} <code>{session.userCode}</code></p>}
      {session.flow === "browser" && <p role="status">{t("请在系统浏览器完成登录。")}</p>}
      {session.flow === "manual" && <>
        <label className="field-label" htmlFor="cloud-authorization-code">{t("粘贴浏览器显示的授权码")}</label>
        <input id="cloud-authorization-code" autoComplete="off" autoCapitalize="none" spellCheck={false} value={code} maxLength={8192} disabled={disabled || busy} onChange={e => setCode(e.target.value)} />
        <button type="button" className="button secondary" disabled={disabled || busy || !code.trim()} onClick={async () => {
          const request = generation.current;
          setBusy(true); setError("");
          try { await poll(session.handle, request, code); }
          catch (e) { if (request === generation.current) setError(errorText(e)); }
          finally { if (request === generation.current) setBusy(false); }
        }}>{t("完成登录")}</button>
      </>}
      <button type="button" className="button secondary" disabled={disabled || busy} onClick={() => { ++generation.current; cancelSession(); setSession(null); setCode(""); }}>{t("取消登录")}</button>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
