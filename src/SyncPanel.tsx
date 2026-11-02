import { useEffect, useState } from "react";
import { Cloud, Copy, RefreshCw } from "lucide-react";
import { api, errorText, native } from "./api";
import { Modal } from "./Modal";
import { SyncSetup } from "./SyncSetup";
import type { SyncStatus, TokenView } from "./types";
const CONFIG = "steamguard:sync-config";
const UPDATED = "steamguard:sync-updated";
const changed = () => window.dispatchEvent(new Event(CONFIG));

// Foreground only. Password-free preview cannot start network synchronization.
export function useSyncWatcher(unlocked: boolean, fingerprint: string) {
  useEffect(() => {
    if (!native || !unlocked) return;
    let disposed = false;
    const run = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      try {
        const status = await api.syncStatus();
        if (disposed || !status?.configured || !status.active || status.busy)
          return;
        await api.syncRun(true);
        window.dispatchEvent(new Event(UPDATED));
      } catch {
        window.dispatchEvent(new Event(UPDATED));
      }
    };
    const timer = window.setTimeout(() => void run(), 2000);
    const interval = window.setInterval(() => void run(), 60_000);
    const foreground = () => void run();
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener(CONFIG, foreground);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener(CONFIG, foreground);
    };
  }, [unlocked, fingerprint]);
}
export function SyncPanel({
  tokens,
  onChange,
}: {
  tokens: TokenView[];
  onChange: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [choosingLibrary, setChoosingLibrary] = useState(false);
  const [confirm, setConfirm] = useState<"disconnect" | "hotp" | null>(null);
  const [hotp, setHotp] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const refresh = (clearError = false) =>
      void api
        .syncStatus()
        .then((s) => {
          if (live) {
            setStatus(s);
            if (clearError && !s?.error) setError("");
          }
        })
        .catch((e) => {
          if (live) setError(errorText(e));
        });
    refresh();
    const timer = window.setInterval(refresh, 3000);
    const updated = () => refresh(true);
    window.addEventListener(UPDATED, updated);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(UPDATED, updated);
    };
  }, []);
  const run = async (action: () => Promise<SyncStatus>, config = false) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setStatus(await action());
      await onChange();
      if (config) changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const working = busy || !!status?.busy;
  const hotps = tokens.filter((t) => t.kind === "hotp" && t.hotpReadOnly);
  return (
    <section className="settings-panel sync-panel">
      <div className="panel-title">
        <span className="overview-icon green">
          <Cloud size={22} />
        </span>
        <div>
          <h2>多端同步</h2>
        </div>
      </div>
      {status?.configured ? (
        <>
          <div className="setting-row">
            <div>
              <h3>{status.active ? "自动同步已开启" : "自动同步已暂停"}</h3>
              <p>解锁后、回到前台和令牌变更时同步。锁定或预览模式下停止。</p>
            </div>
            <button
              className="access-switch"
              role="switch"
              aria-label="自动同步"
              aria-checked={status.active}
              disabled={working}
              onClick={() =>
                void run(() => api.syncPause(!status.active), true)
              }
            >
              <span />
            </button>
          </div>
          <dl className="sync-details">
            <dt>WebDAV</dt>
            <dd>{status.endpoint}</dd>
            <dt>网盘账号</dt>
            <dd>{status.username}</dd>
            <dt>同步库编号</dt>
            <dd>
              <code>{status.libraryId}</code>
              <button
                className="icon-button"
                aria-label="复制同步库编号"
                onClick={() =>
                  void navigator.clipboard.writeText(status.libraryId).then(
                    () => setMessage("同步库编号已复制。"),
                    () => setError("无法访问剪贴板，请手动复制编号。"),
                  )
                }
              >
                <Copy size={16} />
              </button>
            </dd>
            <dt>最近同步</dt>
            <dd>
              {status.lastSuccess
                ? new Date(status.lastSuccess * 1000).toLocaleString("zh-CN", {
                    hour12: false,
                  })
                : "尚未完成"}
              {status.dirty ? " · 有待上传的变更" : ""}
            </dd>
          </dl>
          <p className="access-note">
            在其他设备选择“加入已有同步库”，选择相同编号的库并填写它的同步密码。Steam
            登录会话仅保留在本机。
          </p>
          <div className="sync-actions">
            <button
              className="button primary"
              disabled={working}
              onClick={() => void run(() => api.syncRun())}
            >
              <RefreshCw size={16} className={working ? "spin" : ""} />
              {working ? "正在同步…" : "立即同步"}
            </button>
            <button
              className="button secondary"
              disabled={working}
              onClick={() => setConfirm("disconnect")}
            >
              断开同步
            </button>
          </div>
          <button
            className="button secondary"
            disabled={working}
            onClick={() => {
              setError("");
              setChoosingLibrary(true);
            }}
          >
            选择其他同步库合并
          </button>
          {status.conflicts.length > 0 && (
            <div className="sync-conflicts" role="region" aria-label="同步冲突">
              <h3>有 {status.conflicts.length} 项冲突待确认</h3>
              <p>
                各设备同时修改了同一字段。选择要保留的版本，其他字段仍会正常同步。
              </p>
              {status.conflicts.map((c) => (
                <fieldset key={c.id} disabled={working}>
                  <legend>
                    {c.name} · {c.field}
                  </legend>
                  {c.choices.map((v, i) => (
                    <label className="sync-choice" key={v.id}>
                      <input
                        type="radio"
                        name={c.id}
                        checked={choices[c.id] === v.id}
                        onChange={() =>
                          setChoices({ ...choices, [c.id]: v.id })
                        }
                      />
                      <span>
                        {v.label}
                        <small>
                          {v.local ? "本机版本" : `其他设备版本 ${i + 1}`}
                        </small>
                      </span>
                    </label>
                  ))}
                  <button
                    className="button secondary"
                    disabled={!choices[c.id]}
                    onClick={() =>
                      void run(() => api.syncResolve(c.id, choices[c.id]), true)
                    }
                  >
                    保留所选版本
                  </button>
                </fieldset>
              ))}
            </div>
          )}
          {hotps.length > 0 && (
            <div className="setting-row">
              <div>
                <h3>HOTP 主设备</h3>
                <p>{hotps.length} 个 HOTP 在本机只读，验证码由主设备生成。</p>
              </div>
              <button
                className="button secondary"
                disabled={working}
                onClick={() => {
                  setHotp(hotps[0].id);
                  setAcknowledged(false);
                  setConfirm("hotp");
                }}
              >
                切换到本机
              </button>
            </div>
          )}
        </>
      ) : (
        <SyncSetup
          tokenCount={tokens.length}
          onConnected={async (next) => {
            setStatus(next);
            await onChange();
            changed();
          }}
        />
      )}
      {!confirm && (error || status?.error) && (
        <p className="form-error" role="alert">
          {error || status?.error}
        </p>
      )}
      {message && (
        <p className="backup-message" role="status">
          {message}
        </p>
      )}
      {choosingLibrary && status?.configured && (
        <Modal
          title="选择同步库并合并"
          onClose={() => {
            if (!busy) setChoosingLibrary(false);
          }}
        >
          <SyncSetup
            current={status}
            tokenCount={tokens.length}
            onBusyChange={setBusy}
            onCancel={() => setChoosingLibrary(false)}
            onConnected={async (next) => {
              setStatus(next);
              setChoosingLibrary(false);
              await onChange();
              changed();
              setMessage(
                next.error
                  ? "已在本机合并并切换同步库，云端上传尚未完成，请点击立即同步重试。"
                  : "已合并并切换同步库。请让其他设备也选择这个编号。",
              );
            }}
          />
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm === "disconnect" ? "断开同步" : "切换 HOTP 主设备"}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          {confirm === "disconnect" ? (
            <p className="dialog-intro">
              本机令牌和云端同步库都会保留。本机将恢复独立使用，之后的修改不再同步。
            </p>
          ) : (
            <>
              <p className="dialog-intro">
                请先在旧设备停止使用此 HOTP
                令牌，并让两台设备完成同步。离线旧设备无法被远程禁用，继续使用可能造成计数错乱。
              </p>
              <label className="field-label" htmlFor="sync-hotp">
                选择 HOTP 令牌
              </label>
              <select
                id="sync-hotp"
                value={hotp}
                onChange={(e) => setHotp(e.target.value)}
              >
                {hotps.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <label className="sync-choice">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>旧设备已停止使用此 HOTP 令牌</span>
              </label>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                busy || (confirm === "hotp" && (!acknowledged || !hotp))
              }
              onClick={() =>
                void run(async () => {
                  const s =
                    confirm === "disconnect"
                      ? await api.syncDisconnect()
                      : await api.syncClaimHotp(hotp, acknowledged);
                  setConfirm(null);
                  return s;
                }, true)
              }
            >
              {confirm === "disconnect" ? "确认断开" : "设为主设备"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
