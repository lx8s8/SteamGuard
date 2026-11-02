import { t as translate } from "./i18n";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { call, errorText } from "./api";
import { Modal } from "./Modal";
import type { TokenView } from "./types";
export function BatchQrExport({ tokens, onClose }: { tokens: TokenView[]; onClose: () => void }) {
  const compatible = tokens.filter(t => (t.kind === "totp" && t.period === 30 || t.kind === "hotp") && [6,8].includes(t.digits ?? 6));
  const [selected, setSelected] = useState(compatible.map(t => t.id));
  const [pages, setPages] = useState<string[]>([]), [index, setIndex] = useState(0), [image, setImage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let live = true; setImage(""); if (pages[index]) void QRCode.toDataURL(pages[index], { width:480, margin:4, errorCorrectionLevel:"M" }).then(value => { if (live) setImage(value); }).catch(() => setError(translate("无法生成迁移二维码"))); return () => { live = false; }; }, [pages,index]);
  return <Modal title={translate("迁移二维码")} onClose={onClose}>
    {pages.length ? <>
      <p className="form-hint">{translate("在另一台验证器中扫描全部二维码。二维码包含密钥。")}</p>
      {image && <div className="qr-login-panel"><img src={image} width={320} height={320} alt={translate("令牌迁移二维码")} /></div>}
      <div className="qr-page-controls"><button className="button secondary" disabled={!index} onClick={() => setIndex(index-1)}><ChevronLeft size={17} />{translate("上一张")}</button><span>{index+1} / {pages.length}</span><button className="button secondary" disabled={index+1>=pages.length} onClick={() => setIndex(index+1)}>{translate("下一张")}<ChevronRight size={17} /></button></div>
      <div className="modal-actions"><button className="button secondary" onClick={() => { setPages([]); setImage(""); }}>{translate("返回选择")}</button></div>
    </> : <>
      <p className="form-hint">{translate("选择要迁出的通用令牌。Steam 和非标准周期令牌请使用加密备份迁移。")}</p>
      <div className="export-token-selection">{compatible.map(t => <label className="checkbox-label" key={t.id}><input type="checkbox" checked={selected.includes(t.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids,t.id] : ids.filter(id => id!==t.id))} /><span>{t.name}</span></label>)}</div>
      {!compatible.length && <p>{translate("没有可迁出的兼容令牌")}</p>}
      <div className="modal-actions"><button className="button primary" disabled={busy || !selected.length} onClick={async () => { setBusy(true); setError(""); try { const result = await call<{pages:string[]}>("token_export_qr_batch",{ids:selected}); setPages(result.pages); setIndex(0); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>{translate("生成二维码")}</button></div>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}
