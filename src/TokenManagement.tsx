import { t as translate, formatDateTime } from "./i18n";
import { useEffect, useState } from "react";
import { Check, KeyRound, Trash2 } from "lucide-react";
import { api, errorText } from "./api";
import { Modal } from "./Modal";
import type { TokenParameters, TrashEntry } from "./types";

export function OtpParameters({ kind, value, onChange, disabled = false, counterReadOnly = false }: { kind: "totp" | "hotp"; value: TokenParameters; onChange: (value: TokenParameters) => void; disabled?: boolean; counterReadOnly?: boolean }) {
  const update = (next: TokenParameters) => onChange({ ...value, ...next });
  return <details className="token-details"><summary>{translate("高级参数")}</summary><div className="otp-parameters">
    <label>{translate("算法")}<select aria-label={translate("算法")} disabled={disabled} value={value.algorithm ?? "SHA1"} onChange={e => update({ algorithm: e.target.value })}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
    <label>{translate("验证码位数")}<select aria-label={translate("验证码位数")} disabled={disabled} value={value.digits ?? 6} onChange={e => update({ digits: Number(e.target.value) })}>{[6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    {kind === "totp" ? <label>{translate("周期（秒）")}<input aria-label={translate("周期（秒）")} type="number" min={1} max={3600} required disabled={disabled} value={value.period ?? 30} onChange={e => update({ period: Number(e.target.value) })} /></label> : <label>{translate("计数器")}<input aria-label={translate("计数器")} type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} required disabled={disabled || counterReadOnly} value={value.counter ?? 0} onChange={e => update({ counter: Number(e.target.value) })} /><small>{counterReadOnly ? translate("仅主设备") : translate("保存时不会降低已有计数，避免重复使用验证码。")}</small></label>}
  </div></details>;
}

export function ManualTokenForm({ groups, onComplete }: { groups: string[]; onComplete: () => Promise<void> }) {
  const [issuer, setIssuer] = useState("");
  const [account, setAccount] = useState("");
  const [secret, setSecret] = useState("");
  const [kind, setKind] = useState<"totp" | "hotp">("totp");
  const [group, setGroup] = useState("");
  const [parameters, setParameters] = useState<TokenParameters>({ algorithm: "SHA1", digits: 6, period: 30, counter: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="manual-token-form" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    try { await api.createToken({ name: account.trim(), issuer: issuer.trim(), secret: secret.replace(/\s/g, "").toUpperCase(), kind, group: group || undefined, ...parameters, counter: kind === "hotp" ? parameters.counter : undefined, period: kind === "totp" ? parameters.period : undefined }); setSecret(""); await onComplete(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }}>
    <label className="field-label" htmlFor="manual-service">{translate("服务名称")}</label><input id="manual-service" maxLength={120} placeholder={translate("例如 GitHub")} value={issuer} disabled={busy} onChange={e => setIssuer(e.target.value)} />
    <label className="field-label" htmlFor="manual-account">{translate("账户或显示名称")}</label><input id="manual-account" required maxLength={120} autoComplete="off" value={account} disabled={busy} onChange={e => setAccount(e.target.value)} />
    <label className="field-label" htmlFor="manual-secret">{translate("密钥（Base32）")}</label><input id="manual-secret" type="password" required autoComplete="off" spellCheck={false} autoCapitalize="characters" value={secret} disabled={busy} onChange={e => setSecret(e.target.value)} /><p className="form-hint">{translate("填写服务提供的设置密钥，空格会自动忽略。")}</p>
    <label className="field-label" htmlFor="manual-kind">{translate("令牌类型")}</label><select id="manual-kind" disabled={busy} value={kind} onChange={e => setKind(e.target.value as "totp" | "hotp")}><option value="totp">{translate("TOTP · 基于时间")}</option><option value="hotp">{translate("HOTP · 基于计数")}</option></select>
    {!!groups.length && <><label className="field-label" htmlFor="manual-group">{translate("分组")}</label><select id="manual-group" value={group} disabled={busy} onChange={e => setGroup(e.target.value)}><option value="">{translate("未分组")}</option>{groups.map(g => <option key={g}>{g}</option>)}</select></>}
    <OtpParameters kind={kind} value={parameters} onChange={setParameters} disabled={busy} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button primary" disabled={busy || !account.trim() || !secret.trim()}><KeyRound size={16}/>{busy ? translate("正在添加…") : translate("保存令牌")}</button></div>
  </form>;
}

export function TrashBrowser({ onClose, onChange }: { onClose: () => void; onChange: () => Promise<void> }) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => setEntries(await api.trash());
  useEffect(() => { void load().catch(e => setError(errorText(e))).finally(() => setLoading(false)); }, []);
  const act = async (permanent: boolean) => {
    setBusy(true); setError("");
    try { if (permanent) await api.trashDelete(selected); else await api.trashRestore(selected); setSelected([]); setConfirmDelete(false); await load(); await onChange(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal title={confirmDelete ? translate("永久删除所选令牌？") : translate("本机回收站")} onClose={() => { if (!busy) onClose(); }}>
    {confirmDelete ? <p className="dialog-intro">{translate("将永久删除所选 {{length}} 个令牌。此操作无法撤销，其他设备和导出的备份仍可能保留副本。", { length: selected.length })}</p> : <>
      <p className="dialog-intro">{translate("已删除令牌只保留在这台设备，可还原到保险库。Steam 登录会话需要重新建立。")}</p>
      {loading ? <p>{translate("正在读取…")}</p> : entries.length ? <div className="selection-list" role="group" aria-label={translate("回收站令牌")}>{entries.map(t => <label key={t.id}><input type="checkbox" checked={selected.includes(t.id)} disabled={busy} onChange={e => setSelected(e.target.checked ? [...selected, t.id] : selected.filter(id => id !== t.id))}/><span><strong>{t.name}</strong><small>{t.issuer || t.kind.toUpperCase()} · {formatDateTime(t.deletedAt * 1000)}</small></span></label>)}</div> : <p className="form-hint">{translate("回收站为空。")}</p>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions">{confirmDelete ? <><button className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>{translate("返回")}</button><button className="button danger" disabled={busy} onClick={() => void act(true)}>{translate("永久删除")}</button></> : <><button className="button text danger-text" disabled={busy || !selected.length} onClick={() => setConfirmDelete(true)}><Trash2 size={15}/>{translate("永久删除")}</button><button className="button primary" disabled={busy || !selected.length} onClick={() => void act(false)}><Check size={15}/>{translate("还原所选令牌")}</button></>}</div>
  </Modal>;
}

export function PasswordSettings({ onChange }: { onChange: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const close = () => { if (!busy) { setOpen(false); setCurrent(""); setPassword(""); setConfirmation(""); setError(""); } };
  return <section className="settings-panel"><div className="panel-title"><h2>{translate("保险库主密码")}</h2></div><div className="setting-row"><div><h3>{translate("修改主密码")}</h3><p>{translate("重新加密本机保险库。历史备份仍使用生成时的密码。")}</p></div><button className="button secondary" onClick={() => setOpen(true)}>{translate("修改")}</button></div>{message && <p role="status" className="backup-message">{message}</p>}{open && <Modal title={translate("修改保险库主密码")} onClose={close}><form onSubmit={async e => { e.preventDefault(); if (password !== confirmation) { setError(translate("两次输入的新密码不一致。")); return; } setBusy(true); setError(""); try { await api.changePassword(current, password); setOpen(false); setCurrent(""); setPassword(""); setConfirmation(""); setMessage(translate("主密码已修改。请重新启用需要的快捷访问方式，旧备份仍使用原密码。")); await onChange(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }}>
    <label className="field-label" htmlFor="password-current">{translate("当前主密码")}</label><input id="password-current" type="password" autoComplete="current-password" required disabled={busy} value={current} onChange={e => setCurrent(e.target.value)}/>
    <label className="field-label" htmlFor="password-new">{translate("新主密码")}</label><input id="password-new" type="password" autoComplete="new-password" required minLength={8} maxLength={4096} disabled={busy} value={password} onChange={e => setPassword(e.target.value)}/>
    <label className="field-label" htmlFor="password-confirm">{translate("再次输入新主密码")}</label><input id="password-confirm" type="password" autoComplete="new-password" required disabled={busy} value={confirmation} onChange={e => setConfirmation(e.target.value)}/>
    <p className="form-hint">{translate("至少 8 个字符。免密码预览和设备认证解锁会被重置。")}</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>{translate("取消")}</button><button className="button primary" disabled={busy || !current || password.length < 8 || !confirmation}>{translate("保存新密码")}</button></div>
  </form></Modal>}</section>;
}
