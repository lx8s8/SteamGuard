import { t as translate, formatDateTime, translateNativeText } from "./i18n";
import { useEffect, useState } from "react";
import { Archive, Download, History, RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import type { BackupPreview, BackupStatus, ExternalBackupStatus } from "./types";
import { Modal } from "./Modal";
const date = (value: number) => formatDateTime(value * 1000);

export function BackupBrowser({
  canRestore,
  onClose,
  onChange,
}: {
  canRestore: boolean;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [restoreIds, setRestoreIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    void api
      .backupStatus()
      .then((s) => {
        setStatus(s);
        setSelected(s.entries[0]?.name ?? "");
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  const run = async (restore: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (restore) {
        if (!preview) {
          const next = await api.backupPreview(selected, password);
          setPassword(""); setPreview(next);
          setRestoreIds(next.tokens.filter(t => t.status === "new" || t.status === "update").map(t => t.id));
        } else {
          const count = await api.backupRestoreSelected(preview.previewId, restoreIds);
          setPreview(null); setRestoreIds([]);
          setMessage(translate("已恢复所选的 {{count}} 个令牌。", { count: count }));
          await onChange();
          setStatus(await api.backupStatus());
        }
      } else {
        const path = await api.backupExport(selected);
        if (path) setMessage(translate("加密备份已导出，请妥善保存。"));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={translate("自动备份历史")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-intro">{translate("快照使用生成备份时的保险库主密码加密。导出文件后，也可以在其他设备上导入。")}</p>
      {status?.entries.length ? (
        <>
          <label className="field-label" htmlFor="backup-entry">{translate("选择备份")}</label>
          <select
            id="backup-entry"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setPreview(null); setRestoreIds([]); setPassword("");
              setMessage("");
            }}
            disabled={busy}
          >
            {status.entries.map((e) => (
              <option key={e.name} value={e.name}>
                {date(e.createdAt)} · {e.daily ? translate("每日快照") : translate("变更快照")} ·{" "}
                {Math.ceil(e.size / 1024)} KB
              </option>
            ))}
          </select>
          <button
            className="button secondary full-width backup-export"
            disabled={busy || !selected}
            onClick={() => void run(false)}
          >
            <Download size={17} />{translate("导出所选备份")}</button>
          {canRestore ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(true);
              }}
            >
              <p className="backup-restore-note">{translate("恢复会添加缺失令牌，并将所选已有令牌的设置还原到备份版本。未选令牌保留，HOTP 计数不会回退。Steam 账号可能需要重新登录。")}</p>
              {preview ? <div className="backup-preview" role="region" aria-label={translate("备份差异预览")}>
                <p>{translate("新增 {{newCount}} · 设置变更 {{updateCount}} · 相同 {{unchangedCount}} · 冲突 {{conflictCount}}", { newCount: preview.newCount, updateCount: preview.updateCount, unchangedCount: preview.unchangedCount, conflictCount: preview.conflictCount })}</p>
                <p className="form-hint">{translate("只恢复勾选项。已有令牌的名称、分组、头像及通用参数会恢复到备份版本，HOTP 计数不会降低。冲突项无法恢复，请核对说明。")}</p>
                <div className="selection-list">{preview.tokens.map(token => <label key={token.id}>
                  <input type="checkbox" disabled={busy || (token.status === "unchanged" || token.status === "conflict")} checked={restoreIds.includes(token.id)} onChange={e => setRestoreIds(e.target.checked ? [...restoreIds, token.id] : restoreIds.filter(id => id !== token.id))}/>
                  <span><strong>{token.name}</strong><small>{{ new: translate("新增"), update: translate("设置变更"), unchanged: translate("与当前相同"), conflict: translate("需要核对") }[token.status]} · {token.issuer || token.kind.toUpperCase()}</small>{token.detail && <small>{translateNativeText(token.detail)}</small>}</span>
                </label>)}</div>
                <button type="button" className="button text" disabled={busy} onClick={() => { setPreview(null); setRestoreIds([]); }}>{translate("重新选择备份")}</button>
              </div> : <><label className="field-label" htmlFor="backup-password">{translate("备份主密码")}</label>
              <input
                id="backup-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              /></>}
              <div className="modal-actions">
                <button
                  className="button primary"
                  disabled={busy || !selected || (preview ? !restoreIds.length : !password)}
                >
                  <History size={17} />
                  {preview ? translate("恢复所选令牌") : translate("验证并预览备份")}
                </button>
              </div>
            </form>
          ) : (
            <p className="form-hint">{translate("解锁保险库后可合并恢复。无法解锁时，可先导出备份，在新安装的应用中导入。")}</p>
          )}
        </>
      ) : status ? (
        <p className="form-hint">{translate("尚无自动备份。启用后，令牌库变更会自动生成快照。")}</p>
      ) : (
        <p className="form-hint">{translate("正在读取备份…")}</p>
      )}
      {message && (
        <p className="backup-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
export function BackupPanel({ onChange }: { onChange: () => Promise<void> }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [external, setExternal] = useState<ExternalBackupStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setStatus(await api.backupStatus());
  };
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    let live = true;
    let supported = false;
    const refreshExternal = () => void api.backupExternalStatus().then(next => {
      if (live) { supported = !!next?.supported; setExternal(next); }
    }).catch(e => { if (live) setError(errorText(e)); });
    refreshExternal();
    const timer = setInterval(() => { if (supported && !document.hidden) refreshExternal(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const run = async (enabled?: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (enabled === undefined) await api.backupNow();
      else await api.backupConfigure(enabled);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-panel backup-panel">
      <div className="panel-title">
        <span className="overview-icon green">
          <Archive size={22} />
        </span>
        <div>
          <h2>{translate("自动备份")}</h2>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <h3>{translate("变更后自动备份")}</h3>
          <p>{translate("保留最近 10 次变更和最多 30 个每日快照。备份沿用保险库主密码。")}</p>
        </div>
        <button
          className="access-switch"
          role="switch"
          aria-label={translate("变更后自动备份")}
          aria-checked={!!status?.enabled}
          disabled={busy || !status}
          onClick={() => void run(!status?.enabled)}
        >
          <span />
        </button>
      </div>
      <div className="setting-row">
        <div>
          <h3>{translate("最近备份")}</h3>
          <p>
            {status?.entries[0]
              ? date(status.entries[0].createdAt)
              : translate("尚无快照")}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void run()}
        >
          <RefreshCw size={17} />{translate("立即备份")}</button>
      </div>
      <div className="setting-row">
        <div>
          <h3>{translate("备份历史与恢复")}</h3>
          <p>{translate("{{value1}} 个本机快照，可导出或合并恢复。", { value1: status?.entries.length ?? 0 })}</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || !status?.entries.length}
          onClick={() => setOpen(true)}
        >
          <History size={17} />{translate("查看")}</button>
      </div>
      {status?.externalSupported && <details className="token-details" open={directoryOpen} onToggle={e => setDirectoryOpen(e.currentTarget.open)}><summary>{translate("备份保存目录")}</summary><p className="form-hint backup-directory-path">{status.directory}</p><label className="field-label" htmlFor="backup-directory">{translate("自定义本机目录")}</label><input id="backup-directory" value={directory} placeholder={translate("输入绝对路径")} disabled={busy} onChange={e => setDirectory(e.target.value)}/><div className="sync-actions"><button className="button secondary" disabled={busy || !directory.trim()} onClick={() => { setBusy(true); setError(""); void api.backupDirectory(directory.trim()).then(refresh).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{translate("应用目录")}</button><button className="button text" disabled={busy} onClick={() => { setBusy(true); setError(""); void api.backupDirectory().then(refresh).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{translate("恢复默认目录")}</button></div></details>}
      {external?.supported && <div className="setting-row external-backup-setting"><div><h3>{translate("外部备份目录")}</h3><p className="backup-directory-path">{external.configured ? external.label : translate("尚未选择目录")}</p><p>{translate("自动将加密快照另存到所选目录。重置目录会保留已有备份文件。")}</p></div><div className="sync-actions"><button className="button secondary" disabled={busy} onClick={() => { setBusy(true); setError(""); void api.backupExternalChoose().then(setExternal).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{translate("选择目录")}</button>{external.configured && <button className="button text" disabled={busy} onClick={() => { setBusy(true); setError(""); void api.backupExternalClear().then(setExternal).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{translate("重置目录")}</button>}</div></div>}
      <p className="access-note">
        {status?.systemBackup === "ios-system"
          ? translate("已允许 iOS 系统备份收录加密保险库。请在系统设置中开启 iCloud 备份；应用无法检测云端是否已完成。LiveContainer 还取决于容器的数据备份支持。")
          : status?.systemBackup === "ios-unavailable"
            ? translate("本机快照可用，但当前环境未能配置 iOS 系统备份。请导出一份加密备份另存。")
            : translate("快照保存在应用本机目录，卸载或设备损坏可能一并丢失。建议定期导出到另一台设备或你使用的云盘。")}
      </p>
      {(error || status?.error || external?.error) && (
        <p className="form-error" role="alert">
          {error || (status?.error ? errorText(status.error) : external?.error ? errorText(external.error) : "")}
        </p>
      )}
      {open && (
        <BackupBrowser
          canRestore
          onClose={() => setOpen(false)}
          onChange={async () => {
            await onChange();
            await refresh();
          }}
        />
      )}
    </section>
  );
}
