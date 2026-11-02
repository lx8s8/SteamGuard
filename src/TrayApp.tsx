import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  LockKeyhole,
  Search,
  X,
} from "lucide-react";
import { api, errorText } from "./api";
import { TokenAvatar } from "./TokenAvatar";
import type { DesktopSnapshot } from "./types";
export default function TrayApp() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.desktopSnapshot());
    } catch (error) {
      setSnapshot(null);
      setError(errorText(error));
    }
  }, []);
  const action = async (job: () => Promise<unknown>) => {
    try {
      setError("");
      await job();
      await refresh();
    } catch (error) {
      setError(errorText(error));
    }
  };
  useEffect(() => {
    let focused = document.hasFocus();
    if (focused) void refresh();
    const timer = setInterval(() => {
      if (focused && !document.hidden) void refresh();
    }, 1000);
    const focus = () => {
      focused = true;
      setSearch("");
      setCopied("");
      void refresh();
    };
    const blur = () => {
      focused = false;
      setSnapshot(null);
      setCopied("");
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") void api.desktopHide();
    };
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key);
    };
  }, [refresh]);
  const available = snapshot && (!snapshot.locked || snapshot.preview);
  return (
    <main className="tray-panel">
      <header>
        <strong>SteamGuard</strong>
        <div>
          {snapshot && !snapshot.locked && (
            <button
              className="icon-button"
              aria-label="锁定"
              onClick={() => void action(api.lock)}
            >
              <LockKeyhole size={16} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="打开应用"
            onClick={() => void action(api.desktopOpen)}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="关闭"
            onClick={() => void action(api.desktopHide)}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      {available ? (
        <>
          {snapshot.tokens.length > 4 && (
            <label className="tray-search">
              <Search size={15} />
              <input
                aria-label="搜索令牌"
                placeholder="搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          <div className="tray-list">
            {snapshot.tokens
              .filter((token) =>
                `${token.name} ${token.issuer}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((token) => (
                <button
                  key={token.id}
                  className={`tray-token ${copied === token.id ? "copied" : ""}`}
                  disabled={token.hotpReadOnly || !token.code}
                  aria-label={`复制 ${token.name} 验证码`}
                  onClick={() =>
                    void action(async () => {
                      await api.desktopCopy(token.id);
                      setCopied(token.id);
                      setTimeout(() => setCopied(""), 1800);
                    })
                  }
                >
                  <TokenAvatar token={token} />
                  <span className="tray-identity">
                    <strong>{token.name}</strong>
                    <span>{token.hotpReadOnly ? "仅主设备" : token.code}</span>
                  </span>
                  {copied === token.id ? (
                    <Check size={17} />
                  ) : (
                    <Copy size={15} />
                  )}
                  {token.kind !== "hotp" && (
                    <span
                      className="tray-progress"
                      style={{
                        width: `${Math.max(0, Math.min(100, (token.remaining / token.period) * 100))}%`,
                      }}
                    />
                  )}
                </button>
              ))}
            {!snapshot.tokens.length && (
              <div className="tray-empty">暂无令牌</div>
            )}
          </div>
        </>
      ) : (
        <div className="tray-empty">
          <button
            className="button primary"
            onClick={() => void action(api.desktopOpen)}
          >
            {snapshot?.initialized ? "解锁" : "打开应用"}
          </button>
          {snapshot?.previewEnabled && (
            <button
              className="text-button"
              onClick={() => void action(api.previewEnter)}
            >
              预览令牌
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
