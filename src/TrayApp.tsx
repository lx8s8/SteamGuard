import { t as translate } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const epoch = useRef(0);
  const revision = useRef<string | null>(null);
  const loading = useRef<number | null>(null);
  const live = useCallback((value: number) => active.current && value === epoch.current && !document.hidden, []);
  const clearSensitive = useCallback(() => {
    epoch.current += 1;
    revision.current = null;
    setSnapshot(null); setCopied("");
  }, []);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    if (!live(current) || loading.current === current) return;
    loading.current = current;
    try {
      const next = await api.desktopSnapshot();
      if (!live(current)) return;
      revision.current = next.revision;
      setSnapshot(next);
    } catch (error) {
      if (!live(current)) return;
      revision.current = null;
      setSnapshot(null);
      setError(errorText(error));
    } finally { if (loading.current === current) loading.current = null; }
  }, [live]);
  const action = async (job: () => Promise<unknown>, reload = true) => {
    const current = epoch.current;
    try {
      setError("");
      await job();
      if (reload && live(current)) await refresh();
    } catch (error) {
      if (live(current)) setError(errorText(error));
    }
  };
  const hide = useCallback(async (openMain = false) => {
    active.current = false;
    clearSensitive();
    try { await (openMain ? api.desktopOpen() : api.desktopHide()); }
    catch (error) { setError(errorText(error)); }
  }, [clearSensitive]);
  useEffect(() => {
    let polling = false;
    const poll = async () => {
      const current = epoch.current;
      if (!live(current) || polling || loading.current === current) return;
      if (revision.current === null) { await refresh(); return; }
      polling = true;
      try {
        const next = await api.desktopCodes();
        if (!live(current)) return;
        if (next.revision !== revision.current) { await refresh(); return; }
        const codes = new Map(next.codes.map(code => [code.id, code]));
        setSnapshot(previous => previous ? { ...previous, tokens: previous.tokens.map(token => {
          const code = codes.get(token.id);
          return code ? { ...token, code: code.code, remaining: code.remaining, period: code.period } : token;
        }) } : null);
      } catch { if (live(current)) await refresh(); }
      finally { polling = false; }
    };
    const focus = () => {
      active.current = true;
      clearSensitive();
      setSearch(""); setSelected(0); setError("");
      void refresh();
    };
    const blur = () => { active.current = false; clearSensitive(); };
    const visibility = () => { if (document.hidden) blur(); else if (document.hasFocus()) focus(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); void hide(); }
    };
    if (document.hasFocus()) focus();
    const timer = setInterval(() => void poll(), 1000);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active.current = false; epoch.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh, live, clearSensitive, hide]);
  const available = snapshot && (!snapshot.locked || snapshot.preview);
  const tokens = snapshot?.tokens.filter(token => `${token.name} ${token.issuer}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) || [];
  const copy = (id: string) => {
    const current = epoch.current;
    if (!live(current)) return;
    return action(async () => {
      await api.desktopCopy(id);
      if (!live(current)) return;
      setCopied(id);
      setTimeout(() => { if (live(current)) setCopied(""); }, 1800);
    }, false);
  };
  const navigate = (event: React.KeyboardEvent) => {
    if (!available || event.altKey || event.ctrlKey || event.metaKey) return;
    const enabled = tokens.map((token, index) => ({ token, index })).filter(({token}) => !token.hotpReadOnly && token.code);
    if (!enabled.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = enabled.findIndex(({index}) => index === selected);
      const index = event.target instanceof HTMLInputElement ? (event.key === "ArrowDown" ? 0 : enabled.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      setSelected(enabled[index].index);
      document.getElementById(`tray-token-${enabled[index].token.id}`)?.focus();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault(); const token = enabled.find(({index}) => index === selected)?.token || enabled[0].token; void copy(token.id);
    }
  };
  return (
    <main className="tray-panel" onKeyDown={navigate}>
      <header>
        <strong>SteamGuard</strong>
        <div>
          {snapshot && !snapshot.locked && (
            <button
              className="icon-button"
              aria-label={translate("锁定")}
              onClick={() => { clearSensitive(); void action(api.lock); }}
            >
              <LockKeyhole size={16} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={translate("打开应用")}
            onClick={() => void hide(true)}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={translate("关闭")}
            onClick={() => void hide()}
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
                aria-label={translate("搜索令牌")}
                placeholder={translate("搜索")}
                value={search}
                onChange={(event) => { setSearch(event.target.value); setSelected(0); }}
              />
            </label>
          )}
          <div className="tray-list">
            {tokens.map((token, index) => (
                <button
                  key={token.id}
                  id={`tray-token-${token.id}`}
                  onFocus={() => setSelected(index)}
                  className={`tray-token ${copied === token.id ? "copied" : ""} ${selected === index ? "selected" : ""}`}
                  disabled={token.hotpReadOnly || !token.code}
                  aria-label={translate("复制 {{name}} 验证码", { name: token.name })}
                  onClick={() => void copy(token.id)}
                >
                  <TokenAvatar token={token} />
                  <span className="tray-identity">
                    <strong>{token.name}</strong>
                    <span>{token.hotpReadOnly ? translate("仅主设备") : token.code}</span>
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
            {!tokens.length && (
              <div className="tray-empty">{search ? translate("未找到令牌") : translate("暂无令牌")}</div>
            )}
          </div>
        </>
      ) : (
        <div className="tray-empty">
          <button
            className="button primary"
            onClick={() => void hide(true)}
          >
            {snapshot?.initialized ? translate("解锁") : translate("打开应用")}
          </button>
          {snapshot?.previewEnabled && (
            <button
              className="text-button"
              onClick={() => void action(api.previewEnter)}
            >{translate("预览令牌")}</button>
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
