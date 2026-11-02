import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { call, errorText } from "./api";
import { t as translate } from "./i18n";

type UpdateInfo = { currentVersion: string; latestVersion: string; available: boolean; canInstall: boolean; notes: string };
export function UpdateSettings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await job(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <section className="settings-panel">
    <div className="panel-title"><h2>{translate("应用更新")}</h2><button className="button secondary" disabled={busy} onClick={() => void run(async () => setInfo(await call<UpdateInfo>("update_check")))}><RefreshCw size={16} />{translate("检查更新")}</button></div>
    {info && <>
      <p>{translate("当前版本 {{current}} · 最新版本 {{latest}}", { current: info.currentVersion, latest: info.latestVersion })}</p>
      {info.available ? <>
        {info.notes && <details><summary>{translate("更新内容")}</summary><pre className="update-notes">{info.notes}</pre></details>}
        <div className="modal-actions"><button className="button primary" disabled={busy} onClick={() => void run(async () => { if (info.canInstall) await call("update_install"); else await call("update_open_download"); })}><Download size={16} />{info.canInstall ? translate("下载并安装，完成后重启") : translate("前往下载")}</button></div>
      </> : <p className="inline-success" role="status">{translate("已是最新版本")}</p>}
    </>}
    {busy && <p role="status">{translate("正在处理…")}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
