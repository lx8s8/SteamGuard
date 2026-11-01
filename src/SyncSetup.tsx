import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { SyncStatus } from "./types";

export function SyncSetup({
  current,
  tokenCount,
  onConnected,
  onCancel,
  onBusyChange,
}: {
  current?: SyncStatus;
  tokenCount: number;
  onConnected: (status: SyncStatus) => Promise<void>;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [preset, setPreset] = useState("jianguoyun");
  const [endpoint, setEndpoint] = useState("https://dav.jianguoyun.com/dav/");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [mode, setMode] = useState<"join" | "create">("join");
  const [libraries, setLibraries] = useState<string[] | null>(null);
  const [libraryId, setLibraryId] = useState("");
  const [manual, setManual] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  const resetDiscovery = () => {
    setLibraries(null);
    setLibraryId("");
    setConfirmNew(false);
    setError("");
  };
  const discover = async () => {
    setBusy(true);
    setError("");
    setLibraries(null);
    setLibraryId("");
    setConfirmNew(false);
    try {
      setLibraries(
        await api.syncDiscover(
          current ? undefined : { endpoint, username, password },
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const discoveringOnOpen = useRef(false);
  // A connected device reuses credentials kept in its encrypted local vault.
  useEffect(() => {
    if (current && !discoveringOnOpen.current) {
      discoveringOnOpen.current = true;
      void discover();
    }
    // Run once when the library chooser opens.
  }, []);
  const working = busy || committed;
  useEffect(() => {
    onBusyChange?.(working);
  }, [working, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const available = libraries?.filter((id) => id !== current?.libraryId) ?? [];
  return (
    <form
      className="sync-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const status = current
            ? await api.syncSwitch(libraryId.trim(), syncPassword)
            : await api.syncConnect({
                endpoint,
                username,
                password,
                syncPassword,
                mode,
                libraryId: mode === "join" ? libraryId.trim() : undefined,
                confirmNewLibrary: mode === "create" && confirmNew,
              });
          setPassword("");
          setSyncPassword("");
          setCommitted(true);
          await onConnected(status);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="access-note">
        {current
          ? `当前库：${current.libraryId}。选择要合并到的同步库。原云端库会保留，其他设备也需选择相同编号才能继续同步。`
          : "先查找网盘中的同步库。其他设备应加入同一个库；相同密码不会把两个独立库自动合并。"}
      </p>
      {!current && (
        <>
          <label className="field-label" htmlFor="sync-preset">
            网盘服务
          </label>
          <select
            id="sync-preset"
            value={preset}
            disabled={working}
            onChange={(e) => {
              setPreset(e.target.value);
              setEndpoint(
                e.target.value === "jianguoyun"
                  ? "https://dav.jianguoyun.com/dav/"
                  : "",
              );
              resetDiscovery();
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
            onChange={(e) => {
              setEndpoint(e.target.value);
              resetDiscovery();
            }}
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
            onChange={(e) => {
              setUsername(e.target.value);
              resetDiscovery();
            }}
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
            onChange={(e) => {
              setPassword(e.target.value);
              resetDiscovery();
            }}
          />
        </>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={
          working || (!current && (!endpoint || !username.trim() || !password))
        }
        onClick={() => void discover()}
      >
        {busy
          ? "正在处理…"
          : libraries === null
            ? "查找已有同步库"
            : "刷新同步库列表"}
      </button>
      {libraries !== null && (
        <div
          className="sync-library-list"
          role="region"
          aria-label="网盘同步库"
        >
          <p>
            {available.length
              ? `找到 ${available.length} 个${current ? "其他" : "已有"}同步库，请选择目标：`
              : current
                ? "未找到其他同步库。"
                : "尚未找到同步库，可以创建第一个库。"}
          </p>
          {available.map((id, index) => (
            <label className="sync-choice sync-library" key={id}>
              <input
                type="radio"
                name="sync-library-choice"
                checked={mode === "join" && !manual && libraryId === id}
                disabled={working}
                onChange={() => {
                  setMode("join");
                  setManual(false);
                  setLibraryId(id);
                }}
              />
              <span>
                同步库 {index + 1}
                <code>{id}</code>
                <small>对照另一台设备显示的编号选择</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {!current && (
        <>
          <label className="field-label" htmlFor="sync-mode">
            连接方式
          </label>
          <select
            id="sync-mode"
            disabled={working}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as "create" | "join");
              setConfirmNew(false);
            }}
          >
            <option value="join">加入已有同步库</option>
            <option value="create">创建独立同步库</option>
          </select>
        </>
      )}
      {mode === "join" && (
        <>
          <label className="sync-choice">
            <input
              type="checkbox"
              checked={manual}
              disabled={working}
              onChange={(e) => {
                setManual(e.target.checked);
                setLibraryId("");
              }}
            />
            <span>
              手动输入同步库编号
              <small>网盘不支持列目录时，可从另一台设备复制编号。</small>
            </span>
          </label>
          {manual && (
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
        </>
      )}
      {mode === "create" && (
        <>
          <p className="access-note">
            新库独立保存数据。要在手机和电脑间同步，请加入同一个已有库。
          </p>
          {libraries === null && (
            <p className="form-hint">
              请先查找已有同步库，确认网盘中是否已经有数据。
            </p>
          )}
          {!!libraries?.length && (
            <label className="sync-choice">
              <input
                type="checkbox"
                checked={confirmNew}
                disabled={working}
                onChange={(e) => setConfirmNew(e.target.checked)}
              />
              <span>我需要另外创建一个独立库，不与上面的库同步</span>
            </label>
          )}
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
        {mode === "create"
          ? "至少 12 个字符，用于加密云端令牌，与网盘应用密码区分。请妥善保管，无法找回。"
          : "填写所选库创建时设置的同步密码。本机保险库主密码可以不同。"}
      </p>
      <p className="access-note">
        {current ? "合并后切换到所选库。" : "连接后合并本机与所选库。"}本机现有{" "}
        {tokenCount}{" "}
        个令牌会保留；重复令牌自动匹配，同字段冲突需选择保留版本。Steam
        登录会话留在本机。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="sync-actions">
        {onCancel && (
          <button
            type="button"
            className="button secondary"
            disabled={working}
            onClick={onCancel}
          >
            返回
          </button>
        )}
        <button
          className="button primary"
          disabled={
            working ||
            (mode === "join"
              ? !libraryId.trim() ||
                libraryId.trim().toLowerCase() === current?.libraryId
              : libraries === null || (!!libraries.length && !confirmNew))
          }
        >
          {working
            ? "正在合并…"
            : current
              ? "合并并切换到所选库"
              : mode === "join"
                ? "加入并同步"
                : "创建并同步"}
        </button>
      </div>
    </form>
  );
}
