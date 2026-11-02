import { t as translate, formatDateTime } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { api, errorText } from "./api";
import { Modal } from "./Modal";
import type { RecoveryCodeInput, TokenPrivateDetails, TokenParameters, TrashEntry } from "./types";
import "./token-private.css";

export function OtpParameters({ kind, value, onChange, disabled = false, counterReadOnly = false }: { kind: "totp" | "hotp"; value: TokenParameters; onChange: (value: TokenParameters) => void; disabled?: boolean; counterReadOnly?: boolean }) {
  const update = (next: TokenParameters) => onChange({ ...value, ...next });
  return <details className="token-details"><summary>{translate("高级参数")}</summary><div className="otp-parameters">
    <label>{translate("算法")}<select aria-label={translate("算法")} disabled={disabled} value={value.algorithm ?? "SHA1"} onChange={e => update({ algorithm: e.target.value })}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
    <label>{translate("验证码位数")}<select aria-label={translate("验证码位数")} disabled={disabled} value={value.digits ?? 6} onChange={e => update({ digits: Number(e.target.value) })}>{[4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    {kind === "totp" ? <label>{translate("周期（秒）")}<input aria-label={translate("周期（秒）")} type="number" min={1} max={86400} required disabled={disabled} value={value.period ?? 30} onChange={e => update({ period: Number(e.target.value) })} /></label> : <label>{translate("计数器")}<input aria-label={translate("计数器")} type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} required disabled={disabled || counterReadOnly} value={value.counter ?? 0} onChange={e => update({ counter: Number(e.target.value) })} /><small>{counterReadOnly ? translate("仅主设备") : translate("保存时不会降低已有计数，避免重复使用验证码。")}</small></label>}
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

export function TokenPrivateDetailsEditor({ id, disabled = false, onChanged }: { id: string; disabled?: boolean; onChanged?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<TokenPrivateDetails | null>(null);
  const [notes, setNotes] = useState("");
  const [codes, setCodes] = useState<RecoveryCodeInput[]>([]);
  const [added, setAdded] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const apply = (next: TokenPrivateDetails) => { setDetails(next); setNotes(next.notes); setCodes(next.recoveryCodes.map(({id,code,used}) => ({id,code,used}))); setAdded(""); };
  useEffect(() => {
    const request = ++generation.current;
    setDetails(null); setNotes(""); setCodes([]); setAdded(""); setRevealed(false); setError(""); setMessage("");
    if (open) {
      setBusy(true);
      void api.tokenPrivateDetails(id).then(next => { if (request === generation.current) apply(next); })
        .catch(e => { if (request === generation.current) setError(errorText(e)); })
        .finally(() => { if (request === generation.current) setBusy(false); });
    } else setBusy(false);
    return () => { ++generation.current; };
  }, [id, open]);
  const act = async (job: () => Promise<TokenPrivateDetails | void>, success?: string) => {
    const request = generation.current;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await job();
      if (request !== generation.current) return;
      if (next) apply(next);
      if (success) setMessage(success);
      if (next) await onChanged?.();
    } catch (e) { if (request === generation.current) setError(errorText(e)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const dirty = !!details && (notes !== details.notes || added.trim() !== "" || codes.length !== details.recoveryCodes.length || codes.some((item, index) => { const saved = details.recoveryCodes[index]; return !saved || item.id !== saved.id || item.code !== saved.code || item.used !== saved.used; }));
  return <details className="token-details token-private-details" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{translate("备注与备用恢复码")}</summary>
    {open && <div className="private-details-content">
      {details && <>
        <label className="field-label" htmlFor="token-private-notes">{translate("备注")}</label>
        <textarea id="token-private-notes" rows={3} maxLength={4096} autoComplete="off" spellCheck={false} disabled={disabled || busy} value={notes} onChange={e => setNotes(e.target.value)}/>
        <div className="panel-title"><h3>{translate("备用恢复码")}</h3><button type="button" className="button text" disabled={disabled || busy} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={15}/> : <Eye size={15}/>}{revealed ? translate("隐藏恢复码") : translate("显示恢复码")}</button></div>
        {codes.length ? <div className="recovery-code-list">{codes.map((item,index) => <div className="recovery-code-row" key={item.id ?? `draft-${index}`}>
          <input type={revealed ? "text" : "password"} className="recovery-code-value" aria-label={translate("备用恢复码 {{number}}", {number:index+1})} value={item.code} readOnly autoComplete="off" spellCheck={false} />
          <label className="sync-choice"><input type="checkbox" aria-label={translate("恢复码 {{number}} 已使用", {number:index+1})} checked={item.used} disabled={disabled || busy || dirty} onChange={e => { if (details && item.id) void act(() => api.tokenRecoveryMark(id,item.id!,e.target.checked,details.revision)); }}/><span>{translate("已使用")}</span></label>
          <button type="button" className="button text" aria-label={translate("复制恢复码 {{number}}", {number:index+1})} disabled={disabled || busy || item.used || !item.id || dirty} onClick={() => void act(() => api.tokenRecoveryCopy(id,item.id!),translate("恢复码已复制"))}><Copy size={15}/></button>
          <button type="button" className="button text danger-text" aria-label={translate("删除恢复码 {{number}}", {number:index+1})} disabled={disabled || busy} onClick={() => setCodes(current => current.filter((_,i) => i !== index))}><Trash2 size={15}/></button>
        </div>)}</div> : <p className="form-hint">{translate("尚未保存备用恢复码")}</p>}
        <label className="field-label" htmlFor="token-recovery-add">{translate("添加恢复码，每行一个")}</label>
        <textarea id="token-recovery-add" rows={3} maxLength={25700} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled || busy} value={added} onChange={e => setAdded(e.target.value)}/>
        <div className="modal-actions"><button type="button" className="button secondary" disabled={disabled || busy || !dirty} onClick={() => void act(() => api.tokenPrivateUpdate(id,details.revision,notes,[...codes,...added.split(/\r?\n/).map(code => code.trim()).filter(Boolean).map(code => ({code,used:false}))]),translate("备注与恢复码已保存"))}>{translate("保存备注与恢复码")}</button></div>
      </>}
      {busy && <p role="status">{translate("正在处理…")}</p>}
      {message && <p role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>}
  </details>;
}
