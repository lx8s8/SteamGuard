import { useState } from "react";
import { t as translate } from "./i18n";
import type { ImportPreview, ImportReplacement } from "./types";

export function ImportReplacementPicker({ preview, selected, onChange, busy }: {
  preview: ImportPreview;
  selected: ImportReplacement[];
  onChange: (next: ImportReplacement[]) => void;
  busy: boolean;
}) {
  const [sourceIndex, setSourceIndex] = useState("");
  const [targetId, setTargetId] = useState("");
  const sources = preview.replacementSources ?? [];
  const targets = preview.replacementTargets ?? [];
  const source = sources.find(row => String(row.index) === sourceIndex);
  const keyOwner = targets.find(row => row.id === source?.existingId);
  const targetOptions = targets.filter(row => row.kind === source?.kind && !selected.some(choice => choice.targetId === row.id));
  const label = ({ name, issuer, group }: { name: string; issuer: string; group?: string | null }) =>
    [name, issuer && issuer !== name ? issuer : null, group].filter(Boolean).join(" · ");

  return <section className="import-replacement" aria-label={translate("替换旧令牌")}>
    <p className="form-hint">{translate("仅保存所选替换。保留旧令牌的名称、分组、头像、备注和恢复码。")}</p>
    <label className="field-label" htmlFor="replacement-source">{translate("导入来源令牌")}</label>
    <select id="replacement-source" disabled={busy} value={sourceIndex} onChange={event => {
      setSourceIndex(event.target.value);
      setTargetId("");
    }}>
      <option value="">{translate("请选择")}</option>
      {sources.filter(row => !selected.some(choice => choice.sourceIndex === row.index)).map(row =>
        <option key={row.index} value={row.index}>{label(row)}</option>)}
    </select>
    <label className="field-label" htmlFor="replacement-target">{translate("要替换的现有令牌")}</label>
    <select id="replacement-target" value={targetId} disabled={busy || !source} onChange={event => setTargetId(event.target.value)}>
      <option value="">{translate("请选择")}</option>
      {targetOptions.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}
    </select>
    {keyOwner && targetId && keyOwner.id !== targetId && <p className="form-hint">
      {translate("此密钥已保存在「{{name}}」。替换时会将这条重复记录移入本机回收站。", { name: keyOwner.name })}
    </p>}
    <button type="button" className="button secondary" disabled={busy || !source || !targetOptions.some(row => row.id === targetId)} onClick={() => {
      if (!source) return;
      onChange([...selected, { sourceIndex: source.index, targetId }]);
      setSourceIndex("");
      setTargetId("");
    }}>{translate("加入替换列表")}</button>
    {selected.length > 0 && <ul className="replacement-list">
      {selected.map(choice => {
        const from = sources.find(row => row.index === choice.sourceIndex);
        const to = targets.find(row => row.id === choice.targetId);
        return from && to && <li key={choice.targetId}>
          <span>{translate("用「{{source}}」替换「{{target}}」", { source: label(from), target: label(to) })}</span>
          <button className="button secondary" disabled={busy} onClick={() => onChange(selected.filter(row => row.targetId !== choice.targetId))}>{translate("移除")}</button>
        </li>;
      })}
    </ul>}
  </section>;
}
