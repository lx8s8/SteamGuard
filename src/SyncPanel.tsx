import { t as translate, formatDateTime, translateNativeText } from "./i18n";
import { useEffect, useState } from "react";
import { Cloud, Copy, RefreshCw } from "lucide-react";
import { api, errorText, native } from "./api";
import { Modal } from "./Modal";
import QRCode from "qrcode";
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
    window.addEventListener("steamguard:foreground-ready", foreground);
    window.addEventListener(CONFIG, foreground);
    window.addEventListener("steamguard:local-change", foreground);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("steamguard:foreground-ready", foreground);
      window.removeEventListener(CONFIG, foreground);
      window.removeEventListener("steamguard:local-change", foreground);
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
  const [configImage, setConfigImage] = useState("");
  const [configText, setConfigText] = useState("");
  const [alias, setAlias] = useState("");
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [credentialEndpoint, setCredentialEndpoint] = useState("");
  const [credentialUsername, setCredentialUsername] = useState("");
  const [credentialPassword, setCredentialPassword] = useState("");
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
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 5000);
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
          <h2>{translate("多端同步")}</h2>
        </div>
      </div>
      {status?.configured ? (
        <>
          <div className="setting-row">
            <div>
              <h3>{status.active ? translate("自动同步已开启") : translate("自动同步已暂停")}</h3>
              <p>{translate("解锁后、回到前台和令牌变更时同步。锁定或预览模式下停止。")}</p>
            </div>
            <button
              className="access-switch"
              role="switch"
              aria-label={translate("自动同步")}
              aria-checked={status.active}
              disabled={working}
              onClick={() =>
                void run(() => api.syncPause(!status.active), true)
              }
            >
              <span />
            </button>
          </div>
          <details className="token-details"><summary>{status.alias || translate("同步库名称与连接设置")}</summary>
            <form onSubmit={e => { e.preventDefault(); void run(() => api.syncSetAlias(alias.trim()), true); }}><label className="field-label" htmlFor="sync-alias">{translate("同步库别名")}</label><input id="sync-alias" value={alias} maxLength={80} placeholder={status.alias || translate("例如 我的手机和电脑")} disabled={working} onChange={e => setAlias(e.target.value)}/><div className="sync-actions"><button className="button secondary" disabled={working || !alias.trim()}>{translate("保存别名")}</button></div></form>
            <div className="sync-actions"><button className="button secondary" disabled={working} onClick={() => { setBusy(true); setError(""); void api.syncConnectionInfo().then(async info => { setConfigText(info.connectionQr); setConfigImage(await QRCode.toDataURL(info.connectionQr, { width: 280, margin: 2 })); }).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{translate("显示加入配置二维码")}</button><button className="button secondary" disabled={working} onClick={() => { setCredentialEndpoint(status.endpoint); setCredentialUsername(status.username); setCredentialPassword(""); setError(""); setEditingCredentials(true); }}>{translate("更新网盘应用密码")}</button></div>
          </details>
          <dl className="sync-details">
            <dt>WebDAV</dt>
            <dd>{status.endpoint}</dd>
            <dt>{translate("网盘账号")}</dt>
            <dd>{status.username}</dd>
            <dt>{translate("同步库编号")}</dt>
            <dd>
              <code>{status.libraryId}</code>
              <button
                className="icon-button"
                aria-label={translate("复制同步库编号")}
                onClick={() =>
                  void navigator.clipboard.writeText(status.libraryId).then(
                    () => setMessage(translate("同步库编号已复制。")),
                    () => setError(translate("无法访问剪贴板，请手动复制编号。")),
                  )
                }
              >
                <Copy size={16} />
              </button>
            </dd>
            <dt>{translate("最近同步")}</dt>
            <dd>
              {status.lastSuccess
                ? formatDateTime(status.lastSuccess * 1000)
                : translate("尚未完成")}
              {status.dirty ? translate(" · 有待上传的变更") : ""}
            </dd>
          </dl>
          <p className="access-note">{translate("在其他设备选择“加入已有同步库”，选择相同编号的库并填写它的同步密码。Steam 登录会话仅保留在本机。")}</p>
          <div className="sync-actions">
            <button
              className="button primary"
              disabled={working}
              onClick={() => void run(() => api.syncRun())}
            >
              <RefreshCw size={16} className={working ? "spin" : ""} />
              {working ? translate("正在同步…") : translate("立即同步")}
            </button>
            <button
              className="button secondary"
              disabled={working}
              onClick={() => setConfirm("disconnect")}
            >{translate("断开同步")}</button>
          </div>
          <button
            className="button secondary"
            disabled={working}
            onClick={() => {
              setError("");
              setChoosingLibrary(true);
            }}
          >{translate("选择其他同步库合并")}</button>
          {status.conflicts.length > 0 && (
            <div className="sync-conflicts" role="region" aria-label={translate("同步冲突")}>
              <h3>{translate("有 {{length}} 项冲突待确认", { length: status.conflicts.length })}</h3>
              <p>{translate("各设备同时修改了同一字段。选择要保留的版本，其他字段仍会正常同步。")}</p>
              {status.conflicts.map((c) => (
                <fieldset key={c.id} disabled={working}>
                  <legend>
                    {c.name} · {translateNativeText(c.field)}
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
                          {v.local ? translate("本机版本") : translate("其他设备版本 {{value1}}", { value1: i + 1 })}
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
                  >{translate("保留所选版本")}</button>
                </fieldset>
              ))}
            </div>
          )}
          {hotps.length > 0 && (
            <div className="setting-row">
              <div>
                <h3>{translate("HOTP 主设备")}</h3>
                <p>{translate("{{length}} 个 HOTP 在本机只读，验证码由主设备生成。", { length: hotps.length })}</p>
              </div>
              <button
                className="button secondary"
                disabled={working}
                onClick={() => {
                  setHotp(hotps[0].id);
                  setAcknowledged(false);
                  setConfirm("hotp");
                }}
              >{translate("切换到本机")}</button>
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
          {error || (status?.error ? errorText(status.error) : "")}
        </p>
      )}
      {message && (
        <p className="backup-message" role="status">
          {message}
        </p>
      )}
      {configImage && <Modal title={translate("加入这个同步库")} onClose={() => { setConfigImage(""); setConfigText(""); }}><p className="dialog-intro">{translate("在另一台设备的同步设置中读取此配置二维码，再填写网盘应用密码和独立同步密码。二维码包含地址、账号和库编号，不含密码或令牌密钥。")}</p><div className="qr-login-panel"><img src={configImage} width={280} height={280} alt={translate("不含密码的同步配置二维码")}/></div><button className="button secondary full-width" onClick={() => void navigator.clipboard.writeText(configText).then(() => setMessage(translate("同步配置已复制。")), () => setError(translate("无法访问剪贴板。")))}>{translate("复制同步配置")}</button></Modal>}
      {editingCredentials && <Modal title={translate("更新网盘应用密码")} onClose={() => { if (!busy) { setEditingCredentials(false); setCredentialPassword(""); } }}><form onSubmit={e => { e.preventDefault(); void run(async () => { const next = await api.syncUpdateCredentials({ endpoint: credentialEndpoint, username: credentialUsername, password: credentialPassword }); setCredentialPassword(""); setEditingCredentials(false); setMessage(translate("网盘连接已更新，同步库和历史已保留。")); return next; }, true); }}><p className="dialog-intro">{translate("更新当前库的连接凭据，保留同步库编号、独立同步密码和历史。")}</p><label className="field-label" htmlFor="sync-update-endpoint">{translate("WebDAV 地址")}</label><input id="sync-update-endpoint" type="url" required value={credentialEndpoint} disabled={working} onChange={e => setCredentialEndpoint(e.target.value)}/><label className="field-label" htmlFor="sync-update-user">{translate("网盘账号")}</label><input id="sync-update-user" required value={credentialUsername} disabled={working} onChange={e => setCredentialUsername(e.target.value)}/><label className="field-label" htmlFor="sync-update-password">{translate("新的网盘应用密码")}</label><input id="sync-update-password" type="password" autoComplete="off" required value={credentialPassword} disabled={working} onChange={e => setCredentialPassword(e.target.value)}/>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button primary" disabled={working || !credentialPassword}>{translate("验证并更新连接")}</button></div></form></Modal>}
      {choosingLibrary && status?.configured && (
        <Modal
          title={translate("选择同步库并合并")}
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
                  ? translate("已在本机合并并切换同步库，云端上传尚未完成，请点击立即同步重试。")
                  : translate("已合并并切换同步库。请让其他设备也选择这个编号。"),
              );
            }}
          />
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm === "disconnect" ? translate("断开同步") : translate("切换 HOTP 主设备")}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          {confirm === "disconnect" ? (
            <p className="dialog-intro">{translate("本机令牌和云端同步库都会保留。本机将恢复独立使用，之后的修改不再同步。")}</p>
          ) : (
            <>
              <p className="dialog-intro">{translate("请先在旧设备停止使用此 HOTP 令牌，并让两台设备完成同步。离线旧设备无法被远程禁用，继续使用可能造成计数错乱。")}</p>
              <label className="field-label" htmlFor="sync-hotp">{translate("选择 HOTP 令牌")}</label>
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
                <span>{translate("旧设备已停止使用此 HOTP 令牌")}</span>
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
            >{translate("取消")}</button>
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
              {confirm === "disconnect" ? translate("确认断开") : translate("设为主设备")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
