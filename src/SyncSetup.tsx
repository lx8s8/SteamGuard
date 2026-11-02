import { t as translate } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { QrScanner } from "./SteamQrScanner";
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
  const [configText, setConfigText] = useState("");
  const applyConfig = (text: string) => {
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      if (config.version !== 1 || typeof config.endpoint !== "string" || typeof config.username !== "string" || typeof config.libraryId !== "string") throw new Error(translate("请选择 SteamGuard 同步配置二维码。"));
      const url = new URL(config.endpoint);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !config.libraryId.trim()) throw new Error(translate("同步配置中的地址或库编号无效。"));
      if ("password" in config || "syncPassword" in config || "secret" in config) throw new Error(translate("配置包含密码，请使用另一台设备生成的无密码配置二维码。"));
      setEndpoint(config.endpoint); setUsername(config.username); setPreset("custom"); setMode("join"); setManual(true); setLibraryId(config.libraryId); setLibraries(null); setConfirmNew(false); setConfigText(""); setError("");
    } catch (e) { setError(e instanceof SyntaxError ? translate("无法读取同步配置，请扫描另一台设备显示的配置二维码。") : errorText(e)); }
  };
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
          ? translate("当前库：{{libraryId}}。选择要合并到的同步库。原云端库会保留，其他设备也需选择相同编号才能继续同步。", { libraryId: current.libraryId })
          : translate("先查找网盘中的同步库。其他设备应加入同一个库；相同密码不会把两个独立库自动合并。")}
      </p>
      {!current && (
        <>
          <details className="token-details sync-config-import"><summary>{translate("从另一台设备的配置二维码加入")}</summary>
            <p className="form-hint">{translate("读取地址、账号和同步库编号后，仍需自行填写网盘应用密码和独立同步密码。")}</p>
            <QrScanner onScan={applyConfig} title={translate("扫描同步配置")} buttonLabel={translate("扫描 / 读取配置二维码")} />
            <label className="field-label" htmlFor="sync-config-text">{translate("或粘贴同步配置")}</label><textarea id="sync-config-text" rows={3} value={configText} disabled={working} onChange={e => setConfigText(e.target.value)}/><button type="button" className="button secondary" disabled={working || !configText.trim()} onClick={() => applyConfig(configText)}>{translate("读取配置")}</button>
          </details>
          <label className="field-label" htmlFor="sync-preset">{translate("网盘服务")}</label>
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
            <option value="jianguoyun">{translate("坚果云")}</option>
            <option value="custom">{translate("其他 WebDAV")}</option>
          </select>
          <label className="field-label" htmlFor="sync-endpoint">{translate("WebDAV 地址")}</label>
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
          <label className="field-label" htmlFor="sync-user">{translate("网盘账号")}</label>
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
          <label className="field-label" htmlFor="sync-dav-password">{translate("网盘应用密码")}</label>
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
          ? translate("正在处理…")
          : libraries === null
            ? translate("查找已有同步库")
            : translate("刷新同步库列表")}
      </button>
      {libraries !== null && (
        <div
          className="sync-library-list"
          role="region"
          aria-label={translate("网盘同步库")}
        >
          <p>
            {available.length
              ? translate("找到 {{length}} 个{{value2}}同步库，请选择目标：", { length: available.length, value2: current ? translate("其他") : translate("已有") })
              : current
                ? translate("未找到其他同步库。")
                : translate("尚未找到同步库，可以创建第一个库。")}
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
              <span>{translate("同步库")}{index + 1}
                <code>{id}</code>
                <small>{translate("对照另一台设备显示的编号选择")}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {!current && (
        <>
          <label className="field-label" htmlFor="sync-mode">{translate("连接方式")}</label>
          <select
            id="sync-mode"
            disabled={working}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as "create" | "join");
              setConfirmNew(false);
            }}
          >
            <option value="join">{translate("加入已有同步库")}</option>
            <option value="create">{translate("创建独立同步库")}</option>
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
            <span>{translate("手动输入同步库编号")}<small>{translate("网盘不支持列目录时，可从另一台设备复制编号。")}</small>
            </span>
          </label>
          {manual && (
            <>
              <label className="field-label" htmlFor="sync-library">{translate("同步库编号")}</label>
              <input
                id="sync-library"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={working}
                placeholder={translate("另一台设备显示的编号")}
                value={libraryId}
                onChange={(e) => setLibraryId(e.target.value)}
              />
            </>
          )}
        </>
      )}
      {mode === "create" && (
        <>
          <p className="access-note">{translate("新库独立保存数据。要在手机和电脑间同步，请加入同一个已有库。")}</p>
          {libraries === null && (
            <p className="form-hint">{translate("请先查找已有同步库，确认网盘中是否已经有数据。")}</p>
          )}
          {!!libraries?.length && (
            <label className="sync-choice">
              <input
                type="checkbox"
                checked={confirmNew}
                disabled={working}
                onChange={(e) => setConfirmNew(e.target.checked)}
              />
              <span>{translate("我需要另外创建一个独立库，不与上面的库同步")}</span>
            </label>
          )}
        </>
      )}
      <label className="field-label" htmlFor="sync-password">{translate("独立同步密码")}</label>
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
          ? translate("至少 12 个字符，用于加密云端令牌，与网盘应用密码区分。请妥善保管，无法找回。")
          : translate("填写所选库创建时设置的同步密码。本机保险库主密码可以不同。")}
      </p>
      <p className="access-note">{translate("{{value1}}本机现有 {{tokenCount}} 个令牌会保留；重复令牌自动匹配，同字段冲突需选择保留版本。Steam 登录会话留在本机。", { value1: current ? translate("合并后切换到所选库。") : translate("连接后合并本机与所选库。"), tokenCount: tokenCount })}</p>
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
          >{translate("返回")}</button>
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
            ? translate("正在合并…")
            : current
              ? translate("合并并切换到所选库")
              : mode === "join"
                ? translate("加入并同步")
                : translate("创建并同步")}
        </button>
      </div>
    </form>
  );
}
