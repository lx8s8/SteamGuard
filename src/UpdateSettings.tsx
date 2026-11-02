import { useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Download, RefreshCw } from "lucide-react";
import { call, errorText } from "./api";
import { t as translate } from "./i18n";

type UpdateInfo = { currentVersion: string; latestVersion: string; available: boolean; canInstall: boolean; notes: string };
type UpdateProgress = { phase: "download" | "install"; downloaded: number; total: number | null };
export function UpdateSettings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await job(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); setProgress(null); setCancelling(false); }
  };
  const install = async () => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = setProgress;
    try { await call("update_install", { progress: channel }); }
    catch (e) { setInfo(null); throw e; }
    finally { channel.onmessage = () => {}; }
  };
  const cancel = async () => {
    setCancelling(true);
    try { if (!await call<boolean>("update_cancel")) setCancelling(false); }
    catch (e) { setError(errorText(e)); setCancelling(false); }
  };
  return <section className="settings-panel">
    <div className="panel-title"><h2>{translate("应用更新")}</h2><button className="button secondary" disabled={busy} onClick={() => void run(async () => { setInfo(null); setInfo(await call<UpdateInfo>("update_check")); })}><RefreshCw size={16} />{translate("检查更新")}</button></div>
    {info && <>
      <p>{translate("当前版本 {{current}} · 最新版本 {{latest}}", { current: info.currentVersion, latest: info.latestVersion })}</p>
      {info.available ? <>
        {info.notes && <details><summary>{translate("更新内容")}</summary><pre className="update-notes">{info.notes}</pre></details>}
        <div className="modal-actions"><button className="button primary" disabled={busy} onClick={() => void run(async () => { if (info.canInstall) await install(); else await call("update_open_download"); })}><Download size={16} />{info.canInstall ? translate("下载并安装，完成后重启") : translate("前往下载")}</button></div>
      </> : <p className="inline-success" role="status">{translate("已是最新版本")}</p>}
    </>}
    {progress && <div className="update-progress">
      <p role="status">{progress.phase === "install" ? translate("正在安装更新") : translate("正在下载更新")}</p>
      <progress aria-label={translate("下载进度")} max={progress.total && progress.total > 0 ? progress.total : undefined} value={progress.total && progress.total > 0 ? Math.min(progress.downloaded, progress.total) : undefined} />
      {progress.phase === "download" && <button className="button secondary" disabled={cancelling} onClick={() => void cancel()}>{translate("取消下载")}</button>}
    </div>}
    {busy && !progress && <p role="status">{translate("正在处理…")}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
