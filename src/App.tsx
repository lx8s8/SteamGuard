import { t as translate, formatDateTime } from "./i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowUp, ArrowDown, Pin,
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
import { BatchQrExport } from "./BatchQrExport";
import { LanguageSettings } from "./LanguageSettings";
import { UpdateSettings } from "./UpdateSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { SteamQrScanner } from "./SteamQrScanner";
import { DesktopSettings } from "./DesktopSettings";
import { QrImportPanel } from "./QrImportPanel";
import { api, errorText, native } from "./api";
import { SyncPanel, useSyncWatcher } from "./SyncPanel";
import { BackupPanel, BackupBrowser } from "./BackupPanel";
import { TokenGroups } from "./TokenGroups";
import { Modal } from "./Modal";
import { ManualTokenForm, OtpParameters, PasswordSettings, TrashBrowser } from "./TokenManagement";
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
  TokenParameters,
  VaultStatus,
} from "./types";

const navigation: {
  id: Page;
  label: string;
  icon: typeof Shield;
}[] = [
  { id: "tokens", get label() { return translate("令牌"); }, icon: LayoutGrid },
  { id: "confirmations", get label() { return translate("交易确认"); }, icon: CheckCheck },
  { id: "market", get label() { return translate("社区市场"); }, icon: ShoppingBag },
  { id: "settings", get label() { return translate("设置"); }, icon: Settings2 },
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
        .catch(() => setLicenseText(translate("无法读取许可文件")));
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchGroup, setBatchGroup] = useState("");
  const [batchDelete, setBatchDelete] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const dragging = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<{
    text: string;
    error: boolean;
    undo?: string[];
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loginToken, setLoginToken] = useState<TokenView | null>(null);
  const [editToken, setEditToken] = useState<TokenView | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [batchExportOpen, setBatchExportOpen] = useState(false);
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
  const statusRef = useRef<VaultStatus | null>(null);
  const revisionRef = useRef<string | null>(null);
  const accessEpoch = useRef(0);
  const resuming = useRef(false);
  statusRef.current = status;
  const notify = useCallback(
    (text: string, error = false, undo?: string[]) => setNotification({ text, error, undo }),
    [],
  );
  const refresh = useCallback(async () => {
    if (refreshing.current || resuming.current) return;
    refreshing.current = true;
    const epoch = accessEpoch.current;
    try {
      let next = await api.status();
      if (epoch !== accessEpoch.current || resuming.current) return;
      if (!startupAccess.current) {
        startupAccess.current = true;
        if (next.initialized && next.locked) {
          try {
            if (next.previewEnabled) await api.previewEnter();
            else if (next.biometricEnabled) await api.biometricUnlock();
            next = await api.status();
          } catch (error) {
            if (epoch === accessEpoch.current) notify(errorText(error), true);
          }
        }
      }
      let nextTokens: TokenView[] = [];
      let nextGroups: string[] = [];
      if (next.initialized && !next.locked) {
        nextTokens = await api.tokens();
        nextGroups = await api.groups();
      } else if (next.previewActive) {
        try {
          nextTokens = await api.previewTokens();
          nextGroups = [...new Set(nextTokens.map(t => t.group).filter((g): g is string => !!g))];
        } catch (error) {
          await api.previewExit();
          next = await api.status();
          if (epoch === accessEpoch.current) notify(errorText(error), true);
        }
      }
      if (epoch !== accessEpoch.current || resuming.current) return;
      setStatus(next);
      setTokens(nextTokens);
      setGroups(nextGroups);
      if (!next.locked) setShowUnlock(false);
    } catch (e) {
      if (epoch === accessEpoch.current) notify(errorText(e), true);
    } finally {
      refreshing.current = false;
    }
  }, [notify]);
  useEffect(() => {
    void refresh();
    let polling = false;
    let ticks = 0;
    const poll = async () => {
      if (document.hidden || polling || refreshing.current || resuming.current || !native) return;
      const epoch = accessEpoch.current;
      polling = true;
      try {
        const previous = statusRef.current;
        if (++ticks % 5 === 0) {
          const next = await api.status();
          if (epoch !== accessEpoch.current || resuming.current) return;
          setStatus(next);
          if (next.locked !== previous?.locked || next.previewActive !== previous?.previewActive) {
            await refresh();
            return;
          }
        }
        if (previous?.initialized && (!previous.locked || previous.previewActive)) {
          const snapshot = await api.tokenCodes();
          if (epoch !== accessEpoch.current || resuming.current) return;
          if (revisionRef.current !== null && revisionRef.current !== snapshot.revision) {
            revisionRef.current = snapshot.revision;
            await refresh();
            return;
          }
          revisionRef.current = snapshot.revision;
          const byId = new Map(snapshot.codes.map(code => [code.id, code]));
          setTokens(current => current.map(token => {
            const code = byId.get(token.id);
            return code ? { ...token, code: code.code, remaining: code.remaining, period: code.period } : token;
          }));
        }
      } catch { await refresh(); } finally { polling = false; }
    };
    const timer = setInterval(() => void poll(), 1000);
    const changed = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("steamguard:sync-updated", changed);
    return () => { clearInterval(timer); window.removeEventListener("steamguard:sync-updated", changed); };
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
  useEffect(() => {
    setSelected(previous => {
      const next = previous.filter(id => tokens.some(token => token.id === id));
      return next.length === previous.length ? previous : next;
    });
  }, [tokens]);
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
        t.counter,
        t.steamId,
        t.enrollmentPending,
      ]),
    ]),
  );
  useEffect(() => {
    if (!unlocked) {
      setSelecting(false);
      setSelected([]);
      setTrashOpen(false);
      setBatchDelete(false);
      setGroupsOpen(false);
      setImportOpen(false);
      setLoginToken(null);
      setEditToken(null);
      setExportOpen(false);
      setBatchExportOpen(false);
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
    document.addEventListener("pointerdown", touch);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", touch);
      document.removeEventListener("keydown", keyboard);
    };
  }, [unlocked, refresh]);
  useEffect(() => {
    let hiddenAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const mobile = native && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const clearCodes = () => {
      accessEpoch.current += 1;
      setTokens([]); setGroups([]);
      setStatus(current => current ? { ...current, locked: true, previewActive: false } : current);
    };
    const lock = async () => {
      resuming.current = true;
      clearCodes();
      try { await api.lock(); }
      catch (error) { if (!disposed) notify(errorText(error), true); }
      finally { resuming.current = false; if (!disposed) void refresh(); }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        accessEpoch.current += 1;
        if (mobile) {
          hiddenAt = Date.now();
          void api.background(true).catch(() => {});
          timer = setTimeout(() => { void lock(); }, 60_000);
        }
        return;
      }
      if (!mobile) { void refresh().then(() => window.dispatchEvent(new Event("steamguard:foreground-ready"))); return; }
      const expired = hiddenAt !== null && Date.now() - hiddenAt >= 60_000;
      hiddenAt = null;
      resuming.current = true;
      if (expired) clearCodes();
      void (async () => {
        try {
          // Native monotonic time covers a suspended WebView and wall-clock changes.
          await api.background(false);
          if (expired) await api.lock();
        } catch (error) {
          if (expired) await api.lock().catch(() => {});
          if (!disposed) notify(errorText(error), true);
        } finally {
          resuming.current = false;
          if (!disposed) void refresh().then(() => window.dispatchEvent(new Event("steamguard:foreground-ready")));
        }
      })();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh, notify]);
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
      Number(!!b.pinned) - Number(!!a.pinned) || (sort === "manual" ? 0 : sort === "type"
        ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name)),
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
  const lockVault = () => run(async () => {
    accessEpoch.current += 1;
    resuming.current = true;
    setTokens([]); setGroups([]);
    setStatus(current => current ? { ...current, locked: true, previewActive: false } : current);
    try { await api.lock(); }
    finally { resuming.current = false; }
  }, translate("保险库已锁定"));
  const copy = async (token: TokenView) => {
    if (!token.code || token.hotpReadOnly || document.hidden || resuming.current) return;
    const epoch = accessEpoch.current;
    try {
      const current = await api.currentCode(token.id);
      if (epoch !== accessEpoch.current || document.hidden || resuming.current) return;
      setTokens(previous => previous.map(item => item.id === token.id ? { ...item, ...current } : item));
      await navigator.clipboard.writeText(current.code.replaceAll(" ", ""));
      if (epoch !== accessEpoch.current || resuming.current) return;
      setCopied(token.id);
      setTimeout(() => { if (epoch === accessEpoch.current) setCopied(""); }, 1800);
    } catch (error) {
      if (epoch === accessEpoch.current) notify(translate("无法复制验证码：{{value1}}", { value1: errorText(error) }), true);
    }
  };
  const reorder = async (id: string, target: string) => {
    if (id === target) return;
    const ids = tokens.map(t => t.id);
    const from = ids.indexOf(id), to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1); ids.splice(to, 0, id);
    await run(() => api.reorderTokens(ids));
    setSort("manual");
  };
  const batch = async (action: "group" | "pin" | "delete", options?: { group?: string; pinned?: boolean }) => {
    const ids = [...selected];
    await run(async () => {
      await api.tokenBatch(action, ids, options);
      if (action === "delete") { notify(translate("已将 {{length}} 个令牌移入本机回收站", { length: ids.length }), false, ids); }
      setSelected([]); setSelecting(false); setBatchDelete(false);
    });
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

        <nav aria-label={translate("主导航")}>
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
                    <ArrowDownToLine size={16} />{translate("导出备份")}</button>
                  <button
                    className="button primary add-token"
                    aria-label={translate("添加令牌")}
                    disabled={!unlocked}
                    onClick={() => setImportOpen(true)}
                  >
                    <Plus size={17} />
                    <span>{translate("添加令牌")}</span>
                  </button>
                </>
              )}
              {page === "settings" && unlocked && (
                <button
                  className="button secondary"
                  onClick={() => void lockVault()}
                >
                  <LockKeyhole size={16} />{translate("锁定保险库")}</button>
              )}
            </div>
          </div>
          {!status ? (
            <div className="loading-state">
              <Spinner />
              <span>{translate("正在加载…")}</span>
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
                      <span>{translate("只读预览")}</span>
                      <button
                        className="button secondary"
                        onClick={() => setShowUnlock(true)}
                      >{translate("解锁")}</button>
                    </div>
                  )}
                  <div className="section-toolbar">
                    {hasSteam && (
                      <div className="token-tabs">
                        <button
                          className={filter === "all" ? "selected" : ""}
                          onClick={() => setFilter("all")}
                        >{translate("全部")}</button>
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
                        >{translate("其他令牌")}</button>
                      </div>
                    )}
                    <div className="toolbar-right">
                      <label className="search-box">
                        <Search size={16} />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder={translate("搜索")}
                          aria-label={translate("搜索令牌")}
                        />
                      </label>
                      <label className="sort-select" title={translate("排序")}>
                        <SlidersHorizontal size={16} />
                        <select
                          value={sort}
                          onChange={(e) => setSort(e.target.value)}
                          aria-label={translate("令牌排序")}
                        >
                          <option value="manual">{translate("手动排序")}</option>
                          <option value="name">{translate("按名称")}</option>
                          <option value="type">{translate("按类型")}</option>
                        </select>
                        <ChevronDown size={12} />
                      </label>
                    </div>
                  </div>
                  <div className="group-toolbar">
                    <label>
                      <FolderOpen size={17} />
                      <select
                        aria-label={translate("分组筛选")}
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                      >
                        <option value="all">{translate("全部分组")}</option>
                        <option value="ungrouped">{translate("未分组")}</option>
                        {groups.map((g) => (
                          <option key={g} value={"group:" + g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="icon-button"
                      aria-label={translate("管理分组")}
                      disabled={!unlocked}
                      onClick={() => setGroupsOpen(true)}
                    >
                      <Settings2 size={19} />
                    </button>
                  </div>
                  {unlocked && <div className="token-management-toolbar">
                    <button className="button text" disabled={busy || !tokens.length} onClick={() => { setSelecting(!selecting); setSelected([]); }}>{selecting ? translate("退出批量选择") : translate("批量管理")}</button>
                    <button className="button text" onClick={() => setTrashOpen(true)}>{translate("回收站")}</button>
                  </div>}
                  {selecting && <div className="batch-toolbar" role="region" aria-label={translate("批量管理令牌")}>
                    <label><input type="checkbox" aria-label={translate("选择当前筛选的全部令牌")} disabled={busy} ref={node => { if (node) node.indeterminate = visibleTokens.some(token => selected.includes(token.id)) && !visibleTokens.every(token => selected.includes(token.id)); }} checked={!!visibleTokens.length && visibleTokens.every(t => selected.includes(t.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...visibleTokens.map(t => t.id)])] : selected.filter(id => !visibleTokens.some(t => t.id === id)))} />{translate("已选 {{count}} 项", { count: selected.length })}</label>
                    <select aria-label={translate("批量目标分组")} disabled={busy} value={batchGroup} onChange={e => setBatchGroup(e.target.value)}><option value="">{translate("未分组")}</option>{groups.map(g => <option key={g}>{g}</option>)}</select>
                    <button className="button secondary" disabled={busy || !selected.length} onClick={() => void batch("group", { group: batchGroup })}>{translate("移至分组")}</button>
                    <button className="button secondary" disabled={busy || !selected.length} onClick={() => void batch("pin", { pinned: true })}>{translate("置顶")}</button>
                    <button className="button secondary" disabled={busy || !selected.length} onClick={() => void batch("pin", { pinned: false })}>{translate("取消置顶")}</button>
                    <button className="button text danger-text" disabled={busy || !selected.length} onClick={() => setBatchDelete(true)}>{translate("删除")}</button>
                  </div>}
                  {visibleTokens.filter(
                    (t) => filter !== "other" || t.kind !== "steam",
                  ).length ? (
                    <div className="token-grid">
                      {visibleTokens
                        .filter((t) => filter !== "other" || t.kind !== "steam")
                        .map((token) => (
                          <article className={`token-card ${selected.includes(token.id) ? "token-selected" : ""}`} key={token.id}
                            draggable={unlocked && !busy && sort === "manual" && !selecting}
                            onDragStart={e => { dragging.current = token.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", token.id); }}
                            onDragOver={e => { if (sort === "manual" && dragging.current) e.preventDefault(); }}
                            onDrop={e => { e.preventDefault(); if (dragging.current) void reorder(dragging.current, token.id); dragging.current = null; }}
                            onDragEnd={() => { dragging.current = null; }}>
                            {selecting && <label className="token-selection"><input type="checkbox" aria-label={translate("选择 {{name}}", { name: token.name })} disabled={busy} checked={selected.includes(token.id)} onChange={e => setSelected(e.target.checked ? [...selected, token.id] : selected.filter(id => id !== token.id))}/><span>{translate("选择")}</span></label>}
                            <div className="token-card-top">
                              <TokenIcon token={token} />
                              <div className="token-identity">
                                <h3>{token.pinned && <Pin size={12} aria-label={translate("已置顶")}/>}{token.name}</h3>
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
                                aria-label={translate("管理 {{name}}", { name: token.name })}
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
                                aria-label={translate("复制 {{name}} 验证码", { name: token.name })}
                              >
                                {token.hotpReadOnly
                                  ? translate("仅主设备")
                                  : token.code || "•••••"}
                              </button>
                              <button
                                className={`copy-button ${copied === token.id ? "copied" : ""}`}
                                aria-label={translate("复制验证码")}
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
                                aria-label={translate("剩余 {{remaining}} 秒", { remaining: token.remaining })}
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
                                    ? translate("计数 {{value1}}", { value1: token.counter ?? 0 })
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
                                      <LockKeyhole size={14} />{translate("解锁后连接")}</>
                                  ) : token.enrollmentPending ? (
                                    <>
                                      <Clock3 size={12} />{translate("继续激活")}</>
                                  ) : token.loggedIn ? (
                                    <>
                                      <span className="status-dot" />{translate("已登录")}</>
                                  ) : (
                                    <>
                                      <LogIn size={12} />{translate("连接 Steam")}</>
                                  )}
                                </button>
                              ) : token.kind === "hotp" ? (
                                <button
                                  className="session-link"
                                  disabled={!unlocked || token.hotpReadOnly}
                                  onClick={() =>
                                    void run(() => api.nextHotp(token.id))
                                  }
                                >{translate("下一验证码")}<ArrowRight size={12} />
                                </button>
                              ) : null}
                            </div>
                          </article>
                        ))}
                    </div>
                  ) : tokens.length ? (
                    <div className="empty-state compact">
                      <Search size={28} />
                      <h2>{translate("没有找到匹配的令牌")}</h2>

                      <button
                        className="button secondary"
                        onClick={() => {
                          setSearch("");
                          setFilter("all");
                          setGroupFilter("all");
                        }}
                      >{translate("清除筛选")}</button>
                    </div>
                  ) : (
                    <div className="tokens-empty">
                      <h2>{translate("暂无令牌")}</h2>
                      <button
                        className="button primary"
                        disabled={!unlocked}
                        onClick={() => setImportOpen(true)}
                      >
                        <Plus size={17} />{translate("添加令牌")}</button>
                    </div>
                  )}
                </>
              )}
              {(page === "confirmations" || page === "market") && (
                <>
                  <div className="account-toolbar">
                    <div>
                      <label htmlFor="steam-account">{translate("当前 Steam 账户")}</label>
                      <div className="account-select">
                        <SteamMark small />
                        <select
                          id="steam-account"
                          value={active?.id ?? ""}
                          onChange={(e) => setAccount(e.target.value)}
                        >
                          {!steamTokens.length && (
                            <option value="">{translate("暂无 Steam 令牌")}</option>
                          )}
                          {steamTokens.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                              {t.loggedIn ? translate(" · 已登录") : translate(" · 未登录")}
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
                          <LogIn size={16} />{translate("登录 Steam")}</button>
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
                        {busy ? <Spinner /> : <RefreshCw size={15} />}{translate("刷新")}{page === "market" ? translate("市场") : translate("确认")}
                      </button>
                    </div>
                  </div>
                  {!active ? (
                    <div className="empty-state">
                      <SteamMark />
                      <h2>{translate("先添加一个 Steam 令牌")}</h2>
                      <p>{translate("导入包含 Steam 身份密钥的令牌，再登录账户即可使用此功能。")}</p>
                      <button
                        className="button primary"
                        onClick={() => setImportOpen(true)}
                      >
                        <Plus size={16} />{translate("导入 Steam 令牌")}</button>
                    </div>
                  ) : !active.loggedIn ? (
                    <div className="empty-state">
                      <span className="empty-state-icon">
                        <LogIn size={30} />
                      </span>
                      <h2>{translate("连接你的 Steam 账户")}</h2>
                      <p>{translate("登录后即可查看{{value1}}。", { value1: page === "market"
                          ? translate("社区市场在售物品")
                          : translate("待处理的交易与市场确认") })}</p>
                      <button
                        className="button primary"
                        onClick={() => setLoginToken(active)}
                      >{translate("登录")}{active.name}
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
                              <span className="eyebrow">{translate("待你确认")}</span>
                              <h3>{item.headline}</h3>
                              <p>
                                {item.summary?.join(" · ") ||
                                  translate("确认编号 {{id}}", { id: item.id })}
                              </p>
                              {item.creationTime > 0 && (
                                <small>
                                  {formatDateTime(item.creationTime * 1000)}
                                </small>
                              )}
                            </div>
                            <div className="confirmation-actions">
                              <button
                                className="button secondary danger-text"
                                onClick={() =>
                                  setAction({ item, approve: false })
                                }
                              >{translate("拒绝")}</button>
                              <button
                                className="button primary"
                                onClick={() =>
                                  setAction({ item, approve: true })
                                }
                              >{translate("查看并确认")}<ArrowRight size={14} />
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
                            ? translate("目前没有待确认的交易")
                            : translate("查看待处理的交易")}
                        </h2>
                        <p>
                          {confirmationLoaded
                            ? translate("新的交易或市场上架确认会在刷新后显示。")
                            : translate("从 Steam 获取确认列表，再逐笔核对交易信息。")}
                        </p>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void loadConfirmations()}
                        >
                          {busy ? <Spinner /> : <RefreshCw size={15} />}{translate("获取交易确认")}</button>
                      </div>
                    )
                  ) : (
                    <>
                      <div className="market-intro">
                        <span className="market-intro-icon">
                          <ShoppingBag size={26} />
                        </span>
                        <div>
                          <h3>{translate("你的社区市场")}</h3>
                          <p>
                            {market?.walletBalance
                              ? translate("钱包余额 {{walletBalance}}", { walletBalance: market.walletBalance })
                              : translate("在这里查看在售物品，前往 Steam 完成市场操作。")}
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
                        >{translate("打开社区市场")}<ArrowUpRight size={15} />
                        </button>
                      </div>
                      {market?.items.length ? (
                        <div className="market-table">
                          <div className="market-table-head">
                            <span>{translate("在售物品")}</span>
                            <span>{translate("数量")}</span>
                            <span>{translate("价格")}</span>
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
                                  <small>{item.game || translate("Steam 社区市场")}</small>
                                </div>
                              </div>
                              <span>{item.quantity ?? 1}</span>
                              <strong className="market-price">
                                {item.price || "—"}
                              </strong>
                              <button
                                className="icon-button"
                                aria-label={translate("查看 {{name}}", { name: item.name })}
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
                            {market ? translate("当前没有在售物品") : translate("查看你的在售物品")}
                          </h2>
                          <p>
                            {market?.message ||
                              translate("刷新以获取当前账户的社区市场信息。")}
                          </p>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void loadMarket()}
                          >
                            {busy ? <Spinner /> : <RefreshCw size={15} />}{translate("获取市场列表")}</button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {page === "settings" && (
                <div className="settings-grid">
                  <SettingsDisclosure title={translate("多端同步")}>
                    <SyncPanel tokens={tokens} onChange={refresh} />
                  </SettingsDisclosure>
                  <SettingsDisclosure title={translate("自动备份")}>
                    <BackupPanel onChange={refresh} />
                  </SettingsDisclosure>
                  <PasswordSettings onChange={refresh} />
                  <QuickAccessSettings status={status} onChange={refresh} />
                  <DesktopSettings />
                  <AppearanceSettings />
                  <LanguageSettings />
                  <UpdateSettings />
                  <section className="settings-panel">
                    <div className="panel-title">
                      <h2>{translate("导入与导出")}</h2>
                    </div>
                    <div className="setting-row">
                      <h3>{translate("加密备份")}</h3>
                      <button
                        className="button secondary"
                        disabled={!tokens.length}
                        onClick={() => setExportOpen(true)}
                      >
                        <Download size={15} />{translate("导出")}</button>
                    </div>
                    <div className="setting-row"><h3>{translate("迁移二维码")}</h3><button className="button secondary" disabled={!tokens.some(token => token.kind !== "steam")} onClick={() => setBatchExportOpen(true)}><QrCode size={15}/>{translate("选择令牌")}</button></div>
                    <div className="setting-row">
                      <h3>{translate("导入令牌或备份")}</h3>
                      <button
                        className="button secondary"
                        onClick={() => setImportOpen(true)}
                      >
                        <Upload size={15} />{translate("导入")}</button>
                    </div>
                  </section>
                  {hasSteam && (
                    <SettingsDisclosure title="Steam">
                      <section className="settings-panel">
                        <div className="panel-title">
                          <h2>Steam</h2>
                        </div>
                        <div className="setting-row">
                          <h3>{translate("同步 Steam 时间")}</h3>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.syncTime(), translate("时间已同步"))
                            }
                          >
                            {busy ? <Spinner /> : <RefreshCw size={15} />}{translate("同步")}</button>
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
                          ? translate("开源双重验证器，支持通用 OTP、Steam 令牌、交易确认与社区市场。")
                          : translate("开源双重验证器，支持 TOTP 与 HOTP。")}
                      </p>
                      <a
                        className="text-button"
                        href="/third-party-notices.txt"
                        onClick={(event) => {
                          event.preventDefault();
                          setLicensesOpen(true);
                        }}
                      >{translate("开源许可")}</a>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label={translate("移动端导航")}>
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
          {!!notification.undo?.length && !notification.error && <button onClick={() => void run(async () => { await api.trashRestore(notification.undo!); }, translate("已撤销删除"))}>{translate("撤销")}</button>}
          <button onClick={() => setNotification(null)} aria-label={translate("关闭提示")}>
            <X size={15} />
          </button>
        </div>
      )}
      {licensesOpen && (
        <Modal title={translate("开源许可")} onClose={() => setLicensesOpen(false)} wide>
          <pre className="license-text">{licenseText || translate("加载中…")}</pre>
        </Modal>
      )}
      {trashOpen && <TrashBrowser onClose={() => setTrashOpen(false)} onChange={refresh} />}
      {batchDelete && <Modal title={translate("删除所选令牌？")} onClose={() => { if (!busy) setBatchDelete(false); }}><p className="dialog-intro">{translate("将 {{length}} 个令牌移入本机回收站，可撤销或稍后还原。Steam 登录会话会被移除。", { length: selected.length })}</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setBatchDelete(false)}>{translate("取消")}</button><button className="button danger" disabled={busy} onClick={() => void batch("delete")}>{translate("移入回收站")}</button></div></Modal>}
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
          groups={groups}
          onLogin={() => {
            setImportOpen(false);
            setLoginToken({
              id: "new-account",
              name: translate("添加 Steam 令牌"),
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
            notify(translate("导入完成"));
          }}
        />
      )}
      {loginToken && (
        <LoginDialog
          token={loginToken}
          onClose={closeLogin}
          onComplete={async () => {
            await refresh();
            notify(translate("Steam 会话已更新"));
          }}
        />
      )}
      {editToken && (
        <EditDialog
          token={editToken}
          groups={groups}
          onDeleted={() => { notify(translate("令牌已移入本机回收站"), false, [editToken.id]); }}
          onMove={async direction => { const index = tokens.findIndex(t => t.id === editToken.id); const other = tokens[index + direction]; if (other) await reorder(editToken.id, other.id); }}
          canMoveUp={tokens.findIndex(t => t.id === editToken.id) > 0}
          canMoveDown={tokens.findIndex(t => t.id === editToken.id) < tokens.length - 1}
          onClose={closeEdit}
          onComplete={async () => {
            setEditToken(null);
            await refresh();
          }}
        />
      )}
      {batchExportOpen && <BatchQrExport tokens={tokens} onClose={() => setBatchExportOpen(false)} />}
      {exportOpen && (
        <ExportDialog
          onClose={closeExport}
          onComplete={(path) => {
            setExportOpen(false);
            if (path) notify(translate("备份已导出：{{path}}", { path: path }));
          }}
        />
      )}
      {action && (
        <Modal
          title={action.approve ? translate("确认这笔交易？") : translate("拒绝这笔交易？")}
          eyebrow="STEAM CONFIRMATION"
          onClose={closeAction}
        >
          <div className="review-summary">
            <ShoppingBag size={25} />
            <h3>{action.item.headline}</h3>
            <p>{action.item.summary?.join(" · ")}</p>
            <small>{translate("确认编号 {{id}}", { id: action.item.id })}</small>
          </div>
          <p className="form-hint">{translate("请核对交易内容。此操作将直接提交至 Steam。")}</p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeAction}
            >{translate("返回核对")}</button>
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
                  action.approve ? translate("已确认交易") : translate("已拒绝交易"),
                );
              }}
            >
              {busy ? <Spinner /> : <Check size={16} />}
              {action.approve ? translate("确认提交") : translate("拒绝交易")}
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
      notify(translate("两次输入的密码不一致"), true);
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
        <h2>{initialized ? translate("解锁") : translate("设置密码")}</h2>
        {initialized && (biometricEnabled || previewEnabled) && (
          <div className="quick-gate-actions">
            {biometricEnabled && (
              <button
                className="button primary full-width"
                onClick={() => void quick(true)}
                disabled={busy}
              >
                {busy ? <Spinner /> : <Fingerprint size={21} />}{translate("指纹 / Face ID 解锁")}</button>
            )}
            {previewEnabled && (
              <button
                className="button secondary full-width"
                onClick={() => void quick(false)}
                disabled={busy}
              >{translate("预览令牌")}<ArrowRight size={17} />
              </button>
            )}
            <span className="access-divider">{translate("或使用主密码")}</span>
          </div>
        )}
        <form onSubmit={(e) => void submit(e)}>
          <label className="field-label" htmlFor="vault-password">
            {initialized ? translate("解锁密码") : translate("设置解锁密码")}
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
              placeholder={initialized ? translate("输入密码") : translate("至少 8 位")}
            />
          </div>
          {!initialized && (
            <>
              <label className="field-label" htmlFor="vault-repeat">{translate("确认密码")}</label>
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
                  placeholder={translate("再次输入解锁密码")}
                />
              </div>
            </>
          )}
          <button className="button primary full-width" disabled={busy}>
            {busy ? <Spinner /> : <ShieldCheck size={17} />}
            {initialized ? translate("解锁保险库") : translate("创建保险库")}
            <ArrowRight size={16} />
          </button>
        </form>
        <LanguageSettings compact />
        {hasBackups && (
          <button
            className="text-button backup-gate-button"
            onClick={() => setBackupsOpen(true)}
          >{translate("查看本机自动备份")}</button>
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
  groups,
  onClose,
  onComplete,
  onLogin,
}: {
  onClose: () => void;
  onComplete: () => Promise<void>;
  onLogin: () => void;
  hasSteam: boolean;
  groups: string[];
}) {
  const [mode, setMode] = useState<"file" | "text" | "qr" | "manual">("file");
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
        throw new Error(translate("请选择不超过 10 MB 的令牌文件"));
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
          ? translate("确认导入令牌")
          : mode === "qr"
            ? translate("扫描验证器二维码")
            : translate("把令牌带到这里")
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
                  ? translate("识别到 {{length}} 个令牌", { length: preview.tokens.length })
                  : translate("合并已有令牌信息")}
              </strong>
              {!!preview.groupCount && (
                <p className="form-hint">{translate("备份包含 {{groupCount}} 个分组，已有令牌的缺失分组可一并补回。", { groupCount: preview.groupCount })}</p>
              )}
              <p>
                {preview.duplicates
                  ? translate("{{duplicates}} 个已有令牌将保留，可补充分组与 HOTP 计数", { duplicates: preview.duplicates })
                  : translate("确认后保存到本机加密保险库")}
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
            >{translate("返回")}</button>
            <button
              className="button primary"
              disabled={
                busy || !(preview.canCommit ?? preview.tokens.length > 0)
              }
              onClick={() => void commit()}
            >
              {busy ? <Spinner /> : <ShieldCheck size={16} />}{translate("确认导入")}</button>
          </div>
        </>
      ) : (
        <>
          {mode !== "qr" &&
            (hasSteam ? (
              <button className="steam-login-import" onClick={onLogin}>
                <SteamMark small />
                <span>{translate("登录 Steam 添加令牌")}</span>
                <ArrowRight size={16} />
              </button>
            ) : (
              <details className="additional-import">
                <summary>{translate("其他添加方式")}</summary>
                <button className="button secondary" onClick={onLogin}>{translate("添加 Steam 令牌")}</button>
              </details>
            ))}
          <div className="dialog-tabs import-tabs">
            <button className={mode === "manual" ? "selected" : ""} onClick={() => setMode("manual")}><Plus size={15}/>{translate("手动添加")}</button>
            <button
              className={mode === "qr" ? "selected" : ""}
              onClick={() => setMode("qr")}
            >
              <QrCode size={15} />{translate("扫码 / 图片")}</button>
            <button
              className={mode === "file" ? "selected" : ""}
              onClick={() => setMode("file")}
            >
              <FileKey2 size={15} />{translate("从文件导入")}</button>
            <button
              className={mode === "text" ? "selected" : ""}
              onClick={() => setMode("text")}
            >
              <KeyRound size={15} />{translate("粘贴密钥 / 链接")}</button>
          </div>
          {mode === "manual" ? <ManualTokenForm groups={groups} onComplete={onComplete} /> : mode === "qr" ? (
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
                      {file ? file.name : translate("选择文件，或拖放到这里")}
                    </strong>
                    <span>
                      {file
                        ? translate("{{value1}} KB · 点击重新选择", { value1: (file.size / 1024).toFixed(1) })
                        : "WattToolkit · Steam · Aegis · 2FAS · JSON"}
                    </span>
                  </button>
                </>
              ) : (
                <>
                  <label className="field-label" htmlFor="import-text">{translate("OTP 链接或令牌 JSON")}</label>
                  <textarea
                    id="import-text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={5}
                    placeholder={translate("otpauth://totp/… 或粘贴 Steam maFile JSON")}
                    spellCheck={false}
                  />
                </>
              )}
              <label className="field-label" htmlFor="import-password">{translate("备份密码")}<span>{translate("（如已设置）")}</span>
              </label>
              <input
                id="import-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={translate("未加密的备份可留空")}
              />
              <p className="form-hint">
                <LockKeyhole size={13} />{translate("启用原设备保护的 .mpo 需要先在原设备导出可迁移备份。")}</p>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button className="button secondary" onClick={onClose}>{translate("取消")}</button>
                <button
                  className="button primary"
                  disabled={busy || (mode === "file" ? !file : !text.trim())}
                  onClick={() => void check()}
                >
                  {busy ? <Spinner /> : <ArrowRight size={16} />}{translate("预览令牌")}</button>
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
      <Modal title={translate("Steam 网络设置")} onClose={close}>
        <SteamNetworkPanel />
        <div className="modal-actions">
          <button
            className="button secondary"
            onClick={() => setNetworkOpen(false)}
          >{translate("返回登录")}</button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={isNew ? translate("添加 Steam 令牌") : translate("Steam 账户")}
      eyebrow="CONNECT YOUR ACCOUNT"
      onClose={close}
    >
      <div className="login-account">
        <SteamMark />
        <div>
          <strong>{token.name}</strong>
          <span>
            {result?.steamId || token.steamId || translate("通过 Steam 官方认证接口登录")}
          </span>
        </div>
        {authenticated && <span className="secure-tag">{translate("已登录")}</span>}
      </div>
      {!isNew && (
        <p className="form-hint">{translate("当前令牌账号：{{value1}} · SteamID：{{value2}}", { value1: token.accountName || translate("未记录"), value2: token.steamId && !/^0+$/.test(token.steamId)
            ? token.steamId
            : translate("未关联，使用当前令牌验证成功后补全") })}</p>
      )}
      {activation ? (
        <>
          <p className="dialog-intro">{translate("令牌密钥已加密保存。输入 Steam 发往 {{value1}} 的短信验证码，完成激活。", { value1: enrollment?.phoneHint || translate("绑定手机") })}</p>
          {enrollment?.revocationCode && (
            <div className="recovery-box">
              <strong>{translate("请妥善保存恢复代码")}</strong>
              <code>{enrollment.revocationCode}</code>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={recoverySaved}
                  onChange={(e) => setRecoverySaved(e.target.checked)}
                />{translate("我已将恢复代码保存在安全位置")}</label>
            </div>
          )}
          <label className="field-label" htmlFor="activation-sms">{translate("短信激活码")}</label>
          <input
            id="activation-sms"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={sms}
            onChange={(e) => setSms(e.target.value)}
            placeholder={translate("Steam 短信验证码")}
          />
          <div className="modal-actions">
            <button className="button secondary" onClick={close}>{translate("稍后激活")}</button>
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
              {busy ? <Spinner /> : <ShieldCheck size={16} />}{translate("激活令牌")}</button>
          </div>
        </>
      ) : authenticated ? (
        <>
          {isNew && tool === "none" && (
            <>
              <p className="dialog-intro">{translate("登录已完成。请选择账号当前的令牌状态，继续添加本地令牌。")}</p>
              <div className="account-tool-grid">
                <button onClick={() => setTool("enroll")}>
                  <Plus size={20} />
                  <strong>{translate("绑定新令牌")}</strong>
                  <span>{translate("账号尚未启用手机令牌")}</span>
                </button>
                <button onClick={() => setTool("transfer")}>
                  <Smartphone size={20} />
                  <strong>{translate("短信转移现有令牌")}</strong>
                  <span>{translate("从原手机转移到本机")}</span>
                </button>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void request(() =>
                    api.external("https://store.steampowered.com/phone/manage"),
                  )
                }
              >{translate("管理 Steam 绑定手机号")}<ArrowUpRight size={13} />
              </button>
            </>
          )}
          {tool === "enroll" && !enrollment && (
            <>
              <p className="dialog-intro">{translate("此操作会在 Steam 账号上创建手机令牌，并向已绑定的手机号发送激活短信。完成后请保存恢复代码和加密备份。")}</p>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >{translate("返回")}</button>
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
                  {busy ? <Spinner /> : <Plus size={16} />}{translate("创建并发送短信")}</button>
              </div>
            </>
          )}
          {tool === "transfer" && (
            <>
              {enrollment ? (
                <>
                  <div className="recovery-box">
                    <strong>{translate("令牌已转移，请保存恢复代码")}</strong>
                    <code>{enrollment.revocationCode}</code>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={recoverySaved}
                        onChange={(e) => setRecoverySaved(e.target.checked)}
                      />{translate("我已保存恢复代码")}</label>
                  </div>
                  <p className="dialog-intro">{translate("新令牌已加密保存在本机。请在设置中导出一份加密备份。")}</p>
                  <div className="modal-actions">
                    <button
                      className="button primary"
                      disabled={!recoverySaved}
                      onClick={() => void finish()}
                    >
                      <Check size={16} />{translate("完成")}</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="dialog-intro">{translate("使用 Steam 绑定手机的短信验证码转移现有令牌。提交验证码后，原手机的令牌将被替换，Steam 可能对交易施加冷却限制。")}</p>
                  {transferStarted && (
                    <>
                      <label className="field-label" htmlFor="transfer-sms">{translate("短信验证码")}</label>
                      <input
                        id="transfer-sms"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={sms}
                        onChange={(e) => setSms(e.target.value)}
                        placeholder={translate("输入短信验证码")}
                      />
                    </>
                  )}
                  <div className="modal-actions">
                    <button
                      className="button secondary"
                      onClick={() => setTool("none")}
                    >{translate("返回")}</button>
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
                      {transferStarted ? translate("确认转移令牌") : translate("发送转移短信")}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {tool === "approve" && (
            <>
              <p className="dialog-intro">{translate("粘贴 Steam 电脑端登录二维码中的链接，先核对设备和位置，再决定是否批准。")}</p>
              <label className="field-label" htmlFor="qr-request">{translate("Steam 登录二维码链接")}</label>
              <SteamQrScanner onScan={value => { setQrUrl(value); setQrInfo(null); }} />
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
                    {String(qrInfo.deviceFriendlyName || translate("Steam 登录设备"))}
                  </h3>
                  <p>{translate("设备平台 {{value1}}", { value1: String(qrInfo.platformType ?? translate("未知")) })}</p>
                  <p>
                    {[qrInfo.city, qrInfo.state, qrInfo.country, qrInfo.ip]
                      .filter(Boolean)
                      .map(String)
                      .join(" · ")}
                  </p>
                  {!!qrInfo.locationMismatch && (
                    <p className="danger-text">{translate("登录位置与近期使用位置不一致，请仔细核对。")}</p>
                  )}
                  {!!qrInfo.highUsageLogin && (
                    <p className="danger-text">{translate("Steam 标记此请求为频繁登录，请核对是否由你发起。")}</p>
                  )}
                </div>
              )}
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >{translate("返回")}</button>
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
                    >{translate("拒绝")}</button>
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
                      {busy ? <Spinner /> : <Check size={16} />}{translate("批准登录")}</button>
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
                    {busy ? <Spinner /> : <ScanLine size={16} />}{translate("核对登录请求")}</button>
                )}
              </div>
            </>
          )}
          {tool === "remove" && (
            <>
              <div className="delete-warning">
                <Shield size={28} />
                <h3>{translate("解除 Steam 手机令牌")}</h3>
                <p>{translate("此操作会关闭账号上的手机令牌保护。删除本地令牌不会解除远端绑定；请仅在确实需要解绑时继续。")}</p>
              </div>
              <label className="field-label" htmlFor="remove-recovery">{translate("Steam 恢复代码")}</label>
              <input
                id="remove-recovery"
                value={revocation}
                onChange={(e) => setRevocation(e.target.value)}
                autoComplete="off"
                placeholder={translate("R 开头的恢复代码")}
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={removeChecked}
                  onChange={(e) => setRemoveChecked(e.target.checked)}
                />{translate("我确认解除此账号的 Steam 手机令牌保护")}</label>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setTool("none")}
                >{translate("返回")}</button>
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
                  {busy ? <Spinner /> : <Trash2 size={16} />}{translate("确认解除令牌")}</button>
              </div>
            </>
          )}
          {!isNew && tool === "none" && (
            <>
              <p className="dialog-intro">{translate("此账户已建立 Steam 会话，可以读取交易确认和市场信息。")}</p>
              <div className="account-tool-grid">
                <button onClick={() => setTool("approve")}>
                  <ScanLine size={20} />
                  <strong>{translate("批准二维码登录")}</strong>
                  <span>{translate("核对并批准电脑端登录请求")}</span>
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
                  <strong>{translate("管理绑定手机号")}</strong>
                  <span>{translate("前往 Steam 官方页面")}</span>
                </button>
              </div>
              <button
                className="text-button danger-text"
                onClick={() => setTool("remove")}
              >{translate("解除 Steam 手机令牌")}</button>
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
                  <LogOut size={15} />{translate("退出会话")}</button>
                <button className="button primary" onClick={close}>{translate("完成")}</button>
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
                <KeyRound size={15} />{translate("账号密码")}</button>
              <button
                className={mode === "qr" ? "selected" : ""}
                onClick={() => {
                  setMode("qr");
                  void request(async () =>
                    acceptStatus(await api.qrLogin(token.id)),
                  );
                }}
              >
                <QrCode size={15} />{translate("二维码登录")}</button>
            </div>
          )}
          {mode === "qr" ? (
            <div className="qr-login-panel">
              {qrImage ? (
                <img
                  src={qrImage}
                  alt={translate("Steam 登录二维码，请使用 Steam 手机应用扫描")}
                  width={264}
                  height={264}
                />
              ) : (
                <div className="qr-placeholder">
                  <QrCode size={64} />
                </div>
              )}
              <p>{translate("使用 Steam 手机应用扫描，并在手机上批准登录。")}</p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void request(async () =>
                    acceptStatus(await api.qrLogin(token.id)),
                  )
                }
              >
                <RefreshCw size={15} />{translate("刷新二维码")}</button>
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
                      ? translate("验证码已提交，正在等待 Steam 完成登录。")
                      : translate("请完成 Steam 返回的验证方式：令牌验证码、邮箱验证码或手机应用批准。")}
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
                        <ShieldCheck size={16} />{translate("使用当前令牌验证")}</button>
                      <p className="form-hint">{translate("使用 Steam 服务器时间生成最新验证码并直接提交，无需复制；邮箱验证仍需输入邮件中的验证码。")}</p>
                    </div>
                  )}
                  {canSubmitCode && (
                    <>
                      <label className="field-label" htmlFor="guard-type">{translate("验证方式")}</label>
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
                                ? translate("Steam 令牌验证码")
                                : translate("邮箱验证码 {{associatedMessage}}", { associatedMessage: g.associatedMessage })}
                            </option>
                          ))}
                      </select>
                      <label className="field-label" htmlFor="guard-code">{translate("验证码")}</label>
                      <input
                        id="guard-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="one-time-code"
                        placeholder={translate("输入 Steam 验证码")}
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
                    <RefreshCw size={14} />{translate("已在手机批准，检查登录状态")}</button>
                </>
              ) : (
                <>
                  <p className="dialog-intro">{translate("密码仅用于向 Steam 建立登录会话，不会存入保险库。")}</p>
                  <label className="field-label" htmlFor="steam-username">{translate("Steam 账户名")}</label>
                  <input
                    id="steam-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    placeholder={translate("用于登录的账户名")}
                  />
                  <label className="field-label" htmlFor="steam-password">{translate("密码")}</label>
                  <input
                    id="steam-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    placeholder={translate("Steam 账户密码")}
                  />
                </>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={close}
                >{translate("取消")}</button>
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
                      ? translate("提交验证码")
                      : translate("检查登录状态")
                    : translate("登录")}
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
            >{translate("重新输入账号")}</button>
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
              >{translate("返回密码登录")}</button>
              <button
                className="button primary"
                disabled={busy || !awaiting}
                onClick={() =>
                  void request(async () =>
                    acceptStatus(await api.poll(token.id)),
                  )
                }
              >
                {busy ? <Spinner /> : <RefreshCw size={15} />}{translate("检查登录状态")}</button>
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
            <Globe2 size={15} />{translate("检查网络与代理")}</button>
        </>
      )}
    </Modal>
  );
}

function EditDialog({
  token,
  onDeleted, onMove, canMoveUp, canMoveDown,
  groups,
  onClose,
  onComplete,
}: {
  token: TokenView;
  onDeleted: () => void;
  onMove: (direction: number) => Promise<void>;
  canMoveUp: boolean; canMoveDown: boolean;
  groups: string[];
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const [icon, setIcon] = useState(token.icon ?? null);
  const [pickIcon, setPickIcon] = useState(false);
  const [name, setName] = useState(token.name);
  const [group, setGroup] = useState(token.group ?? "");
  const [parameters, setParameters] = useState<TokenParameters>({ issuer: token.issuer, algorithm: token.algorithm ?? "SHA1", digits: token.digits ?? 6, period: token.period || 30, counter: token.counter ?? 0, pinned: !!token.pinned });
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
          }, token.kind === "steam" ? { pinned: parameters.pinned } : { ...parameters, period: token.kind === "totp" ? parameters.period : undefined, counter: token.kind === "hotp" && !token.hotpReadOnly && parameters.counter !== token.counter ? parameters.counter : undefined }));
      if (remove) onDeleted();
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
      if (path) setExported(translate("已导出：{{path}}", { path: path }));
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
          ? translate("选择头像")
          : deleting
            ? translate("删除这个令牌？")
            : showQr
              ? translate("令牌迁移二维码")
              : translate("管理令牌")
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
          <p>{translate("此令牌将移入本机回收站，可撤销或稍后还原。Steam 登录会话会被移除。")}</p>
        </div>
      ) : showQr ? (
        <>
          <p className="dialog-intro">{translate("二维码包含令牌密钥。仅在受信任的设备上扫描，不要分享或截图发送给他人。")}</p>
          <div className="qr-login-panel">
            <img
              src={qrImage}
              alt={translate("包含令牌密钥的迁移二维码")}
              width={260}
              height={260}
            />
          </div>
          <button
            className="button secondary full-width"
            onClick={() =>
              void navigator.clipboard
                .writeText(uri)
                .catch(() => setError(translate("无法复制链接")))
            }
          >
            <Copy size={15} />{translate("复制 OTP 链接")}</button>
        </>
      ) : (
        <>
          <div className="login-account">
            <button
              className="avatar-edit"
              aria-label={translate("更换头像")}
              onClick={() => setPickIcon(true)}
            >
              <TokenAvatar token={token} icon={icon} />
              <span>{translate("更换头像")}</span>
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
          <label className="field-label" htmlFor="token-name">{translate("显示名称")}</label>
          <input
            id="token-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="field-label" htmlFor="token-group">{translate("分组")}</label>
          <select
            id="token-group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            disabled={busy}
          >
            <option value="">{translate("未分组")}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <label className="sync-choice"><input type="checkbox" checked={!!parameters.pinned} disabled={busy} onChange={e => setParameters({ ...parameters, pinned: e.target.checked })}/><span>{translate("置顶显示")}</span></label>
          <div className="manual-order-actions"><span>{translate("手动排序")}</span><button className="button secondary" disabled={busy || !canMoveUp} onClick={() => void onMove(-1)}><ArrowUp size={15}/>{translate("上移")}</button><button className="button secondary" disabled={busy || !canMoveDown} onClick={() => void onMove(1)}><ArrowDown size={15}/>{translate("下移")}</button></div>
          {token.kind !== "steam" && <><label className="field-label" htmlFor="token-issuer">{translate("服务名称")}</label><input id="token-issuer" value={parameters.issuer ?? ""} disabled={busy} maxLength={120} onChange={e => setParameters({ ...parameters, issuer: e.target.value })}/><OtpParameters kind={token.kind} value={parameters} onChange={setParameters} disabled={busy} counterReadOnly={token.hotpReadOnly}/></>}
          <details className="token-details">
            <summary>{translate("令牌详情")}</summary>
            <div className="token-metadata">
              <span>{translate("类型")}<strong>{token.kind.toUpperCase()}</strong>
              </span>
              <span>{translate("周期")}<strong>{translate("{{period}} 秒", { period: token.period })}</strong>
              </span>
              {token.algorithm && (
                <span>{translate("算法")}<strong>{token.algorithm}</strong>
                </span>
              )}
            </div>
          </details>
          <div className="account-tool-grid">
            <button disabled={busy} onClick={() => void revealQr()}>
              <QrCode size={20} />
              <strong>{translate("迁移二维码")}</strong>
              <span>{translate("显示 OTP 密钥链接")}</span>
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void exportToken(token.kind === "steam" ? "mafile" : "otpauth")
              }
            >
              <Download size={20} />
              <strong>
                {token.kind === "steam" ? translate("导出 maFile") : translate("导出 OTP 链接")}
              </strong>
              <span>{translate("包含密钥的明文文件")}</span>
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
              >{translate("返回")}</button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void act(true)}
              >
                {busy ? <Spinner /> : <Trash2 size={15} />}{translate("确认删除")}</button>
            </>
          ) : showQr ? (
            <button
              className="button secondary"
              onClick={() => {
                setShowQr(false);
                setUri("");
                setQrImage("");
              }}
            >{translate("隐藏密钥并返回")}</button>
          ) : (
            <>
              <button
                className="button text danger-text"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={15} />{translate("删除令牌")}</button>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
                onClick={() => void act(false)}
              >
                {busy ? <Spinner /> : <Check size={15} />}{translate("保存")}</button>
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
      setError(translate("两次输入的密码不一致"));
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
    <Modal title={translate("导出加密备份")} eyebrow="KEEP A SAFE COPY" onClose={onClose}>
      <p className="dialog-intro">{translate("为备份设置独立密码，并与备份文件分开保管。")}</p>
      <form onSubmit={(e) => void submit(e)}>
        <label className="field-label" htmlFor="export-format">{translate("备份格式")}</label>
        <select
          id="export-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as "sgvault" | "mpo")}
        >
          <option value="sgvault">{translate("SteamGuard 加密备份（.sgvault）")}</option>
          <option value="mpo">{translate("Watt Toolkit 原始格式（.mpo）")}</option>
        </select>
        <p className="form-hint">
          {format === "sgvault"
            ? translate("使用 Argon2id 与 AES-GCM 加密，可包含本地登录会话。")
            : translate("兼容 Watt Toolkit V2，使用原格式的二级密码保护。")}
        </p>
        <label className="field-label" htmlFor="export-password">{translate("备份密码")}</label>
        <input
          id="export-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={translate("至少 8 位")}
        />
        <label className="field-label" htmlFor="export-repeat">{translate("确认密码")}</label>
        <input
          id="export-repeat"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          placeholder={translate("再次输入备份密码")}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>{translate("取消")}</button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Download size={16} />}{translate("选择位置并导出")}</button>
        </div>
      </form>
    </Modal>
  );
}
