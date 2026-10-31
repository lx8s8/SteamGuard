import { useEffect, useState } from "react";
import { Cloud, Copy, RefreshCw } from "lucide-react";
import { api, errorText, native } from "./api";
import { Modal } from "./Modal";
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
  const [mode, setMode] = useState<"create" | "join">("create");
  const [preset, setPreset] = useState("jianguoyun");
  const [endpoint, setEndpoint] = useState("https://dav.jianguoyun.com/dav/");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [libraryId, setLibraryId] = useState("");
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
          <p>使用自己的网盘，端到端加密同步令牌与分组</p>
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
            在其他设备选择“加入已有同步库”，填写相同的网盘信息、编号和同步密码。Steam
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
        <form
          className="sync-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const s = await api.syncConnect({
                endpoint,
                username,
                password,
                syncPassword,
                mode,
                libraryId: mode === "join" ? libraryId.trim() : undefined,
              });
              setPassword("");
              setSyncPassword("");
              return s;
            }, true);
          }}
        >
          <p className="access-note">
            支持坚果云及兼容标准 WebDAV 的网盘。需要网盘应用密码；SteamGuard
            不提供云存储。首次连接会将本机令牌合并到同步库。
          </p>
          <label className="field-label" htmlFor="sync-mode">
            连接方式
          </label>
          <select
            id="sync-mode"
            disabled={working}
            value={mode}
            onChange={(e) => setMode(e.target.value as "create" | "join")}
          >
            <option value="create">创建新的同步库</option>
            <option value="join">加入已有同步库</option>
          </select>
          <label className="field-label" htmlFor="sync-preset">
            网盘服务
          </label>
          <select
            id="sync-preset"
            disabled={working}
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setEndpoint(
                e.target.value === "jianguoyun"
                  ? "https://dav.jianguoyun.com/dav/"
                  : "",
              );
            }}
          >
            <option value="jianguoyun">坚果云</option>
            <option value="custom">其他 WebDAV</option>
          </select>
          <label className="field-label" htmlFor="sync-endpoint">
            WebDAV 地址
          </label>
          <input
            id="sync-endpoint"
            type="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={working}
            placeholder="https://…/dav/"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <label className="field-label" htmlFor="sync-user">
            网盘账号
          </label>
          <input
            id="sync-user"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={1024}
            disabled={working}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="field-label" htmlFor="sync-dav-password">
            网盘应用密码
          </label>
          <input
            id="sync-dav-password"
            type="password"
            autoComplete="off"
            required
            disabled={working}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "join" && (
            <>
              <label className="field-label" htmlFor="sync-library">
                同步库编号
              </label>
              <input
                id="sync-library"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={working}
                placeholder="另一台设备显示的编号"
                value={libraryId}
                onChange={(e) => setLibraryId(e.target.value)}
              />
            </>
          )}
          <label className="field-label" htmlFor="sync-password">
            独立同步密码
          </label>
          <input
            id="sync-password"
            type="password"
            autoComplete={mode === "create" ? "new-password" : "off"}
            minLength={mode === "create" ? 12 : undefined}
            maxLength={4096}
            required
            disabled={working}
            value={syncPassword}
            onChange={(e) => setSyncPassword(e.target.value)}
          />
          <p className="form-hint">
            创建时至少 12
            个字符。用于加密云端令牌，与网盘应用密码区分；其他设备需要相同密码。请妥善保管，无法找回。
          </p>
          <button className="button primary" disabled={working || !status}>
            {working
              ? "正在连接…"
              : mode === "create"
                ? "创建并同步"
                : "加入并同步"}
          </button>
        </form>
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
