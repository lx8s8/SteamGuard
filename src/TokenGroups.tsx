import { t as translate } from "./i18n";
import { useState } from "react";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { api, errorText } from "./api";
import { Modal } from "./Modal";

export function TokenGroups({
  groups,
  onChange,
  onClose,
}: {
  groups: string[];
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (
    action: "create" | "rename" | "delete",
    old?: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await api.manageGroup(
        action,
        old ?? name.trim(),
        action === "rename" ? name.trim() : undefined,
      );
      setName("");
      setEditing(null);
      setRemoving(null);
      await onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={translate("管理分组")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-intro">{translate("按用途整理 Steam 和其他令牌。删除分组会将其中的令牌移到「未分组」。")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(editing ? "rename" : "create", editing ?? undefined);
        }}
      >
        <label className="field-label" htmlFor="group-name">
          {editing ? translate("重命名「{{editing}}」", { editing: editing }) : translate("新建分组")}
        </label>
        <div className="group-create">
          <input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            placeholder={translate("例如：邮箱、工作、游戏")}
            disabled={busy}
          />
          <button className="button primary" disabled={busy || !name.trim()}>
            <FolderPlus size={17} />
            {editing ? translate("保存") : translate("创建")}
          </button>
        </div>
        {editing && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setName("");
            }}
          >{translate("取消重命名")}</button>
        )}
      </form>
      <div className="group-list">
        {groups.length ? (
          groups.map((group) => (
            <div className="group-item" key={group}>
              <strong>{group}</strong>
              <button
                className="icon-button"
                aria-label={translate("重命名分组 {{group}}", { group: group })}
                disabled={busy}
                onClick={() => {
                  setEditing(group);
                  setName(group);
                  setRemoving(null);
                }}
              >
                <Pencil size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={translate("删除分组 {{group}}", { group: group })}
                disabled={busy}
                onClick={() => setRemoving(group)}
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))
        ) : (
          <p className="form-hint">{translate("还没有自定义分组，先创建一个。")}</p>
        )}
      </div>
      {removing && (
        <div className="group-delete-review">
          <p>{translate("删除「{{removing}}」？其中的令牌会保留并移到未分组。", { removing: removing })}</p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >{translate("取消")}</button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void submit("delete", removing)}
            >{translate("确认删除分组")}</button>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
