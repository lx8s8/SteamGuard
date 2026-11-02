import { useEffect, useState } from "react";
import { call, errorText } from "./api";
import { t as translate } from "./i18n";
import type { TokenView } from "./types";
type EntryStatus = {supported:boolean; sharedAvailable:boolean; enabled:boolean; selectedIds:string[]};
export function SystemEntrySettings({tokens}:{tokens:TokenView[]}) {
 const [status,setStatus]=useState<EntryStatus|null>(null),[ids,setIds]=useState<string[]>([]),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const apply=(value:EntryStatus)=>{setStatus(value);setIds(value.selectedIds);setEnabled(value.enabled);};
 useEffect(()=>{let live=true;void call<EntryStatus>("system_entries_status").then(value=>{if(live)apply(value);}).catch(()=>{});return()=>{live=false;};},[]);
 if(!status?.supported)return null;
 const save=async()=>{setBusy(true);setError("");try{apply(await call<EntryStatus>("system_entries_configure",{enabled,selectedIds:ids.filter(id=>tokens.some(t=>t.id===id))}));}catch(e){setError(errorText(e));}finally{setBusy(false);}};
 return <section className="settings-panel">
  <div className="panel-title"><h2>{translate("手机快捷入口")}</h2></div>
  <label className="checkbox-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>{translate("在系统快捷入口显示所选令牌")}</label>
  {enabled&&<>
   <p className="form-hint">{translate("仅显示所选令牌名称。点击后打开应用，解锁后手动复制验证码。")}</p>
   <div className="token-selection-list">{tokens.map(token=><label key={token.id} className="checkbox-row"><input type="checkbox" checked={ids.includes(token.id)} disabled={busy||(!ids.includes(token.id)&&ids.length>=4)} onChange={e=>setIds(previous=>e.target.checked?[...previous,token.id]:previous.filter(id=>id!==token.id))}/><span>{token.name}</span></label>)}</div>
   <p className="form-hint">{translate("最多选择 4 个快捷令牌")}</p>
   {!status.sharedAvailable&&<p className="form-hint">{translate("iOS 小组件的令牌列表需要共享应用组授权；未配置时仍可打开应用。")}</p>}
  </>}
  <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>void save()}>{translate("保存")}</button></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
