import { useEffect, useState } from "react";
import { call, errorText } from "./api";
import { t } from "./i18n";
export function ClipboardSettings() {
  const [seconds, setSeconds] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { void call<{clearAfter:number}>("clipboard_settings").then(value => { if (value && [0,15,30,60,120].includes(value.clearAfter)) setSeconds(value.clearAfter); }).catch(() => {}); }, []);
  return <section className="settings-panel">
    <div className="panel-title"><h2>{t("验证码复制")}</h2></div>
    <div className="setting-row"><label htmlFor="clipboard-clear-after">{t("复制后清除")}</label><select id="clipboard-clear-after" value={seconds} disabled={busy} onChange={async e => {
      const next = Number(e.target.value); setBusy(true); setError("");
      try { const value = await call<{clearAfter:number}>("clipboard_configure", {clearAfter:next}); setSeconds(value.clearAfter); }
      catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    }}><option value={0}>{t("不自动清除")}</option>{[15,30,60,120].map(value => <option key={value} value={value}>{t("{{period}} 秒", {period:value})}</option>)}</select></div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
