import { useEffect, useState } from "react";
import { Archive, Download, History, RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import type { BackupStatus } from "./types";
import { Modal } from "./Modal";
const date = (value: number) =>
  new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });

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
        const count = await api.backupRestore(selected, password);
        setPassword("");
        setMessage(`已合并备份，补回 ${count} 个令牌。`);
        await onChange();
        setStatus(await api.backupStatus());
      } else {
        const path = await api.backupExport(selected);
        if (path) setMessage("加密备份已导出，请妥善保存。");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="自动备份历史"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-intro">
        快照使用生成备份时的保险库主密码加密。导出文件后，也可以在其他设备上导入。
      </p>
      {status?.entries.length ? (
        <>
          <label className="field-label" htmlFor="backup-entry">
            选择备份
          </label>
          <select
            id="backup-entry"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setMessage("");
            }}
            disabled={busy}
          >
            {status.entries.map((e) => (
              <option key={e.name} value={e.name}>
                {date(e.createdAt)} · {e.daily ? "每日快照" : "变更快照"} ·{" "}
                {Math.ceil(e.size / 1024)} KB
              </option>
            ))}
          </select>
          <button
            className="button secondary full-width backup-export"
            disabled={busy || !selected}
            onClick={() => void run(false)}
          >
            <Download size={17} />
            导出所选备份
          </button>
          {canRestore ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(true);
              }}
            >
              <p className="backup-restore-note">
                恢复会补回缺失的令牌和分组，保留当前令牌，不回退 HOTP
                计数。Steam 账号可能需要重新登录。
              </p>
              <label className="field-label" htmlFor="backup-password">
                备份主密码
              </label>
              <input
                id="backup-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
              <div className="modal-actions">
                <button
                  className="button primary"
                  disabled={busy || !password || !selected}
                >
                  <History size={17} />
                  合并恢复
                </button>
              </div>
            </form>
          ) : (
            <p className="form-hint">
              解锁保险库后可合并恢复。无法解锁时，可先导出备份，在新安装的应用中导入。
            </p>
          )}
        </>
      ) : status ? (
        <p className="form-hint">
          尚无自动备份。启用后，令牌库变更会自动生成快照。
        </p>
      ) : (
        <p className="form-hint">正在读取备份…</p>
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setStatus(await api.backupStatus());
  };
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
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
          <h2>自动备份</h2>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <h3>变更后自动备份</h3>
          <p>保留最近 10 次变更和最多 30 个每日快照。备份沿用保险库主密码。</p>
        </div>
        <button
          className="access-switch"
          role="switch"
          aria-label="变更后自动备份"
          aria-checked={!!status?.enabled}
          disabled={busy || !status}
          onClick={() => void run(!status?.enabled)}
        >
          <span />
        </button>
      </div>
      <div className="setting-row">
        <div>
          <h3>最近备份</h3>
          <p>
            {status?.entries[0]
              ? date(status.entries[0].createdAt)
              : "尚无快照"}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void run()}
        >
          <RefreshCw size={17} />
          立即备份
        </button>
      </div>
      <div className="setting-row">
        <div>
          <h3>备份历史与恢复</h3>
          <p>{status?.entries.length ?? 0} 个本机快照，可导出或合并恢复。</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || !status?.entries.length}
          onClick={() => setOpen(true)}
        >
          <History size={17} />
          查看
        </button>
      </div>
      <p className="access-note">
        {status?.systemBackup === "ios-system"
          ? "已允许 iOS 系统备份收录加密保险库。请在系统设置中开启 iCloud 备份；应用无法检测云端是否已完成。LiveContainer 还取决于容器的数据备份支持。"
          : status?.systemBackup === "ios-unavailable"
            ? "本机快照可用，但当前环境未能配置 iOS 系统备份。请导出一份加密备份另存。"
            : "快照保存在应用本机目录，卸载或设备损坏可能一并丢失。建议定期导出到另一台设备或你使用的云盘。"}
      </p>
      {(error || status?.error) && (
        <p className="form-error" role="alert">
          {error || status?.error}
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
