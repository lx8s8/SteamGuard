import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  Ellipsis,
  FileKey2,
  FolderOpen,
  Fingerprint,
  Globe2,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { TokenAvatar, IconPicker } from "./TokenAvatar";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { DesktopSettings } from "./DesktopSettings";
import { QrImportPanel } from "./QrImportPanel";
import { api, errorText, native } from "./api";
import { SyncPanel, useSyncWatcher } from "./SyncPanel";
import { BackupPanel, BackupBrowser } from "./BackupPanel";
import { TokenGroups } from "./TokenGroups";
import { Modal } from "./Modal";
import { QuickAccessSettings } from "./QuickAccessSettings";
import { SteamNetworkPanel } from "./SteamNetworkPanel";
import type {
  Confirmation,
  Enrollment,
  ImportPreview,
  LoginResult,
  MarketResult,
  Page,
  TokenView,
  VaultStatus,
} from "./types";

const navigation: {
  id: Page;
  label: string;
  icon: typeof Shield;
}[] = [
  { id: "tokens", label: "令牌", icon: LayoutGrid },
  { id: "confirmations", label: "交易确认", icon: CheckCheck },
  { id: "market", label: "社区市场", icon: ShoppingBag },
  { id: "settings", label: "设置", icon: Settings2 },
];

function Spinner() {
  return <LoaderCircle size={16} className="spin" />;
}
function SteamMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`steam-mark ${small ? "small" : ""}`}>
      <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M5 28l9 4 9-9M20 21l5-6"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <circle cx="28" cy="12" r="8" stroke="currentColor" strokeWidth="3" />
        <circle cx="28" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
        <circle cx="15" cy="30" r="6" stroke="currentColor" strokeWidth="3" />
      </svg>
    </span>
  );
}
function TokenIcon({ token }: { token: TokenView }) {
  return <TokenAvatar token={token} />;
}

export default function App() {
  const [showUnlock, setShowUnlock] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [licenseText, setLicenseText] = useState("");
  useEffect(() => {
    if (licensesOpen)
      void fetch("/third-party-notices.txt")
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.text();
        })
        .then(setLicenseText)
        .catch(() => setLicenseText("无法读取许可文件"));
  }, [licensesOpen]);
  const startupAccess = useRef(false);
  const [page, setPage] = useState<Page>("tokens");
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [search, setSearch] = useState("");
  const [groups, setGroups] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState("all");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loginToken, setLoginToken] = useState<TokenView | null>(null);
  const [editToken, setEditToken] = useState<TokenView | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const [account, setAccount] = useState("");
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [confirmationLoaded, setConfirmationLoaded] = useState(false);
  const [market, setMarket] = useState<MarketResult | null>(null);
  const [action, setAction] = useState<{
    item: Confirmation;
    approve: boolean;
  } | null>(null);
  const refreshing = useRef(false);
  const notify = useCallback(
    (text: string, error = false) => setNotification({ text, error }),
    [],
  );
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      let next = await api.status();
      if (!startupAccess.current) {
        startupAccess.current = true;
        if (next.initialized && next.locked) {
          try {
            if (next.previewEnabled) await api.previewEnter();
            else if (next.biometricEnabled) await api.biometricUnlock();
            next = await api.status();
          } catch (error) {
            notify(errorText(error), true);
          }
        }
      }
      setStatus(next);
      if (next.initialized && !next.locked) {
        setTokens(await api.tokens());
        setGroups(await api.groups());
        setShowUnlock(false);
      } else if (next.previewActive) {
        try {
          const previewTokens = await api.previewTokens();
          setTokens(previewTokens);
          setGroups([
            ...new Set(
              previewTokens.map((t) => t.group).filter((g): g is string => !!g),
            ),
          ]);
        } catch (error) {
          setTokens([]);
          await api.previewExit();
          setStatus(await api.status());
          notify(errorText(error), true);
        }
      } else {
        setTokens([]);
        setGroups([]);
      }
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      refreshing.current = false;
    }
  }, [notify]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);
  useEffect(() => {
    if (
      groupFilter !== "all" &&
      groupFilter !== "ungrouped" &&
      !groups.includes(groupFilter.slice(6))
    )
      setGroupFilter("all");
  }, [groups, groupFilter]);
  const steamTokens = tokens.filter((t) => t.kind === "steam");
  const hasSteam = steamTokens.length > 0;
  const visibleNavigation = navigation.filter(
    (item) => hasSteam || item.id === "tokens" || item.id === "settings",
  );
  useEffect(() => {
    if (!hasSteam) {
      setPage((value) =>
        value === "market" || value === "confirmations" ? "tokens" : value,
      );
      setFilter("all");
    }
  }, [hasSteam]);
  const active = steamTokens.find((t) => t.id === account) ?? steamTokens[0];
  useEffect(() => {
    setConfirmations([]);
    setConfirmationLoaded(false);
    setMarket(null);
  }, [active?.id]);
  const unlocked = !!status?.initialized && !status.locked;
  const previewMode = !!status?.previewActive && !!status.locked;
  useSyncWatcher(
    unlocked,
    JSON.stringify([
      groups,
      tokens.map((t) => [
        t.id,
        t.name,
        t.group,
        t.icon,
        t.counter,
        t.steamId,
        t.enrollmentPending,
      ]),
    ]),
  );
  useEffect(() => {
    if (!unlocked) {
      setGroupsOpen(false);
      setImportOpen(false);
      setLoginToken(null);
      setEditToken(null);
      setExportOpen(false);
      setAction(null);
      return;
    }
    let lastTouch = 0;
    const touch = () => {
      if (Date.now() - lastTouch > 30_000) {
        lastTouch = Date.now();
        void api.touch().catch(() => refresh());
      }
    };
    const keyboard = (e: KeyboardEvent) => {
      touch();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search-box input")?.focus();
      }
    };
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    const visibility = () => {
      clearTimeout(backgroundTimer);
      if (
        native &&
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
        document.hidden
      ) {
        backgroundTimer = setTimeout(() => {
          void api
            .lock()
            .then(refresh)
            .catch(() => {});
        }, 60_000);
      }
    };
    document.addEventListener("pointerdown", touch);
    document.addEventListener("keydown", keyboard);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(backgroundTimer);
      document.removeEventListener("pointerdown", touch);
      document.removeEventListener("keydown", keyboard);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [unlocked, refresh]);
  const visibleTokens = tokens
    .filter(
      (t) =>
        (filter === "all" ||
          (filter === "other" && t.kind !== "steam") ||
          t.kind === filter) &&
        (groupFilter === "all" ||
          (groupFilter === "ungrouped"
            ? !t.group
            : t.group === groupFilter.slice(6))) &&
        `${t.name} ${t.issuer} ${t.accountName ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "type"
        ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    );
  const run = async (job: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await job();
      if (success) notify(success);
      await refresh();
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (token: TokenView) => {
    if (!token.code || token.hotpReadOnly) return;
    try {
      await navigator.clipboard.writeText(token.code.replaceAll(" ", ""));
      setCopied(token.id);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      notify("无法写入剪贴板，请手动复制验证码。", true);
    }
  };
  const loadConfirmations = async () => {
    if (!active) return;
    setBusy(true);
    try {
      setConfirmations(await api.confirmations(active.id));
      setConfirmationLoaded(true);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const loadMarket = async () => {
    if (!active) return;
    setBusy(true);
    try {
      setMarket(await api.market(active.id));
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const closeImport = useCallback(() => setImportOpen(false), []);
  const closeLogin = useCallback(() => setLoginToken(null), []);
  const closeEdit = useCallback(() => setEditToken(null), []);
  const closeExport = useCallback(() => setExportOpen(false), []);
  const closeAction = useCallback(() => setAction(null), []);
  const current = navigation.find((n) => n.id === page)!;

  return (
    <div className={`app-shell ${page === "tokens" ? "token-home" : ""}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("tokens");
          }}
        >
          <span className="brand-symbol">
            <ShieldCheck size={25} strokeWidth={1.9} />
          </span>
          <span>
            Steam<span className="brand-light">Guard</span>
          </span>
        </a>

        <nav aria-label="主导航">
          {visibleNavigation.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={19} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.id === "confirmations" && confirmations.length > 0 && (
                <span className="nav-count">{confirmations.length}</span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <div className="main-shell">
        <main>
          <div className="page-heading">
            <div>
              <h1>{current.label}</h1>
            </div>
            <div className="heading-actions">
              {page === "tokens" && (
                <>
                  <button
                    className="button secondary desktop-export"
                    disabled={!unlocked || !tokens.length}
                    onClick={() => setExportOpen(true)}
                  >
                    <ArrowDownToLine size={16} />
                    导出备份
                  </button>
                  <button
                    className="button primary add-token"
                    aria-label="添加令牌"
                    disabled={!unlocked}
                    onClick={() => setImportOpen(true)}
                  >
                    <Plus size={17} />
                    <span>添加令牌</span>
                  </button>
                </>
              )}
              {page === "settings" && unlocked && (
                <button
                  className="button secondary"
                  onClick={() => void run(() => api.lock(), "保险库已锁定")}
                >
                  <LockKeyhole size={16} />
                  锁定保险库
                </button>
              )}
            </div>
          </div>
          {!status ? (
            <div className="loading-state">
              <Spinner />
              <span>正在加载…</span>
            </div>
          ) : !unlocked && (!previewMode || page !== "tokens" || showUnlock) ? (
            <VaultGate
              initialized={status.initialized}
              biometricEnabled={!!status.biometricEnabled}
              previewEnabled={!!status.previewEnabled}
              onPreview={async () => {
                if (!previewMode) await api.previewEnter();
                setShowUnlock(false);
                setPage("tokens");
                await refresh();
              }}
              onReady={refresh}
              notify={notify}
            />
          ) : (
            <>
              {page === "tokens" && (
                <>
                  {previewMode && (
                    <div className="preview-notice">
                      <span>只读预览</span>
                      <button
                        className="button secondary"
                        onClick={() => setShowUnlock(true)}
                      >
                        解锁
                      </button>
                    </div>
                  )}
                  <div className="section-toolbar">
                    {hasSteam && (
                      <div className="token-tabs">
                        <button
                          className={filter === "all" ? "selected" : ""}
                          onClick={() => setFilter("all")}
                        >
                          全部
                        </button>
                        <button
                          className={filter === "steam" ? "selected" : ""}
                          onClick={() => setFilter("steam")}
                        >
                          Steam
                        </button>
                        <button
                          className={filter === "other" ? "selected" : ""}
                          onClick={() =>
                            setFilter(filter === "other" ? "all" : "other")
                          }
                        >
                          其他令牌
                        </button>
                      </div>
                    )}
                    <div className="toolbar-right">
                      <label className="search-box">
                        <Search size={16} />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="搜索"
                          aria-label="搜索令牌"
                        />
                      </label>
                      <label className="sort-select" title="排序">
                        <SlidersHorizontal size={16} />
                        <select
                          value={sort}
                          onChange={(e) => setSort(e.target.value)}
                          aria-label="令牌排序"
                        >
                          <option value="name">按名称</option>
                          <option value="type">按类型</option>
                        </select>
                        <ChevronDown size={12} />
                      </label>
                    </div>
                  </div>
                  <div className="group-toolbar">
                    <label>
                      <FolderOpen size={17} />
                      <select
                        aria-label="分组筛选"
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                      >
                        <option value="all">全部分组</option>
                        <option value="ungrouped">未分组</option>
                        {groups.map((g) => (
                          <option key={g} value={"group:" + g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="icon-button"
                      aria-label="管理分组"
                      disabled={!unlocked}
                      onClick={() => setGroupsOpen(true)}
                    >
                      <Settings2 size={19} />
                    </button>
                  </div>
                  {visibleTokens.filter(
                    (t) => filter !== "other" || t.kind !== "steam",
                  ).length ? (
                    <div className="token-grid">
                      {visibleTokens
                        .filter((t) => filter !== "other" || t.kind !== "steam")
                        .map((token) => (
                          <article className="token-card" key={token.id}>
                            <div className="token-card-top">
                              <TokenIcon token={token} />
                              <div className="token-identity">
                                <h3>{token.name}</h3>
                                {token.group && (
                                  <small className="token-group-label">
                                    {token.group}
                                  </small>
                                )}
                                {token.accountName &&
                                !token.name.includes(token.accountName) ? (
                                  <span>{token.accountName}</span>
                                ) : token.kind !== "steam" &&
                                  token.issuer &&
                                  !token.name
                                    .toLowerCase()
                                    .includes(token.issuer.toLowerCase()) ? (
                                  <span>{token.issuer}</span>
                                ) : null}
                              </div>
                              <button
                                className="icon-button token-menu"
                                aria-label={`管理 ${token.name}`}
                                disabled={!unlocked}
                                onClick={() => setEditToken(token)}
                              >
                                <Ellipsis size={19} />
                              </button>
                            </div>
                            <div className="code-area">
                              <button
                                className={`token-code ${token.remaining <= 5 && token.kind !== "hotp" ? "expiring" : ""}`}
                                onClick={() => void copy(token)}
                                disabled={token.hotpReadOnly}
                                aria-label={`复制 ${token.name} 验证码`}
                              >
                                {token.hotpReadOnly
                                  ? "仅主设备"
                                  : token.code || "•••••"}
                              </button>
                              <button
                                className={`copy-button ${copied === token.id ? "copied" : ""}`}
                                aria-label="复制验证码"
                                disabled={token.hotpReadOnly}
                                onClick={() => void copy(token)}
                              >
                                {copied === token.id ? (
                                  <Check size={17} />
                                ) : (
                                  <Copy size={17} />
                                )}
                              </button>
                            </div>
                            {token.kind !== "hotp" && (
                              <div
                                className="token-progress"
                                aria-label={`剩余 ${token.remaining} 秒`}
                              >
                                <span
                                  style={{
                                    width: `${Math.max(0, Math.min(100, (token.remaining / (token.period || 30)) * 100))}%`,
                                  }}
                                />
                              </div>
                            )}
                            <div className="token-card-bottom">
                              {token.kind === "hotp" && (
                                <span className="token-time">
                                  {token.kind === "hotp"
                                    ? `计数 ${token.counter ?? 0}`
                                    : ""}
                                </span>
                              )}
                              {token.kind === "steam" ? (
                                <button
                                  className={`session-link ${token.loggedIn ? "connected" : ""}`}
                                  onClick={() =>
                                    unlocked
                                      ? setLoginToken(token)
                                      : setShowUnlock(true)
                                  }
                                >
                                  {previewMode ? (
                                    <>
                                      <LockKeyhole size={14} />
                                      解锁后连接
                                    </>
                                  ) : token.enrollmentPending ? (
                                    <>
                                      <Clock3 size={12} />
                                      继续激活
                                    </>
                                  ) : token.loggedIn ? (
                                    <>
                                      <span className="status-dot" />
                                      已登录
                                    </>
                                  ) : (
                                    <>
                                      <LogIn size={12} />
                                      连接 Steam
                                    </>
                                  )}
                                </button>
                              ) : token.kind === "hotp" ? (
                                <button
                                  className="session-link"
                                  disabled={!unlocked || token.hotpReadOnly}
                                  onClick={() =>
                                    void run(() => api.nextHotp(token.id))
                                  }
                                >
                                  下一验证码
                                  <ArrowRight size={12} />
                                </button>
                              ) : null}
                            </div>
                          </article>
                        ))}
                    </div>
                  ) : tokens.length ? (
                    <div className="empty-state compact">
                      <Search size={28} />
                      <h2>没有找到匹配的令牌</h2>

                      <button
                        className="button secondary"
                        onClick={() => {
                          setSearch("");
                          setFilter("all");
                          setGroupFilter("all");
                        }}
                      >
                        清除筛选
                      </button>
                    </div>
                  ) : (
                    <div className="tokens-empty">
                      <h2>暂无令牌</h2>
                      <button
                        className="button primary"
                        disabled={!unlocked}
                        onClick={() => setImportOpen(true)}
                      >
                        <Plus size={17} />
                        添加令牌
                      </button>
                    </div>
                  )}
                </>
              )}
              {(page === "confirmations" || page === "market") && (
                <>
                  <div className="account-toolbar">
                    <div>
                      <label htmlFor="steam-account">当前 Steam 账户</label>
                      <div className="account-select">
                        <SteamMark small />
                        <select
                          id="steam-account"
                          value={active?.id ?? ""}
                          onChange={(e) => setAccount(e.target.value)}
                        >
                          {!steamTokens.length && (
                            <option value="">暂无 Steam 令牌</option>
                          )}
                          {steamTokens.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                              {t.loggedIn ? " · 已登录" : " · 未登录"}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </div>
                    <div className="account-actions">
                      {active && !active.loggedIn && (
                        <button
                          className="button primary"
                          onClick={() => setLoginToken(active)}
                        >
                          <LogIn size={16} />
                          登录 Steam
                        </button>
                      )}
                      <button
                        className="button secondary"
                        disabled={!active?.loggedIn || busy}
                        onClick={() =>
                          void (page === "market"
                            ? loadMarket()
                            : loadConfirmations())
                        }
                      >
                        {busy ? <Spinner /> : <RefreshCw size={15} />}刷新
                        {page === "market" ? "市场" : "确认"}
                      </button>
                    </div>
                  </div>
                  {!active ? (
                    <div className="empty-state">
                      <SteamMark />
                      <h2>先添加一个 Steam 令牌</h2>
                      <p>
                        导入包含 Steam
                        身份密钥的令牌，再登录账户即可使用此功能。
                      </p>
                      <button
                        className="button primary"
                        onClick={() => setImportOpen(true)}
                      >
                        <Plus size={16} />
                        导入 Steam 令牌
                      </button>
                    </div>
                  ) : !active.loggedIn ? (
                    <div className="empty-state">
                      <span className="empty-state-icon">
                        <LogIn size={30} />
                      </span>
                      <h2>连接你的 Steam 账户</h2>
                      <p>
                        登录后即可查看
                        {page === "market"
                          ? "社区市场在售物品"
                          : "待处理的交易与市场确认"}
                        。
                      </p>
                      <button
                        className="button primary"
                        onClick={() => setLoginToken(active)}
                      >
                        登录 {active.name}
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  ) : page === "confirmations" ? (
                    confirmations.length ? (
                      <div className="confirmation-list">
                        {confirmations.map((item) => (
                          <article className="confirmation-card" key={item.id}>
                            <div className="confirmation-icon">
                              <ShoppingBag size={25} />
                            </div>
                            <div className="confirmation-info">
                              <span className="eyebrow">待你确认</span>
                              <h3>{item.headline}</h3>
                              <p>
                                {item.summary?.join(" · ") ||
                                  `确认编号 ${item.id}`}
                              </p>
                              {item.creationTime > 0 && (
                                <small>
                                  {new Date(
                                    item.creationTime * 1000,
                                  ).toLocaleString("zh-CN")}
                                </small>
                              )}
                            </div>
                            <div className="confirmation-actions">
                              <button
                                className="button secondary danger-text"
                                onClick={() =>
                                  setAction({ item, approve: false })
                                }
                              >
                                拒绝
                              </button>
                              <button
                                className="button primary"
                                onClick={() =>
                                  setAction({ item, approve: true })
                                }
                              >
                                查看并确认
                                <ArrowRight size={14} />
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">
                        <span className="empty-state-icon">
                          <CheckCheck size={33} />
                        </span>
                        <h2>
                          {confirmationLoaded
                            ? "目前没有待确认的交易"
                            : "查看待处理的交易"}
                        </h2>
                        <p>
                          {confirmationLoaded
                            ? "新的交易或市场上架确认会在刷新后显示。"
                            : "从 Steam 获取确认列表，再逐笔核对交易信息。"}
                        </p>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void loadConfirmations()}
                        >
                          {busy ? <Spinner /> : <RefreshCw size={15} />}
                          获取交易确认
                        </button>
                      </div>
                    )
                  ) : (
                    <>
                      <div className="market-intro">
                        <span className="market-intro-icon">
                          <ShoppingBag size={26} />
                        </span>
                        <div>
                          <h3>你的社区市场</h3>
                          <p>
                            {market?.walletBalance
                              ? `钱包余额 ${market.walletBalance}`
                              : "在这里查看在售物品，前往 Steam 完成市场操作。"}
                          </p>
                        </div>
                        <button
                          className="button secondary"
                          onClick={() =>
                            void run(() =>
                              api.external(
                                "https://steamcommunity.com/market/",
                              ),
                            )
                          }
                        >
                          打开社区市场
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                      {market?.items.length ? (
                        <div className="market-table">
                          <div className="market-table-head">
                            <span>在售物品</span>
                            <span>数量</span>
                            <span>价格</span>
                            <span />
                          </div>
                          {market.items.map((item) => (
                            <div className="market-row" key={item.id}>
                              <div className="market-item">
                                <span className="market-item-icon">
                                  <ShoppingBag size={20} />
                                </span>
                                <div>
                                  <strong>{item.name}</strong>
                                  <small>{item.game || "Steam 社区市场"}</small>
                                </div>
                              </div>
                              <span>{item.quantity ?? 1}</span>
                              <strong className="market-price">
                                {item.price || "—"}
                              </strong>
                              <button
                                className="icon-button"
                                aria-label={`查看 ${item.name}`}
                                onClick={() =>
                                  void run(() =>
                                    api.external(
                                      item.url ||
                                        "https://steamcommunity.com/market/",
                                    ),
                                  )
                                }
                              >
                                <ArrowUpRight size={17} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-state">
                          <span className="empty-state-icon">
                            <ShoppingBag size={31} />
                          </span>
                          <h2>
                            {market ? "当前没有在售物品" : "查看你的在售物品"}
                          </h2>
                          <p>
                            {market?.message ||
                              "刷新以获取当前账户的社区市场信息。"}
                          </p>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void loadMarket()}
                          >
                            {busy ? <Spinner /> : <RefreshCw size={15} />}
                            获取市场列表
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {page === "settings" && (
                <div className="settings-grid">
                  <SettingsDisclosure title="多端同步">
                    <SyncPanel tokens={tokens} onChange={refresh} />
                  </SettingsDisclosure>
                  <SettingsDisclosure title="自动备份">
                    <BackupPanel onChange={refresh} />
                  </SettingsDisclosure>
                  <QuickAccessSettings status={status} onChange={refresh} />
                  <DesktopSettings />
                  <section className="settings-panel">
                    <div className="panel-title">
                      <h2>导入与导出</h2>
                    </div>
                    <div className="setting-row">
                      <h3>加密备份</h3>
                      <button
                        className="button secondary"
                        disabled={!tokens.length}
                        onClick={() => setExportOpen(true)}
                      >
                        <Download size={15} />
                        导出
                      </button>
                    </div>
                    <div className="setting-row">
                      <h3>导入令牌或备份</h3>
                      <button
                        className="button secondary"
                        onClick={() => setImportOpen(true)}
                      >
                        <Upload size={15} />
                        导入
                      </button>
                    </div>
                  </section>
                  {hasSteam && (
                    <SettingsDisclosure title="Steam">
                      <section className="settings-panel">
                        <div className="panel-title">
                          <h2>Steam</h2>
                        </div>
                        <div className="setting-row">
                          <h3>同步 Steam 时间</h3>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.syncTime(), "时间已同步")
                            }
                          >
                            {busy ? <Spinner /> : <RefreshCw size={15} />}同步
                          </button>
                        </div>
                        <SteamNetworkPanel />
                      </section>
                    </SettingsDisclosure>
                  )}
                  <section className="settings-panel about-panel">
                    <span className="brand-symbol">
                      <ShieldCheck size={26} />
                    </span>
                    <div>
                      <h2>
                        SteamGuard <span>1.5.1</span>
                      </h2>
                      <p>
                        {hasSteam
                          ? "开源双重验证器，支持通用 OTP、Steam 令牌、交易确认与社区市场。"
                          : "开源双重验证器，支持 TOTP 与 HOTP。"}
                      </p>
                      <a
                        className="text-button"
                        href="/third-party-notices.txt"
                        onClick={(event) => {
                          event.preventDefault();
                          setLicensesOpen(true);
                        }}
                      >
                        开源许可
                      </a>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="移动端导航">
        {visibleNavigation.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
          >
            <item.icon size={21} strokeWidth={1.7} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      {notification && (
        <div
          className={`toast ${notification.error ? "error" : ""}`}
          role="status"
        >
          {notification.error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{notification.text}</span>
          <button onClick={() => setNotification(null)} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {licensesOpen && (
        <Modal title="开源许可" onClose={() => setLicensesOpen(false)} wide>
          <pre className="license-text">{licenseText || "加载中…"}</pre>
        </Modal>
      )}
      {groupsOpen && (
        <TokenGroups
          groups={groups}
          onChange={refresh}
          onClose={() => setGroupsOpen(false)}
        />
      )}
      {importOpen && (
        <ImportDialog
          hasSteam={hasSteam}
          onLogin={() => {
            setImportOpen(false);
            setLoginToken({
              id: "new-account",
              name: "添加 Steam 令牌",
              kind: "steam",
              issuer: "Steam",
              code: "",
              period: 30,
              remaining: 0,
            });
          }}
          onClose={closeImport}
          onComplete={async () => {
            setImportOpen(false);
            await refresh();
            notify("导入完成");
          }}
        />
      )}
      {loginToken && (
        <LoginDialog
          token={loginToken}
          onClose={closeLogin}
          onComplete={async () => {
            await refresh();
            notify("Steam 会话已更新");
          }}
        />
      )}
      {editToken && (
        <EditDialog
          token={editToken}
          groups={groups}
          onClose={closeEdit}
          onComplete={async () => {
            setEditToken(null);
            await refresh();
          }}
        />
      )}
      {exportOpen && (
        <ExportDialog
          onClose={closeExport}
          onComplete={(path) => {
            setExportOpen(false);
            if (path) notify(`备份已导出：${path}`);
          }}
        />
      )}
      {action && (
        <Modal
          title={action.approve ? "确认这笔交易？" : "拒绝这笔交易？"}
          eyebrow="STEAM CONFIRMATION"
          onClose={closeAction}
        >
          <div className="review-summary">
            <ShoppingBag size={25} />
            <h3>{action.item.headline}</h3>
            <p>{action.item.summary?.join(" · ")}</p>
            <small>确认编号 {action.item.id}</small>
          </div>
          <p className="form-hint">
            请核对交易内容。此操作将直接提交至 Steam。
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeAction}
            >
              返回核对
            </button>
            <button
              className={`button ${action.approve ? "primary" : "danger"}`}
              disabled={busy}
              onClick={() => {
                if (!active) return;
                void run(
                  async () => {
                    try {
                      await api.confirm(
                        active.id,
                        action.item.id,
                        action.item.nonce,
                        action.approve,
                      );
                    } finally {
                      setAction(null);
                      await loadConfirmations();
                    }
                  },
                  action.approve ? "已确认交易" : "已拒绝交易",
                );
              }}
            >
              {busy ? <Spinner /> : <Check size={16} />}
              {action.approve ? "确认提交" : "拒绝交易"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function VaultGate({
  initialized,
  biometricEnabled,
  previewEnabled,
  onPreview,
  onReady,
  notify,
}: {
  initialized: boolean;
  biometricEnabled: boolean;
  previewEnabled: boolean;
  onPreview: () => Promise<void>;
  onReady: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [hasBackups, setHasBackups] = useState(false);
  useEffect(() => {
    if (native && initialized)
      void api
        .backupStatus()
        .then((s) => setHasBackups(s.entries.length > 0))
        .catch(() => {});
  }, [initialized]);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const quick = async (biometric: boolean) => {
    setBusy(true);
    try {
      if (biometric) {
        await api.biometricUnlock();
        setPassword("");
        await onReady();
      } else await onPreview();
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!initialized && password !== repeat) {
      notify("两次输入的密码不一致", true);
      return;
    }
    setBusy(true);
    try {
      await (initialized ? api.unlock(password) : api.create(password));
      setPassword("");
      setRepeat("");
      await onReady();
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vault-welcome">
      <div className="vault-form-wrap">
        <h2>{initialized ? "解锁" : "设置密码"}</h2>
        {initialized && (biometricEnabled || previewEnabled) && (
          <div className="quick-gate-actions">
            {biometricEnabled && (
              <button
                className="button primary full-width"
                onClick={() => void quick(true)}
                disabled={busy}
              >
                {busy ? <Spinner /> : <Fingerprint size={21} />}指纹 / Face ID
                解锁
              </button>
            )}
            {previewEnabled && (
              <button
                className="button secondary full-width"
                onClick={() => void quick(false)}
                disabled={busy}
              >
                预览令牌
                <ArrowRight size={17} />
              </button>
            )}
            <span className="access-divider">或使用主密码</span>
          </div>
        )}
        <form onSubmit={(e) => void submit(e)}>
          <label className="field-label" htmlFor="vault-password">
            {initialized ? "解锁密码" : "设置解锁密码"}
          </label>
          <div className="input-with-icon">
            <LockKeyhole size={16} />
            <input
              id="vault-password"
              type="password"
              autoComplete={initialized ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={initialized ? 1 : 8}
              required
              placeholder={initialized ? "输入密码" : "至少 8 位"}
            />
          </div>
          {!initialized && (
            <>
              <label className="field-label" htmlFor="vault-repeat">
                确认密码
              </label>
              <div className="input-with-icon">
                <KeyRound size={16} />
                <input
                  id="vault-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  minLength={8}
                  required
                  placeholder="再次输入解锁密码"
                />
              </div>
            </>
          )}
          <button className="button primary full-width" disabled={busy}>
            {busy ? <Spinner /> : <ShieldCheck size={17} />}
            {initialized ? "解锁保险库" : "创建保险库"}
            <ArrowRight size={16} />
          </button>
        </form>
        {hasBackups && (
          <button
            className="text-button backup-gate-button"
            onClick={() => setBackupsOpen(true)}
          >
            查看本机自动备份
          </button>
        )}
        {backupsOpen && (
          <BackupBrowser
            canRestore={false}
            onClose={() => setBackupsOpen(false)}
            onChange={onReady}
          />
        )}
      </div>
    </div>
  );
}

function ImportDialog({
  hasSteam,
  onClose,
  onComplete,
  onLogin,
}: {
  onClose: () => void;
  onComplete: () => Promise<void>;
  onLogin: () => void;
  hasSteam: boolean;
}) {
  const [mode, setMode] = useState<"file" | "text" | "qr">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const lastPreview = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (lastPreview.current)
        void api.discardPreview(lastPreview.current).catch(() => {});
    };
  }, []);
  const acceptPreview = (next: ImportPreview) => {
    if (!live.current) {
      void api.discardPreview(next.previewId).catch(() => {});
      return;
    }
    lastPreview.current = next.previewId;
    setPreview(next);
  };
  const check = async () => {
    setError("");
    setBusy(true);
    try {
      if (mode === "file" && file && file.size > 10 * 1024 * 1024)
        throw new Error("请选择不超过 10 MB 的令牌文件");
      const data =
        mode === "file" && file
          ? Array.from(new Uint8Array(await file.arrayBuffer()))
          : undefined;
      const result = await api.preview(
        mode === "file"
          ? { data, filename: file?.name, password: password || undefined }
          : { text, password: password || undefined },
      );
      acceptPreview(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setError("");
    setBusy(true);
    try {
      await api.commit(preview.previewId);
      setPassword("");
      setText("");
      await onComplete();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        preview
          ? "确认导入令牌"
          : mode === "qr"
            ? "扫描验证器二维码"
            : "把令牌带到这里"
      }
      eyebrow="IMPORT AUTHENTICATORS"
      onClose={onClose}
      wide
    >
      {preview ? (
        <>
          <div className="import-summary">
            <ShieldCheck size={22} />
            <div>
              <strong>
                {preview.tokens.length
                  ? `识别到 ${preview.tokens.length} 个令牌`
                  : "合并已有令牌信息"}
              </strong>
              {!!preview.groupCount && (
                <p className="form-hint">
                  备份包含 {preview.groupCount}{" "}
                  个分组，已有令牌的缺失分组可一并补回。
                </p>
              )}
              <p>
                {preview.duplicates
                  ? `${preview.duplicates} 个已有令牌将保留，可补充分组与 HOTP 计数`
                  : "确认后保存到本机加密保险库"}
              </p>
            </div>
          </div>
          <div className="import-token-list">
            {preview.tokens.map((t, i) => (
              <div key={i}>
                {t.kind === "steam" ? (
                  <SteamMark small />
                ) : (
                  <KeyRound size={20} />
                )}
                <div>
                  <strong>{t.name}</strong>
                  <small>{t.issuer || t.kind.toUpperCase()}</small>
                </div>
                <Check size={16} />
              </div>
            ))}
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              返回
            </button>
            <button
              className="button primary"
              disabled={
                busy || !(preview.canCommit ?? preview.tokens.length > 0)
              }
              onClick={() => void commit()}
            >
              {busy ? <Spinner /> : <ShieldCheck size={16} />}确认导入
            </button>
          </div>
        </>
      ) : (
        <>
          {mode !== "qr" &&
            (hasSteam ? (
              <button className="steam-login-import" onClick={onLogin}>
                <SteamMark small />
                <span>登录 Steam 添加令牌</span>
                <ArrowRight size={16} />
              </button>
            ) : (
              <details className="additional-import">
                <summary>其他添加方式</summary>
                <button className="button secondary" onClick={onLogin}>
                  添加 Steam 令牌
                </button>
              </details>
            ))}
          <div className="dialog-tabs import-tabs">
            <button
              className={mode === "qr" ? "selected" : ""}
              onClick={() => setMode("qr")}
            >
              <QrCode size={15} />
              扫码 / 图片
            </button>
            <button
              className={mode === "file" ? "selected" : ""}
              onClick={() => setMode("file")}
            >
              <FileKey2 size={15} />
              从文件导入
            </button>
            <button
              className={mode === "text" ? "selected" : ""}
              onClick={() => setMode("text")}
            >
              <KeyRound size={15} />
              粘贴密钥 / 链接
            </button>
          </div>
          {mode === "qr" ? (
            <QrImportPanel onPreview={acceptPreview} />
          ) : (
            <>
              {mode === "file" ? (
                <>
                  <input
                    ref={picker}
                    type="file"
                    className="visually-hidden"
                    accept=".mpo,.maFile,.json,.txt,.sgvault,.xml,.2fas"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    className={`file-drop ${file ? "has-file" : ""}`}
                    onClick={() => picker.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      setFile(e.dataTransfer.files[0] ?? null);
                    }}
                  >
                    <span className="file-drop-icon">
                      <Upload size={24} />
                    </span>
                    <strong>
                      {file ? file.name : "选择文件，或拖放到这里"}
                    </strong>
                    <span>
                      {file
                        ? `${(file.size / 1024).toFixed(1)} KB · 点击重新选择`
                        : "WattToolkit · Steam · Aegis · 2FAS · JSON"}
                    </span>
                  </button>
                </>
              ) : (
                <>
                  <label className="field-label" htmlFor="import-text">
                    OTP 链接或令牌 JSON
                  </label>
                  <textarea
                    id="import-text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={5}
                    placeholder="otpauth://totp/… 或粘贴 Steam maFile JSON"
                    spellCheck={false}
                  />
                </>
              )}
              <label className="field-label" htmlFor="import-password">
                备份密码 <span>（如已设置）</span>
              </label>
              <input
                id="import-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="未加密的备份可留空"
              />
              <p className="form-hint">
                <LockKeyhole size={13} />
                启用原设备保护的 .mpo 需要先在原设备导出可迁移备份。
              </p>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button className="button secondary" onClick={onClose}>
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={busy || (mode === "file" ? !file : !text.trim())}
                  onClick={() => void check()}
                >
                  {busy ? <Spinner /> : <ArrowRight size={16} />}预览令牌
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function LoginDialog({
  token,
  onClose,
  onComplete,
}: {
  token: TokenView;
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const isNew = token.id === "new-account";
  const [username, setUsername] = useState(token.accountName || "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeType, setCodeType] = useState(3);
  const [result, setResult] = useState<LoginResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [networkOpen, setNetworkOpen] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [mode, setMode] = useState<"password" | "qr">("password");
  const [tool, setTool] = useState<
    "none" | "enroll" | "transfer" | "approve" | "remove"
  >("none");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [sms, setSms] = useState("");
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [transferStarted, setTransferStarted] = useState(false);
  const [qrUrl, setQrUrl] = useState("");
  const [qrInfo, setQrInfo] = useState<Record<string, unknown> | null>(null);
  const [revocation, setRevocation] = useState("");
  const [removeChecked, setRemoveChecked] = useState(false);
  const authenticated = !!token.loggedIn || result?.status === "authenticated";
  const awaiting = result?.status === "guard" || result?.status === "pending";
  const canSubmitCode =
    awaiting &&
    !result?.guardSubmitted &&
    !!result?.guards.some(
      (g) => g.confirmationType === 2 || g.confirmationType === 3,
    );
  const canUseLocalGuard =
    canSubmitCode &&
    !isNew &&
    token.kind === "steam" &&
    !!result?.guards.some((g) => g.confirmationType === 3);
  const acceptStatus = async (next: LoginResult) => {
    setResult(next);
    setError(next.message || "");
    setPassword("");
    const option =
      next.guards.find((g) => g.confirmationType === 3) ||
      next.guards.find((g) => g.confirmationType === 2);
    if (option)
      setCodeType((current) =>
        next.guards.some((g) => g.confirmationType === current)
          ? current
          : option.confirmationType,
      );
    if (next.status === "authenticated" && !isNew) {
      await onComplete();
      onClose();
    }
  };
  const request = async (job: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!awaiting || busy) return;
    let stopped = false;
    const timer = setTimeout(
      () => {
        void api
          .poll(token.id)
          .then(async (next) => {
            if (!stopped) await acceptStatus(next);
          })
          .catch((e) => {
            if (!stopped) setError(errorText(e));
          });
      },
      Math.max(1000, result?.pollInterval || 3000),
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [result, token.id, awaiting, busy]);
  useEffect(() => {
    let stopped = false;
    setQrImage("");
    if (result?.qrUrl)
      void QRCode.toDataURL(result.qrUrl, {
        width: 264,
        margin: 2,
        errorCorrectionLevel: "M",
      }).then((image) => {
        if (!stopped) setQrImage(image);
      });
    return () => {
      stopped = true;
    };
  }, [result?.qrUrl]);
  const finish = async () => {
    await onComplete();
    onClose();
  };
  const enrollId = enrollment?.id || token.id;
  const pendingActivation =
    enrollment?.needsActivation || token.enrollmentPending;
  const activation = pendingActivation || (tool === "enroll" && !!enrollment);
  const close = () => {
    if (awaiting) void api.logout(token.id).catch(() => {});
    onClose();
  };
  if (networkOpen)
    return (
      <Modal title="Steam 网络设置" onClose={close}>
        <SteamNetworkPanel />
        <div className="modal-actions">
          <button
            className="button secondary"
            onClick={() => setNetworkOpen(false)}
          >
            返回登录
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={isNew ? "添加 Steam 令牌" : "Steam 账户"}
      eyebrow="CONNECT YOUR ACCOUNT"
      onClose={close}
    >
      <div className="login-account">
        <SteamMark />
        <div>
          <strong>{token.name}</strong>
          <span>
            {result?.steamId || token.steamId || "通过 Steam 官方认证接口登录"}
          </span>
        </div>
        {authenticated && <span className="secure-tag">已登录</span>}
      </div>
      {!isNew && (
        <p className="form-hint">
          当前令牌账号：{token.accountName || "未记录"} · SteamID：
          {token.steamId && !/^0+$/.test(token.steamId)
            ? token.steamId
            : "未关联，使用当前令牌验证成功后补全"}
        </p>
      )}
      {activation ? (
        <>
          <p className="dialog-intro">
            令牌密钥已加密保存。输入 Steam 发往{" "}
            {enrollment?.phoneHint || "绑定手机"} 的短信验证码，完成激活。
          </p>
          {enrollment?.revocationCode && (
            <div className="recovery-box">
              <strong>请妥善保存恢复代码</strong>
              <code>{enrollment.revocationCode}</code>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={recoverySaved}
                  onChange={(e) => setRecoverySaved(e.target.checked)}
                />
                我已将恢复代码保存在安全位置
              </label>
            </div>
          )}
          <label className="field-label" htmlFor="activation-sms">
            短信激活码
          </label>
          <input
            id="activation-sms"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={sms}
            onChange={(e) => setSms(e.target.value)}
            placeholder="Steam 短信验证码"
          />
          <div className="modal-actions">
            <button className="button secondary" onClick={close}>
              稍后激活
            </button>
            <button
              className="button primary"
              disabled={busy || !sms.trim() || (!!enrollment && !recoverySaved)}
              onClick={() =>
                void request(async () => {
                  await api.activate(enrollId, sms);
                  await finish();
                })
              }
            >
              {busy ? <Spinner /> : <ShieldCheck size={16} />}激活令牌
            </button>
          </div>
        </>
      ) : authenticated ? (
        <>
          {isNew && tool === "none" && (
            <>
              <p className="dialog-intro">
                登录已完成。请选择账号当前的令牌状态，继续添加本地令牌。
              </p>
              <div className="account-tool-grid">
                <button onClick={() => setTool("enroll")}>
                  <Plus size={20} />
                  <strong>绑定新令牌</strong>
                  <span>账号尚未启用手机令牌</span>
                </button>
                <button onClick={() => setTool("transfer")}>
                  <Smartphone size={20} />
                  <strong>短信转移现有令牌</strong>
                  <span>从原手机转移到本机</span>
                </button>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void request(() =>
                    api.external("https://store.steampowered.com/phone/manage"),
                  )
                }
              >
                管理 Steam 绑定手机号
                <ArrowUpRight size={13} />
              </button>
            </>
          )}
          {tool === "enroll" && !enrollment && (
            <>
              <p className="dialog-intro">
                此操作会在 Steam
                账号上创建手机令牌，并向已绑定的手机号发送激活短信。完成后请保存恢复代码和加密备份。
              </p>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >
                  返回
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void request(async () => {
                      const next = await api.enroll(token.id, username);
                      setEnrollment(next);
                    })
                  }
                >
                  {busy ? <Spinner /> : <Plus size={16} />}创建并发送短信
                </button>
              </div>
            </>
          )}
          {tool === "transfer" && (
            <>
              {enrollment ? (
                <>
                  <div className="recovery-box">
                    <strong>令牌已转移，请保存恢复代码</strong>
                    <code>{enrollment.revocationCode}</code>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={recoverySaved}
                        onChange={(e) => setRecoverySaved(e.target.checked)}
                      />
                      我已保存恢复代码
                    </label>
                  </div>
                  <p className="dialog-intro">
                    新令牌已加密保存在本机。请在设置中导出一份加密备份。
                  </p>
                  <div className="modal-actions">
                    <button
                      className="button primary"
                      disabled={!recoverySaved}
                      onClick={() => void finish()}
                    >
                      <Check size={16} />
                      完成
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="dialog-intro">
                    使用 Steam
                    绑定手机的短信验证码转移现有令牌。提交验证码后，原手机的令牌将被替换，Steam
                    可能对交易施加冷却限制。
                  </p>
                  {transferStarted && (
                    <>
                      <label className="field-label" htmlFor="transfer-sms">
                        短信验证码
                      </label>
                      <input
                        id="transfer-sms"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={sms}
                        onChange={(e) => setSms(e.target.value)}
                        placeholder="输入短信验证码"
                      />
                    </>
                  )}
                  <div className="modal-actions">
                    <button
                      className="button secondary"
                      onClick={() => setTool("none")}
                    >
                      返回
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || (transferStarted && !sms.trim())}
                      onClick={() =>
                        void request(async () => {
                          if (!transferStarted) {
                            await api.transferBegin(token.id);
                            setTransferStarted(true);
                          } else {
                            setEnrollment(
                              await api.transferFinish(token.id, sms, username),
                            );
                          }
                        })
                      }
                    >
                      {busy ? <Spinner /> : <Smartphone size={16} />}
                      {transferStarted ? "确认转移令牌" : "发送转移短信"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {tool === "approve" && (
            <>
              <p className="dialog-intro">
                粘贴 Steam
                电脑端登录二维码中的链接，先核对设备和位置，再决定是否批准。
              </p>
              <label className="field-label" htmlFor="qr-request">
                Steam 登录二维码链接
              </label>
              <input
                id="qr-request"
                value={qrUrl}
                onChange={(e) => {
                  setQrUrl(e.target.value);
                  setQrInfo(null);
                }}
                placeholder="https://s.team/q/…"
                spellCheck={false}
              />
              {qrInfo && (
                <div className="qr-request-details">
                  <h3>
                    {String(qrInfo.deviceFriendlyName || "Steam 登录设备")}
                  </h3>
                  <p>设备平台 {String(qrInfo.platformType ?? "未知")}</p>
                  <p>
                    {[qrInfo.city, qrInfo.state, qrInfo.country, qrInfo.ip]
                      .filter(Boolean)
                      .map(String)
                      .join(" · ")}
                  </p>
                  {!!qrInfo.locationMismatch && (
                    <p className="danger-text">
                      登录位置与近期使用位置不一致，请仔细核对。
                    </p>
                  )}
                  {!!qrInfo.highUsageLogin && (
                    <p className="danger-text">
                      Steam 标记此请求为频繁登录，请核对是否由你发起。
                    </p>
                  )}
                </div>
              )}
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >
                  返回
                </button>
                {qrInfo ? (
                  <>
                    <button
                      className="button secondary danger-text"
                      disabled={busy}
                      onClick={() =>
                        void request(async () => {
                          try {
                            await api.qrApprove(token.id, qrUrl, false);
                            setTool("none");
                          } finally {
                            setQrInfo(null);
                          }
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void request(async () => {
                          try {
                            await api.qrApprove(token.id, qrUrl, true);
                            setTool("none");
                          } finally {
                            setQrInfo(null);
                          }
                        })
                      }
                    >
                      {busy ? <Spinner /> : <Check size={16} />}批准登录
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy || !qrUrl.trim()}
                    onClick={() =>
                      void request(async () =>
                        setQrInfo(await api.qrInfo(token.id, qrUrl)),
                      )
                    }
                  >
                    {busy ? <Spinner /> : <ScanLine size={16} />}核对登录请求
                  </button>
                )}
              </div>
            </>
          )}
          {tool === "remove" && (
            <>
              <div className="delete-warning">
                <Shield size={28} />
                <h3>解除 Steam 手机令牌</h3>
                <p>
                  此操作会关闭账号上的手机令牌保护。删除本地令牌不会解除远端绑定；请仅在确实需要解绑时继续。
                </p>
              </div>
              <label className="field-label" htmlFor="remove-recovery">
                Steam 恢复代码
              </label>
              <input
                id="remove-recovery"
                value={revocation}
                onChange={(e) => setRevocation(e.target.value)}
                autoComplete="off"
                placeholder="R 开头的恢复代码"
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={removeChecked}
                  onChange={(e) => setRemoveChecked(e.target.checked)}
                />
                我确认解除此账号的 Steam 手机令牌保护
              </label>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >
                  返回
                </button>
                <button
                  className="button danger"
                  disabled={busy || !removeChecked || !revocation.trim()}
                  onClick={() =>
                    void request(async () => {
                      await api.removeGuard(token.id, revocation);
                      setRevocation("");
                      await finish();
                    })
                  }
                >
                  {busy ? <Spinner /> : <Trash2 size={16} />}确认解除令牌
                </button>
              </div>
            </>
          )}
          {!isNew && tool === "none" && (
            <>
              <p className="dialog-intro">
                此账户已建立 Steam 会话，可以读取交易确认和市场信息。
              </p>
              <div className="account-tool-grid">
                <button onClick={() => setTool("approve")}>
                  <ScanLine size={20} />
                  <strong>批准二维码登录</strong>
                  <span>核对并批准电脑端登录请求</span>
                </button>
                <button
                  onClick={() =>
                    void request(() =>
                      api.external(
                        "https://store.steampowered.com/phone/manage",
                      ),
                    )
                  }
                >
                  <Smartphone size={20} />
                  <strong>管理绑定手机号</strong>
                  <span>前往 Steam 官方页面</span>
                </button>
              </div>
              <button
                className="text-button danger-text"
                onClick={() => setTool("remove")}
              >
                解除 Steam 手机令牌
              </button>
              <div className="modal-actions">
                <button
                  className="button secondary danger-text"
                  disabled={busy}
                  onClick={() =>
                    void request(async () => {
                      await api.logout(token.id);
                      await finish();
                    })
                  }
                >
                  <LogOut size={15} />
                  退出会话
                </button>
                <button className="button primary" onClick={close}>
                  完成
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {!awaiting && (
            <div className="dialog-tabs">
              <button
                className={mode === "password" ? "selected" : ""}
                onClick={() => setMode("password")}
              >
                <KeyRound size={15} />
                账号密码
              </button>
              <button
                className={mode === "qr" ? "selected" : ""}
                onClick={() => {
                  setMode("qr");
                  void request(async () =>
                    acceptStatus(await api.qrLogin(token.id)),
                  );
                }}
              >
                <QrCode size={15} />
                二维码登录
              </button>
            </div>
          )}
          {mode === "qr" ? (
            <div className="qr-login-panel">
              {qrImage ? (
                <img
                  src={qrImage}
                  alt="Steam 登录二维码，请使用 Steam 手机应用扫描"
                  width={264}
                  height={264}
                />
              ) : (
                <div className="qr-placeholder">
                  <QrCode size={64} />
                </div>
              )}
              <p>使用 Steam 手机应用扫描，并在手机上批准登录。</p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void request(async () =>
                    acceptStatus(await api.qrLogin(token.id)),
                  )
                }
              >
                <RefreshCw size={15} />
                刷新二维码
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void request(async () =>
                  acceptStatus(
                    await (awaiting
                      ? canSubmitCode
                        ? api.guard(token.id, code, codeType)
                        : api.poll(token.id)
                      : api.login(token.id, username, password)),
                  ),
                );
              }}
            >
              {awaiting ? (
                <>
                  <p className="dialog-intro">
                    {result?.guardSubmitted
                      ? "验证码已提交，正在等待 Steam 完成登录。"
                      : "请完成 Steam 返回的验证方式：令牌验证码、邮箱验证码或手机应用批准。"}
                  </p>
                  {canUseLocalGuard && (
                    <div className="local-guard-panel">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void request(async () =>
                            acceptStatus(await api.guardLocal(token.id)),
                          )
                        }
                      >
                        <ShieldCheck size={16} />
                        使用当前令牌验证
                      </button>
                      <p className="form-hint">
                        使用 Steam
                        服务器时间生成最新验证码并直接提交，无需复制；邮箱验证仍需输入邮件中的验证码。
                      </p>
                    </div>
                  )}
                  {canSubmitCode && (
                    <>
                      <label className="field-label" htmlFor="guard-type">
                        验证方式
                      </label>
                      <select
                        id="guard-type"
                        value={codeType}
                        onChange={(e) => setCodeType(Number(e.target.value))}
                      >
                        {result.guards
                          .filter(
                            (g) =>
                              g.confirmationType === 2 ||
                              g.confirmationType === 3,
                          )
                          .map((g) => (
                            <option
                              key={g.confirmationType}
                              value={g.confirmationType}
                            >
                              {g.confirmationType === 3
                                ? "Steam 令牌验证码"
                                : `邮箱验证码 ${g.associatedMessage}`}
                            </option>
                          ))}
                      </select>
                      <label className="field-label" htmlFor="guard-code">
                        验证码
                      </label>
                      <input
                        id="guard-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="one-time-code"
                        placeholder="输入 Steam 验证码"
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button poll-button"
                    disabled={busy}
                    onClick={() =>
                      void request(async () =>
                        acceptStatus(await api.poll(token.id)),
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    已在手机批准，检查登录状态
                  </button>
                </>
              ) : (
                <>
                  <p className="dialog-intro">
                    密码仅用于向 Steam 建立登录会话，不会存入保险库。
                  </p>
                  <label className="field-label" htmlFor="steam-username">
                    Steam 账户名
                  </label>
                  <input
                    id="steam-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    placeholder="用于登录的账户名"
                  />
                  <label className="field-label" htmlFor="steam-password">
                    密码
                  </label>
                  <input
                    id="steam-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    placeholder="Steam 账户密码"
                  />
                </>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={close}
                >
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (awaiting
                      ? canSubmitCode && !code.trim()
                      : !username.trim() || !password)
                  }
                >
                  {busy ? <Spinner /> : <LogIn size={16} />}
                  {awaiting
                    ? canSubmitCode
                      ? "提交验证码"
                      : "检查登录状态"
                    : "登录"}
                </button>
              </div>
            </form>
          )}
          {awaiting && mode === "password" && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                void request(async () => {
                  await api.logout(token.id);
                  setResult(null);
                  setCode("");
                  setError("");
                })
              }
            >
              重新输入账号
            </button>
          )}
          {mode === "qr" && (
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  void api.logout(token.id);
                  setMode("password");
                  setResult(null);
                }}
              >
                返回密码登录
              </button>
              <button
                className="button primary"
                disabled={busy || !awaiting}
                onClick={() =>
                  void request(async () =>
                    acceptStatus(await api.poll(token.id)),
                  )
                }
              >
                {busy ? <Spinner /> : <RefreshCw size={15} />}检查登录状态
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <>
          <div className="form-error" role="alert">
            {error}
          </div>
          <button className="text-button" onClick={() => setNetworkOpen(true)}>
            <Globe2 size={15} />
            检查网络与代理
          </button>
        </>
      )}
    </Modal>
  );
}

function EditDialog({
  token,
  groups,
  onClose,
  onComplete,
}: {
  token: TokenView;
  groups: string[];
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const [icon, setIcon] = useState(token.icon ?? null);
  const [pickIcon, setPickIcon] = useState(false);
  const [name, setName] = useState(token.name);
  const [group, setGroup] = useState(token.group ?? "");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [uri, setUri] = useState("");
  const [exported, setExported] = useState("");
  const act = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      await (remove
        ? api.remove(token.id)
        : api.updateToken(token.id, name.trim(), group || null, {
            value: icon,
          }));
      await onComplete();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const revealQr = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.uri(token.id);
      setUri(next);
      setQrImage(await QRCode.toDataURL(next, { width: 260, margin: 2 }));
      setShowQr(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const exportToken = async (format: "mafile" | "otpauth") => {
    setBusy(true);
    setError("");
    try {
      const path = await api.tokenExport(token.id, format);
      if (path) setExported(`已导出：${path}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        pickIcon
          ? "选择头像"
          : deleting
            ? "删除这个令牌？"
            : showQr
              ? "令牌迁移二维码"
              : "管理令牌"
      }
      eyebrow="AUTHENTICATOR SETTINGS"
      onClose={onClose}
    >
      {pickIcon ? (
        <IconPicker
          token={token}
          selected={icon}
          onSelect={(value) => {
            setIcon(value);
            setPickIcon(false);
          }}
          onBack={() => setPickIcon(false)}
        />
      ) : deleting ? (
        <div className="delete-warning">
          <Trash2 size={27} />
          <h3>{token.name}</h3>
          <p>
            此令牌及其本地登录会话将从保险库删除。请先确认你已保留可用的备份。
          </p>
        </div>
      ) : showQr ? (
        <>
          <p className="dialog-intro">
            二维码包含令牌密钥。仅在受信任的设备上扫描，不要分享或截图发送给他人。
          </p>
          <div className="qr-login-panel">
            <img
              src={qrImage}
              alt="包含令牌密钥的迁移二维码"
              width={260}
              height={260}
            />
          </div>
          <button
            className="button secondary full-width"
            onClick={() =>
              void navigator.clipboard
                .writeText(uri)
                .catch(() => setError("无法复制链接"))
            }
          >
            <Copy size={15} />
            复制 OTP 链接
          </button>
        </>
      ) : (
        <>
          <div className="login-account">
            <button
              className="avatar-edit"
              aria-label="更换头像"
              onClick={() => setPickIcon(true)}
            >
              <TokenAvatar token={token} icon={icon} />
              <span>更换头像</span>
            </button>
            <div>
              <strong>
                {token.issuer ||
                  (token.kind === "steam"
                    ? "Steam Guard"
                    : token.kind.toUpperCase())}
              </strong>
              {token.steamId && <span>{token.steamId}</span>}
            </div>
          </div>
          <label className="field-label" htmlFor="token-name">
            显示名称
          </label>
          <input
            id="token-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="field-label" htmlFor="token-group">
            分组
          </label>
          <select
            id="token-group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            disabled={busy}
          >
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <details className="token-details">
            <summary>令牌详情</summary>
            <div className="token-metadata">
              <span>
                类型 <strong>{token.kind.toUpperCase()}</strong>
              </span>
              <span>
                周期 <strong>{token.period} 秒</strong>
              </span>
              {token.algorithm && (
                <span>
                  算法 <strong>{token.algorithm}</strong>
                </span>
              )}
            </div>
          </details>
          <div className="account-tool-grid">
            <button disabled={busy} onClick={() => void revealQr()}>
              <QrCode size={20} />
              <strong>迁移二维码</strong>
              <span>显示 OTP 密钥链接</span>
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void exportToken(token.kind === "steam" ? "mafile" : "otpauth")
              }
            >
              <Download size={20} />
              <strong>
                {token.kind === "steam" ? "导出 maFile" : "导出 OTP 链接"}
              </strong>
              <span>包含密钥的明文文件</span>
            </button>
          </div>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      {exported && <div className="inline-success">{exported}</div>}
      {!pickIcon && (
        <div className="modal-actions">
          {deleting ? (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                返回
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void act(true)}
              >
                {busy ? <Spinner /> : <Trash2 size={15} />}确认删除
              </button>
            </>
          ) : showQr ? (
            <button
              className="button secondary"
              onClick={() => {
                setShowQr(false);
                setUri("");
                setQrImage("");
              }}
            >
              隐藏密钥并返回
            </button>
          ) : (
            <>
              <button
                className="button text danger-text"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={15} />
                删除令牌
              </button>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
                onClick={() => void act(false)}
              >
                {busy ? <Spinner /> : <Check size={15} />}保存
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function ExportDialog({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: (path: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [format, setFormat] = useState<"sgvault" | "mpo">("sgvault");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const path = await api.export(password, format);
      setPassword("");
      setRepeat("");
      onComplete(path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="导出加密备份" eyebrow="KEEP A SAFE COPY" onClose={onClose}>
      <p className="dialog-intro">为备份设置独立密码，并与备份文件分开保管。</p>
      <form onSubmit={(e) => void submit(e)}>
        <label className="field-label" htmlFor="export-format">
          备份格式
        </label>
        <select
          id="export-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as "sgvault" | "mpo")}
        >
          <option value="sgvault">SteamGuard 加密备份（.sgvault）</option>
          <option value="mpo">Watt Toolkit 原始格式（.mpo）</option>
        </select>
        <p className="form-hint">
          {format === "sgvault"
            ? "使用 Argon2id 与 AES-GCM 加密，可包含本地登录会话。"
            : "兼容 Watt Toolkit V2，使用原格式的二级密码保护。"}
        </p>
        <label className="field-label" htmlFor="export-password">
          备份密码
        </label>
        <input
          id="export-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 8 位"
        />
        <label className="field-label" htmlFor="export-repeat">
          确认密码
        </label>
        <input
          id="export-repeat"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          placeholder="再次输入备份密码"
        />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Download size={16} />}选择位置并导出
          </button>
        </div>
      </form>
    </Modal>
  );
}
