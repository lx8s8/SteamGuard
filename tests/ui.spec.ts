import { expect, test, type Page } from "@playwright/test";
import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import {
  googlePages,
  googleV2Pages,
  otherBatchPage,
  qrPages,
  ordinaryQr,
  type QrPageFixture,
} from "./qr-fixtures";

// Synthetic data only. These UI tests do not contact Steam or load private exports.
async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("steamguard.language", "zh-CN");
    const tokens = [
      {
        icon: null as string | null,
        group: null as string | null,
        id: "steam-test",
        name: "测试 · Steam",
        issuer: "Steam",
        kind: "steam",
        code: "ABCDE",
        period: 30,
        remaining: 24,
        loggedIn: true,
        steamId: "76561198000000000",
        accountName: "fixture-account",
        hasIdentitySecret: true,
      },
      {
        icon: null as string | null,
        group: null as string | null,
        id: "steam-offline",
        name: "测试 · 待登录",
        issuer: "Steam",
        kind: "steam",
        code: "FGHJK",
        period: 30,
        remaining: 24,
        loggedIn: false,
        accountName: "fixture-offline",
      },
      {
        icon: null as string | null,
        group: null as string | null,
        id: "totp-test",
        name: "测试 · 通用 OTP",
        issuer: "Example",
        kind: "totp",
        code: "123456",
        period: 30,
        remaining: 24,
        loggedIn: false,
      },
    ];
    const trash: (typeof tokens[number] & { deletedAt: number })[] = [];
    const syncScenario = new URLSearchParams(location.search).get("sync");
    const cloudScenario = new URLSearchParams(location.search).get("cloud");
    const cloudLibraries =
      cloudScenario === "empty"
        ? []
        : [
            "2971a71b-042c-4f28-b8ae-3c02b713f0f0",
            ...(cloudScenario === "multiple"
              ? ["3a4076c2-5265-4aa1-9d6a-d0ec087f9aaf"]
              : []),
          ];
    const syncState = {
      configured: !!syncScenario,
      active: true,
      busy: false,
      endpoint: "https://dav.example.test/very/long/webdav/path/",
      username: "synthetic@example.test",
      libraryId: "2971a71b-042c-4f28-b8ae-3c02b713f0f0",
      dirty: false,
      lastSuccess: 1793404800,
      error: null as string | null,
      conflicts:
        syncScenario === "conflict"
          ? [
              {
                id: "field-fixture",
                name: "测试 · 通用 OTP",
                field: "显示名称",
                choices: [
                  { id: "version-a", label: "电脑名称", local: true },
                  { id: "version-b", label: "手机名称", local: false },
                ],
              },
            ]
          : [],
    };
    if (syncScenario === "hotp")
      Object.assign(tokens[2], {
        kind: "hotp",
        code: "",
        counter: 27,
        hotpReadOnly: true,
      });
    const quickScenario = new URLSearchParams(location.search).get("quick");
    let locked = !!quickScenario;
    let previewEnabled = quickScenario === "preview";
    let biometricEnabled =
      quickScenario === "biometric" || quickScenario === "cancel";
    let previewActive = false;
    const groups: string[] = [];
    let autoBackup = true;
    const backupEntries = [
      {
        name: "recent-fixture.sgvault",
        createdAt: 1_793_404_800,
        size: 2048,
        daily: false,
      },
      {
        name: "daily-fixture.sgvault",
        createdAt: 1_793_318_400,
        size: 1024,
        daily: true,
      },
    ];
    let pendingLogin: {
      status: string;
      guards: { confirmationType: number; associatedMessage: string }[];
      pollInterval: number;
      message?: string;
      guardSubmitted?: boolean;
    } | null = null;
    const params = new URLSearchParams(location.search);
    if (params.has("manyTokens")) for (let index = 0; index < 3; index++) tokens.push({ ...tokens[2], id: `extra-${index}`, name: `额外令牌 ${index}` });
    let externalBackup = false;
    const externalBackupStatus = () => ({ supported: params.has("externalBackup"), configured: externalBackup, label: externalBackup ? "DeviceBackups" : "" });
    if (params.has("generic")) tokens.splice(0, 2);
    let resident = true;
    const commands: { command: string; args: Record<string, unknown> }[] = [];
    const qrPreviews = new Map<
      string,
      { name: string; issuer: string; kind: string }[]
    >();
    Object.assign(window, {
      isTauri: true,
      __testCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          // Match the JSON IPC boundary: undefined fields never reach Rust.
          args = JSON.parse(JSON.stringify(args));
          commands.push({ command, args });
          switch (command) {
            case "desktop_settings":
              return { supported: params.has("desktop"), resident };
            case "desktop_configure":
              resident = !!args.resident;
              return { supported: true, resident };
            case "desktop_snapshot": {
              const result = {
                revision: "fixture-revision",
                initialized: true,
                locked,
                preview: previewActive,
                previewEnabled,
                tokens:
                  locked && !previewActive ? [] : tokens.map((t) => ({ ...t })),
              };
              if (params.has("deferDesktopSnapshot") && !(window as any).__desktopSnapshotResolved) return new Promise(resolve => Object.assign(window, { __resolveDesktopSnapshot: () => { (window as any).__desktopSnapshotResolved = true; resolve(result); } }));
              return result;
            }
            case "desktop_codes":
              if (locked && !previewActive) throw new Error("保险库已锁定");
              return { revision: "fixture-revision", codes: tokens.map(t => ({ id: t.id, code: t.code, remaining: t.remaining, period: t.period })) };
            case "desktop_copy":
              if (locked && !previewActive) throw new Error("已锁定");
              return;
            case "desktop_open_main":
            case "desktop_hide":
              return;
            case "token_delete": {
              const index = tokens.findIndex((t) => t.id === args.id);
              if (index >= 0) trash.push({ ...tokens.splice(index, 1)[0], deletedAt: 1793404800 });
              return;
            }
            case "token_codes": return { revision: "fixture-revision", codes: tokens.map(t => ({ id: t.id, code: t.code, remaining: t.remaining, period: t.period })) };
            case "token_current_code": {
              if (locked && !previewActive) throw new Error("保险库已锁定");
              const token = tokens.find(t => t.id === args.id);
              if (!token || (token as any).hotpReadOnly) throw new Error("无法读取验证码");
              if ((window as any).__deferCurrentCode) return new Promise(resolve => Object.assign(window, { __resolveCurrentCode: () => resolve({ code: "654321", remaining: 28, period: token.period }) }));
              return { code: "654321", remaining: 28, period: token.period };
            }
            case "token_create": {
              const input = args.input as Record<string, any>;
              if (!/^[A-Z2-7]+=*$/.test(input.secret)) throw new Error("密钥不是有效 Base32");
              if (input.kind !== "hotp" && input.counter !== undefined) throw new Error("只有 HOTP 令牌可修改计数");
              tokens.push({ id: "manual-fixture", name: input.name, issuer: input.issuer || "", kind: input.kind, code: "234567", period: input.period || 30, remaining: 20, icon: null, group: input.group || null, loggedIn: false, ...input, secret: undefined } as any);
              return "manual-fixture";
            }
            case "token_reorder": tokens.sort((a, b) => (args.ids as string[]).indexOf(a.id) - (args.ids as string[]).indexOf(b.id)); return;
            case "token_batch": {
              const ids = args.ids as string[];
              for (const token of [...tokens]) if (ids.includes(token.id)) {
                if (args.action === "pin") Object.assign(token, { pinned: args.pinned });
                if (args.action === "group") token.group = String(args.group || "") || null;
                if (args.action === "delete") { trash.push({ ...token, deletedAt: 1793404800 }); tokens.splice(tokens.indexOf(token), 1); }
              }
              return ids.length;
            }
            case "trash_list": return trash;
            case "trash_restore": {
              const ids = args.ids as string[];
              for (const token of [...trash]) if (ids.includes(token.id)) { tokens.push(token); trash.splice(trash.indexOf(token), 1); }
              return ids.length;
            }
            case "trash_delete": { const ids = args.ids as string[]; for (const token of [...trash]) if (ids.includes(token.id)) trash.splice(trash.indexOf(token), 1); return ids.length; }
            case "vault_change_password":
              if (args.currentPassword !== "synthetic-vault-password") throw new Error("主密码错误");
              previewEnabled = false; biometricEnabled = false; return;

            case "sync_set_alias": Object.assign(syncState, { alias: args.alias }); return { ...syncState };
            case "sync_update_credentials": {
              const connection = args.connection as Record<string, unknown>;
              if (connection.password === "wrong-app-password") throw new Error("网盘拒绝访问");
              Object.assign(syncState, { endpoint: connection.endpoint, username: connection.username }); return { ...syncState };
            }
            case "sync_connection_info": return { endpoint: syncState.endpoint, username: syncState.username, libraryId: syncState.libraryId, alias: "家庭设备", connectionQr: JSON.stringify({ version: 1, endpoint: syncState.endpoint, username: syncState.username, libraryId: syncState.libraryId }) };
            case "sync_status":
              return { ...syncState };
            case "sync_discover": {
              const connection = args.connection as
                | Record<string, unknown>
                | undefined;
              if (connection?.password === "wrong-app-password")
                throw new Error("网盘拒绝访问，请检查账号、应用密码和目录权限");
              return [...cloudLibraries];
            }
            case "sync_connect": {
              const connection = args.connection as Record<string, unknown>;
              if (connection.password === "wrong-app-password")
                throw new Error("网盘拒绝访问，请检查账号、应用密码和目录权限");
              if (
                connection.mode === "join" &&
                connection.syncPassword !== "synthetic-sync-password"
              )
                throw new Error("同步密码错误，或云端文件已损坏");
              if (
                connection.mode === "create" &&
                cloudLibraries.length &&
                !connection.confirmNewLibrary
              )
                throw new Error("网盘已有同步库，请选择加入");
              Object.assign(syncState, {
                configured: true,
                endpoint: String(connection.endpoint),
                username: String(connection.username),
                libraryId: connection.libraryId || syncState.libraryId,
              });
              return { ...syncState };
            }
            case "sync_switch":
              if (args.syncPassword !== "synthetic-sync-password")
                throw new Error("同步密码错误，或云端文件已损坏");
              syncState.libraryId = String(args.libraryId);
              return { ...syncState };
            case "sync_run":
              return { ...syncState };
            case "sync_pause":
              syncState.active = !!args.active;
              return { ...syncState };
            case "sync_disconnect":
              syncState.configured = false;
              return { ...syncState };
            case "sync_resolve":
              syncState.conflicts = [];
              return { ...syncState };
            case "sync_claim_hotp":
              if (!args.acknowledged)
                throw new Error("请确认旧设备已停止使用此 HOTP 令牌");
              Object.assign(tokens[2], {
                hotpReadOnly: false,
                code: "123456",
              });
              return { ...syncState };
            case "vault_status":
              return {
                initialized: true,
                locked,
                tokenCount: tokens.length,
                previewEnabled,
                biometricEnabled,
                previewActive,
              };
            case "token_groups":
              return [...groups];
            case "token_group_manage": {
              const name = String(args.name);
              const next = String(args.next ?? "");
              if (args.action === "create") {
                if (groups.includes(name)) throw new Error("分组已存在");
                groups.push(name);
              }
              if (args.action === "rename") {
                const index = groups.indexOf(name);
                if (index >= 0) groups[index] = next;
                for (const token of tokens)
                  if (token.group === name) token.group = next;
              }
              if (args.action === "delete") {
                const index = groups.indexOf(name);
                if (index >= 0) groups.splice(index, 1);
                for (const token of tokens)
                  if (token.group === name) token.group = null;
              }
              return;
            }
            case "token_update": {
              const token = tokens.find((t) => t.id === args.id);
              if (token) {
                const parameters = args.parameters as Record<string, unknown> | undefined;
                if (parameters?.counter !== undefined && (token.kind !== "hotp" || (token as any).hotpReadOnly)) throw new Error("只有 HOTP 主设备可修改计数");
                token.name = String(args.name);
                token.group = args.group ? String(args.group) : null;
                if (args.icon)
                  token.icon = (args.icon as { value: string | null }).value;
                if (args.parameters) Object.assign(token, args.parameters);
              }
              return;
            }
            case "backup_status":
              return {
                enabled: autoBackup,
                entries: backupEntries,
                error: null,
                systemBackup: "ios-system",
              };
            case "backup_configure":
              autoBackup = !!args.enabled;
              return;
            case "backup_external_status": return externalBackupStatus();
            case "backup_external_choose":
              if (!(window as any).__cancelBackupDirectory) externalBackup = true;
              return externalBackupStatus();
            case "backup_external_clear": externalBackup = false; return externalBackupStatus();
            case "backup_now":
              return;
            case "backup_export":
              return "/fixture/SteamGuard-backup.sgvault";
            case "backup_preview": {
              if (args.password !== "synthetic-vault-password") throw new Error("密码错误或备份已损坏");
              if (params.has("backupDiff")) return { previewId: "backup-diff", newCount: 1, updateCount: 1, unchangedCount: 0, conflictCount: 1, tokens: [{ id: "restored-fixture", name: "恢复的令牌", issuer: "Example", kind: "totp", status: "new" }, { id: "totp-test", name: "测试 · 通用 OTP", issuer: "Example", kind: "totp", status: "update" }, { id: "conflict-fixture", name: "密钥冲突的令牌", issuer: "Example", kind: "totp", status: "conflict", detail: "令牌密钥不一致" }] };
              return { previewId: "backup-fixture", newCount: 1, updateCount: 0, unchangedCount: 1, conflictCount: 0, tokens: [{ id: "restored-fixture", name: "恢复的令牌", issuer: "Example", kind: "totp", status: "new" }, { id: "totp-test", name: "测试 · 通用 OTP", issuer: "Example", kind: "totp", status: "unchanged" }] };
            }
            case "backup_restore_selected": {
              if ((args.ids as string[]).includes("restored-fixture")) tokens.push({ icon: null, group: null, id: "restored-fixture", name: "恢复的令牌", issuer: "Example", kind: "totp", code: "654321", period: 30, remaining: 24, loggedIn: false });
              return (args.ids as string[]).length;
            }
            case "backup_restore": {
              if (args.password !== "synthetic-vault-password")
                throw new Error("密码错误或备份已损坏");
              if (!tokens.some((t) => t.id === "restored-fixture"))
                tokens.push({
                  icon: null,
                  group: null,
                  id: "restored-fixture",
                  name: "恢复的令牌",
                  issuer: "Example",
                  kind: "totp",
                  code: "654321",
                  period: 30,
                  remaining: 24,
                  loggedIn: false,
                });
              return 1;
            }
            case "list_tokens":
              return locked ? [] : tokens;
            case "vault_unlock":
              previewActive = false;
              locked = false;
              return;
            case "vault_lock":
              previewActive = false;
              locked = true;
              return;
            case "quick_capabilities":
              return {
                supported: true,
                biometricAvailable: true,
                label: "Face ID",
              };
            case "quick_configure":
              if (args.enabled && args.password !== "synthetic-vault-password")
                throw new Error("主密码错误");
              if (args.slot === "preview") previewEnabled = !!args.enabled;
              else biometricEnabled = !!args.enabled;
              return;
            case "quick_preview_enter":
              if (!previewEnabled) throw new Error("预览未启用");
              previewActive = true;
              return;
            case "quick_preview_exit":
              previewActive = false;
              return;
            case "quick_preview_tokens":
              return previewActive
                ? tokens.map((t) => ({
                    ...t,
                    loggedIn: false,
                    hasIdentitySecret: false,
                    steamId: undefined,
                    accountName: undefined,
                  }))
                : [];
            case "quick_biometric_unlock":
              if (quickScenario === "cancel")
                throw new Error("验证已取消，请使用主密码");
              locked = false;
              previewActive = false;
              return;
            case "vault_touch":
              return;
            case "steam_network_settings":
              return { mode: "system", proxyUrl: "" };
            case "steam_network_configure":
              return;
            case "steam_network_diagnostics":
              return {
                platform: "windows",
                mode: "manual",
                checks: [
                  { name: "Steam 认证接口", ok: true, latencyMs: 120 },
                  { name: "Steam 时间校准", ok: true, latencyMs: 98 },
                  {
                    name: "Steam 社区",
                    ok: false,
                    latencyMs: 1000,
                    error: "连接 Steam 失败（访问 Steam 社区：请求超时）",
                  },
                ],
              };
            case "import_camera_supported":
              return (
                new URLSearchParams(location.search).get("camera") === "native"
              );
            case "import_discard":
              qrPreviews.delete(String(args.previewId));
              return;
            case "plugin:barcode-scanner|check_permissions":
            case "plugin:barcode-scanner|request_permissions":
              return { camera: "granted" };
            case "plugin:barcode-scanner|scan":
              return new Promise((resolve, reject) => {
                Object.assign(window, {
                  __qrNativeResolve: resolve,
                  __qrNativeReject: reject,
                });
              });
            case "plugin:barcode-scanner|cancel":
              (window as any).__qrNativeReject?.(new Error("cancelled"));
              return;
            case "import_qr_preview": {
              const qrPages = (window as any).__qrTestPages as Record<
                string,
                QrPageFixture
              >;
              const payloads = [...new Set(args.payloads as string[])];
              const pages = payloads.map(
                (uri) => qrPages[uri as keyof typeof qrPages],
              );
              if (
                pages.some((p) => !p) &&
                payloads.some((p) => !p.startsWith("otpauth://"))
              )
                throw new Error("二维码不是支持的验证器格式");
              const google = pages.every(Boolean);
              if (
                google &&
                pages.some(
                  (p) =>
                    p.version !== pages[0].version ||
                    p.batch !== pages[0].batch ||
                    p.size !== pages[0].size,
                )
              )
                throw new Error(
                  "二维码来自不同的 Google 导出批次，请继续扫描同一次导出的二维码",
                );
              const missing = google
                ? Array.from({ length: pages[0].size }, (_, i) => i)
                    .filter((i) => !pages.some((p) => p.index === i))
                    .map((i) => i + 1)
                : [];
              // The bridge is mocked: metadata drives UI progress, not Rust parsing.
              const previewTokens = (
                google
                  ? [...pages]
                      .sort((a, b) => a.index - b.index)
                      .flatMap((p) => p.names)
                  : payloads.map((_, i) => `Synthetic ${i + 1}`)
              ).map((name) => ({ name, issuer: "Example", kind: "totp" }));
              if (!missing.length) qrPreviews.set("qr-fixture", previewTokens);
              return {
                source: google ? "google" : "otp",
                received: payloads.length,
                expected: google ? pages[0].size : payloads.length,
                missing,
                duplicateCodes: 0,
                tokenCount: previewTokens.length,
                complete: !missing.length,
                preview: missing.length
                  ? null
                  : {
                      previewId: "qr-fixture",
                      tokens: previewTokens,
                      duplicates: 0,
                      canCommit: true,
                    },
              };
            }
            case "import_preview":
              if ((window as any).__deferImportPreview)
                return new Promise((resolve) =>
                  Object.assign(window, { __resolveImportPreview: resolve }),
                );
              if (
                (window as unknown as { __importGroupOnly?: boolean })
                  .__importGroupOnly
              )
                return {
                  previewId: "fixture-groups",
                  tokens: [],
                  duplicates: 3,
                  groupCount: 1,
                  canCommit: true,
                };
              return {
                previewId: "fixture-preview",
                tokens: [
                  {
                    name: "测试 · 导入令牌",
                    issuer: "Example",
                    kind: "totp",
                  },
                ],
                duplicates: 0,
              };
            case "import_commit": {
              const qrTokens = qrPreviews.get(String(args.previewId));
              if (qrTokens) {
                for (const [index, token] of qrTokens.entries())
                  tokens.push({
                    ...token,
                    icon: null,
                    group: null,
                    id: `imported-qr-${index}`,
                    code: "654321",
                    period: 30,
                    remaining: 24,
                    loggedIn: false,
                  });
                qrPreviews.delete(String(args.previewId));
                return qrTokens.length;
              }
              if (args.previewId === "fixture-groups") {
                groups.push("恢复分组");
                tokens[2].group = "恢复分组";
                return 0;
              }
              tokens.push({
                icon: null as string | null,
                group: null as string | null,
                id: "imported-test",
                name: "测试 · 导入令牌",
                issuer: "Example",
                kind: "totp",
                code: "654321",
                period: 30,
                remaining: 24,
                loggedIn: false,
              });
              return 1;
            }
            case "steam_confirmations":
              return [
                {
                  id: "confirmation-fixture",
                  nonce: "fixture-nonce",
                  kind: 2,
                  typeName: "交易确认",
                  headline: "测试交易 · 仅供界面验证",
                  summary: ["物品示例", "交易对象示例"],
                  creationTime: 1_700_000_000,
                  icon: "",
                },
              ];
            case "steam_confirmation_action":
              return;
            case "steam_login": {
              const scenario = (
                window as unknown as { __guardScenario?: string }
              ).__guardScenario;
              pendingLogin = {
                status: "guard",
                guards:
                  scenario === "phone-only"
                    ? [{ confirmationType: 4, associatedMessage: "" }]
                    : [
                        { confirmationType: 3, associatedMessage: "" },
                        {
                          confirmationType: 2,
                          associatedMessage: "f***@example.invalid",
                        },
                      ],
                pollInterval: 1000,
                message:
                  scenario === "auto-mismatch"
                    ? "提交登录验证码失败：Steam 令牌验证码不匹配（EResult 88）"
                    : undefined,
                guardSubmitted: false,
              };
              return { ...pendingLogin };
            }
            case "steam_submit_local_guard": {
              const token = tokens.find((t) => t.id === args.id);
              if (token) token.loggedIn = true;
              return {
                status: "authenticated",
                guards: [],
                pollInterval: 1000,
                guardSubmitted: true,
              };
            }
            case "steam_submit_guard": {
              const token = tokens.find((t) => t.id === args.id);
              if (token) token.loggedIn = true;
              return {
                status: "authenticated",
                guards: [],
                pollInterval: 1000,
              };
            }
            case "steam_begin_qr":
              return {
                status: "pending",
                guards: [],
                pollInterval: 10_000,
                qrUrl: "https://s.team/q/1/123456789",
              };
            case "steam_poll_login":
              return pendingLogin
                ? { ...pendingLogin }
                : { status: "pending", guards: [], pollInterval: 10_000 };
            case "steam_logout":
              return;
            case "steam_enroll_begin":
              return {
                id: "enrollment-fixture",
                phoneHint: "***1234",
                revocationCode: "R00000",
                needsActivation: true,
              };
            case "steam_enroll_finalize":
              return;
            case "steam_qr_info":
              return {
                deviceFriendlyName: "Fixture PC",
                platformType: 2,
                ip: "192.0.2.1",
                city: "示例位置",
                state: "",
                country: "示例国家",
                locationMismatch: false,
                highUsageLogin: false,
              };
            case "steam_qr_approve":
              return;
            case "steam_market":
              return { items: [], total: 0 };
            case "token_uri":
              return "otpauth://totp/Example:fixture?secret=GEZDGNBVGY3TQOJQ&issuer=Example";
            case "token_export":
              return "/fixture/authenticator.maFile";
            default:
              return null;
          }
        },
      },
    });
  });
  await page.addInitScript(
    (pages) => Object.assign(window, { __qrTestPages: pages }),
    qrPages,
  );
}

async function commandCount(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (
        window as unknown as { __testCommands: { command: string }[] }
      ).__testCommands.filter((c) => c.command === name).length,
    command,
  );
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  for (const summary of await page.locator(".settings-summary").all()) {
    if ((await summary.getAttribute("aria-expanded")) === "false")
      await summary.click();
  }
}

test.beforeEach(async ({ page }) => {
  await nativeFixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toBeVisible();
});

test("filters other tokens and imports only after preview confirmation", async ({
  page,
}) => {
  await page.getByRole("button", { name: "其他令牌", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "测试 · 通用 OTP", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "粘贴密钥 / 链接" }).click();
  await dialog
    .getByLabel("OTP 链接或令牌 JSON")
    .fill("otpauth://totp/Example:fixture?secret=GEZDGNBVGY3TQOJQ");
  await dialog.getByRole("button", { name: "预览令牌" }).click();
  await expect(dialog.getByText("识别到 1 个令牌")).toBeVisible();
  expect(await commandCount(page, "import_commit")).toBe(0);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "测试 · 导入令牌" }),
  ).toBeVisible();
  expect(await commandCount(page, "import_commit")).toBe(1);
});

test("requires reviewing a transaction before submitting its confirmation", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "交易确认", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "获取交易确认" }).click();
  await page.getByRole("button", { name: "查看并确认" }).click();
  await expect(page.getByRole("dialog")).toContainText("物品示例");
  expect(await commandCount(page, "steam_confirmation_action")).toBe(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认提交" })
    .click();
  await expect
    .poll(() => commandCount(page, "steam_confirmation_action"))
    .toBe(1);
});

test("password login handles Steam Guard status and QR login displays a QR code", async ({
  page,
}) => {
  const card = page
    .locator(".token-card")
    .filter({ has: page.getByRole("heading", { name: "测试 · 待登录" }) });
  await card.getByRole("button", { name: "连接 Steam" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("密码", { exact: true })
    .fill("synthetic-fixture-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog.getByLabel("验证码", { exact: true })).toBeVisible();
  await dialog.getByLabel("验证码", { exact: true }).fill("ABCDE");
  await dialog.getByRole("button", { name: "提交验证码" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  await page.getByRole("button", { name: "登录 Steam 添加令牌" }).click();
  await page.getByRole("button", { name: "二维码登录", exact: true }).click();
  await expect(
    page.getByRole("img", {
      name: "Steam 登录二维码，请使用 Steam 手机应用扫描",
    }),
  ).toBeVisible();
});

test("a rejected automatic code leaves an in-app local-token retry without resending the password", async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.assign(window, { __guardScenario: "auto-mismatch" }),
  );
  const card = page
    .locator(".token-card")
    .filter({ has: page.getByRole("heading", { name: "测试 · 待登录" }) });
  await card.getByRole("button", { name: "连接 Steam" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog.getByText(/EResult 88/)).toBeVisible();
  await expect(dialog.getByLabel("验证码", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "使用当前令牌验证", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await commandCount(page, "steam_login")).toBe(1);
  expect(await commandCount(page, "steam_submit_local_guard")).toBe(1);
});

test("email selection survives login polling and sends the chosen code type", async ({
  page,
}) => {
  await page.clock.install();
  const card = page
    .locator(".token-card")
    .filter({ has: page.getByRole("heading", { name: "测试 · 待登录" }) });
  await card.getByRole("button", { name: "连接 Steam" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await dialog.getByLabel("验证方式").selectOption("2");
  await page.clock.fastForward(1500);
  await expect
    .poll(() => commandCount(page, "steam_poll_login"))
    .toBeGreaterThan(0);
  await expect(dialog.getByLabel("验证方式")).toHaveValue("2");
  await dialog.getByLabel("验证码", { exact: true }).fill("ABCDE");
  await dialog.getByRole("button", { name: "提交验证码", exact: true }).click();
  const args = await page.evaluate(
    () =>
      (
        window as unknown as {
          __testCommands: { command: string; args: Record<string, unknown> }[];
        }
      ).__testCommands.find((c) => c.command === "steam_submit_guard")?.args,
  );
  expect(args?.codeType).toBe(2);
});

test("phone-only Steam approval does not demand an unavailable code", async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.assign(window, { __guardScenario: "phone-only" }),
  );
  const card = page
    .locator(".token-card")
    .filter({ has: page.getByRole("heading", { name: "测试 · 待登录" }) });
  await card.getByRole("button", { name: "连接 Steam" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog.getByLabel("验证码", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "检查登录状态", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "检查登录状态", exact: true })
    .click();
  expect(await commandCount(page, "steam_submit_guard")).toBe(0);
});

test("new Steam enrollment requires an explicit start and recovery acknowledgment", async ({
  page,
}) => {
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  await page.getByRole("button", { name: "登录 Steam 添加令牌" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Steam 账户名").fill("synthetic-fixture-account");
  await dialog
    .getByLabel("密码", { exact: true })
    .fill("synthetic-fixture-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await dialog.getByLabel("验证码", { exact: true }).fill("ABCDE");
  await dialog.getByRole("button", { name: "提交验证码" }).click();
  await dialog.getByRole("button", { name: "绑定新令牌" }).click();
  expect(await commandCount(page, "steam_enroll_begin")).toBe(0);
  await dialog.getByRole("button", { name: "创建并发送短信" }).click();
  await expect(dialog.getByText("R00000", { exact: true })).toBeVisible();
  await dialog.getByLabel("短信激活码").fill("12345");
  await expect(
    dialog.getByRole("button", { name: "激活令牌", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "我已将恢复代码保存在安全位置" })
    .check();
  await dialog.getByRole("button", { name: "激活令牌", exact: true }).click();
  await expect.poll(() => commandCount(page, "steam_enroll_finalize")).toBe(1);
});

test("QR approval shows request details before submitting a decision", async ({
  page,
}) => {
  const card = page.locator(".token-card").filter({
    has: page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  });
  await card.getByRole("button", { name: "已登录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "批准二维码登录" }).click();
  await dialog
    .getByLabel("Steam 登录二维码链接")
    .fill("https://s.team/q/1/123456789");
  await dialog.getByRole("button", { name: "核对登录请求" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Fixture PC" }),
  ).toBeVisible();
  expect(await commandCount(page, "steam_qr_approve")).toBe(0);
  await dialog.getByRole("button", { name: "批准登录", exact: true }).click();
  await expect.poll(() => commandCount(page, "steam_qr_approve")).toBe(1);
});

test("locks the vault and removes token content", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "锁定保险库" }).click();
  await expect(
    page.getByRole("heading", { name: "解锁", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toHaveCount(0);
});

test("saves a chosen proxy only on explicit save and shows endpoint diagnostics", async ({
  page,
}) => {
  await openSettings(page);
  const panel = page.locator(".network-panel");
  await panel.getByLabel("连接方式", { exact: true }).selectOption("manual");
  await panel
    .getByLabel("代理地址", { exact: true })
    .fill("http://127.0.0.1:7890");
  expect(
    await page.evaluate(
      () =>
        ((window as any).__testCommands as any[]).filter(
          (c) => c.command === "steam_network_configure",
        ).length,
    ),
  ).toBe(0);
  await panel
    .getByRole("button", { name: "保存连接方式", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("连接方式已保存");
  expect(
    await page.evaluate(
      () =>
        ((window as any).__testCommands as any[]).find(
          (c) => c.command === "steam_network_configure",
        ).args.settings,
    ),
  ).toEqual({ mode: "manual", proxyUrl: "http://127.0.0.1:7890" });
  await panel
    .getByRole("button", { name: "检测已保存配置", exact: true })
    .click();
  await expect(panel.getByLabel("Steam 网络检测结果")).toContainText(
    "Steam 认证接口",
  );
  await expect(panel.getByLabel("Steam 网络检测结果")).toContainText(
    "访问 Steam 社区：请求超时",
  );
  await page.setViewportSize({ width: 360, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

for (const width of [360, 390, 768, 1180]) {
  test(`layout stays within the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 520 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "测试 · Steam", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 390 || width === 1180)
      await page.screenshot({
        path: `test-results/steamguard-${width === 390 ? "mobile" : "desktop"}.png`,
        fullPage: true,
      });
    await page.getByRole("button", { name: "添加令牌", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const box = await page.getByRole("dialog").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  });
}

test("quick access settings verify the password, keep failures recoverable, and can be disabled", async ({
  page,
}) => {
  await openSettings(page);
  const preview = page.getByRole("switch", { name: "免密码预览令牌" });
  await expect(preview).toHaveAttribute("aria-checked", "false");
  await preview.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("能打开此应用的人都能查看、复制验证码");
  await dialog.getByLabel("确认保险库主密码").fill("wrong-password");
  await dialog.getByRole("button", { name: "确认启用" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("主密码错误");
  await expect(preview).toHaveAttribute("aria-checked", "false");
  await dialog.getByLabel("确认保险库主密码").fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "确认启用" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(preview).toHaveAttribute("aria-checked", "true");
  await preview.click();
  await expect(preview).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "设备生物认证解锁" }).click();
  await dialog.getByLabel("确认保险库主密码").fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "确认启用" }).click();
  await expect(
    page.getByRole("switch", { name: "设备生物认证解锁" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("startup preview exposes codes while keeping privileged actions locked", async ({
  page,
}) => {
  await page.goto("/?quick=preview");
  await expect(page.getByText("只读预览", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加令牌", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "管理 测试 · Steam", exact: true }),
  ).toBeDisabled();
  expect(await commandCount(page, "list_tokens")).toBe(0);
  await page
    .getByRole("button", { name: "交易确认", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("解锁密码", { exact: true })).toBeVisible();
  expect(await commandCount(page, "steam_confirmations")).toBe(0);
  await page
    .getByLabel("解锁密码", { exact: true })
    .fill("synthetic-vault-password");
  await page.getByRole("button", { name: "解锁保险库", exact: true }).click();
  await expect(page.getByLabel("解锁密码", { exact: true })).toHaveCount(0);
  expect(await commandCount(page, "vault_unlock")).toBe(1);
});

test("device authentication opens the vault and cancellation leaves the password fallback usable", async ({
  page,
}) => {
  await page.goto("/?quick=biometric");
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toBeVisible();
  expect(await commandCount(page, "quick_biometric_unlock")).toBe(1);
  expect(await commandCount(page, "vault_unlock")).toBe(0);
  await page.goto("/?quick=cancel");
  await expect(page.getByLabel("解锁密码", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("验证已取消");
  await page
    .getByLabel("解锁密码", { exact: true })
    .fill("synthetic-vault-password");
  await page.getByRole("button", { name: "解锁保险库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toBeVisible();
});

for (const width of [320, 390, 768, 844]) {
  test(`phone layout stays readable without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await expect(
      page.getByRole("navigation", { name: "移动端导航" }),
    ).toBeVisible();
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const add = page.getByRole("button", { name: "添加令牌", exact: true });
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (width === 390)
      await page.screenshot({
        path: "artifacts/mobile-tokens.png",
        fullPage: true,
      });
    await add.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "粘贴密钥 / 链接" }).click();
    const input = dialog.getByLabel("OTP 链接或令牌 JSON");
    expect(
      await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.focus();
    if (width === 390)
      await page.screenshot({ path: "artifacts/mobile-import.png" });
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await openSettings(page);
    await expect(
      page.getByRole("switch", { name: "免密码预览令牌" }),
    ).toBeVisible();
    if (width === 390)
      await page.screenshot({
        path: "artifacts/mobile-settings.png",
        fullPage: true,
      });
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("custom groups can be created, assigned, renamed and deleted without deleting tokens", async ({
  page,
}) => {
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("新建分组", { exact: true }).fill("邮箱");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog.getByText("邮箱", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "管理 测试 · 通用 OTP", exact: true })
    .click();
  await dialog.getByLabel("分组", { exact: true }).selectOption("邮箱");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel("分组筛选").selectOption("group:邮箱");
  await expect(page.locator(".token-card")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "测试 · 通用 OTP", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  await dialog
    .getByRole("button", { name: "重命名分组 邮箱", exact: true })
    .click();
  await dialog.getByLabel("重命名「邮箱」").fill("工作");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText("工作", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "删除分组 工作", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "确认删除分组", exact: true })
    .click();
  await expect(dialog.getByText("工作", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("分组筛选").selectOption("ungrouped");
  await expect(
    page.getByRole("heading", { name: "测试 · 通用 OTP", exact: true }),
  ).toBeVisible();
});

test("automatic backups can be configured, exported and restored only with a valid backup password", async ({
  page,
}) => {
  await openSettings(page);
  const toggle = page.getByRole("switch", { name: "变更后自动备份" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "立即备份", exact: true }).click();
  expect(await commandCount(page, "backup_now")).toBe(1);
  await page
    .locator(".backup-panel")
    .getByRole("button", { name: "查看", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "导出所选备份", exact: true })
    .click();
  expect(await commandCount(page, "backup_export")).toBe(1);
  expect(await commandCount(page, "backup_restore")).toBe(0);
  await dialog.getByLabel("备份主密码").fill("wrong-password");
  await dialog.getByRole("button", { name: "验证并预览备份", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("密码错误或备份已损坏");
  await dialog.getByLabel("备份主密码").fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "验证并预览备份", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "备份差异预览" })).toContainText("新增 1");
  expect(await commandCount(page, "backup_restore_selected")).toBe(0);
  await dialog.getByRole("button", { name: "恢复所选令牌", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已恢复所选的 1 个令牌");
  await expect(dialog.getByLabel("备份主密码")).toHaveValue("");
});

test("phone home opens on tokens without statistics or a large add panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".overview-grid")).toBeHidden();
  await expect(page.locator(".page-heading p")).toHaveCount(0);
  const card = page.locator(".token-card").first();
  await expect(card).toBeInViewport();
  const bounds = await card.boundingBox();
  expect(bounds!.y).toBeLessThan(330);
  await expect(
    page.getByRole("button", { name: "添加令牌", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/mobile-token-home-v1.2.0.png" });
});

test("an encrypted import can merge groups even when every token already exists", async ({
  page,
}) => {
  await page.evaluate(() => Object.assign(window, { __importGroupOnly: true }));
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "粘贴密钥 / 链接" }).click();
  await dialog
    .getByLabel("OTP 链接或令牌 JSON")
    .fill("synthetic-encrypted-backup-fixture");
  await dialog.getByRole("button", { name: "预览令牌", exact: true }).click();
  await expect(
    dialog.getByText("合并已有令牌信息", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "确认导入", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel("分组筛选").selectOption("group:恢复分组");
  await expect(page.locator(".token-card")).toHaveCount(1);
});

test("WebDAV discovery reports auth failure and first-library creation clears credentials", async ({
  page,
}) => {
  await page.goto("/?cloud=empty");
  await openSettings(page);
  const panel = page.locator(".sync-panel");
  await expect(panel.getByLabel("连接方式")).toHaveValue("join");
  await panel
    .getByLabel("网盘账号", { exact: true })
    .fill("synthetic@example.test");
  await panel
    .getByLabel("网盘应用密码", { exact: true })
    .fill("wrong-app-password");
  await panel
    .getByRole("button", { name: "查找已有同步库", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("网盘拒绝访问");
  await panel
    .getByLabel("网盘应用密码", { exact: true })
    .fill("synthetic-app-password");
  await panel
    .getByRole("button", { name: "查找已有同步库", exact: true })
    .click();
  await expect(panel.getByRole("region", { name: "网盘同步库" })).toContainText(
    "尚未找到同步库",
  );
  await panel.getByLabel("连接方式").selectOption("create");
  await panel
    .getByLabel("独立同步密码", { exact: true })
    .fill("synthetic-sync-password");
  await panel.getByRole("button", { name: "创建并同步", exact: true }).click();
  await expect(panel.getByText("同步库编号", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("网盘应用密码", { exact: true })).toHaveCount(
    0,
  );
  await panel.getByRole("button", { name: "断开同步", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "本机令牌和云端同步库都会保留",
  );
  await page.getByRole("button", { name: "确认断开", exact: true }).click();
  await expect(panel.getByLabel("网盘应用密码", { exact: true })).toHaveValue(
    "",
  );
  await expect(panel.getByLabel("独立同步密码", { exact: true })).toHaveValue(
    "",
  );
});

test("existing cloud libraries must be selected and independent creation needs explicit confirmation", async ({
  page,
}) => {
  await page.goto("/?cloud=multiple");
  await openSettings(page);
  const panel = page.locator(".sync-panel");
  await panel
    .getByLabel("网盘账号", { exact: true })
    .fill("synthetic@example.test");
  await panel
    .getByLabel("网盘应用密码", { exact: true })
    .fill("synthetic-app-password");
  await panel
    .getByRole("button", { name: "查找已有同步库", exact: true })
    .click();
  const libraries = panel.getByRole("region", { name: "网盘同步库" });
  await expect(libraries.getByRole("radio")).toHaveCount(2);
  await expect(
    panel.getByRole("button", { name: "加入并同步", exact: true }),
  ).toBeDisabled();
  await libraries.getByRole("radio").nth(1).check();
  await panel.getByLabel("连接方式").selectOption("create");
  await expect(
    panel.getByRole("button", { name: "创建并同步", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("我需要另外创建一个独立库").check();
  await expect(
    panel.getByRole("button", { name: "创建并同步", exact: true }),
  ).toBeEnabled();
  await panel.getByLabel("连接方式").selectOption("join");
  await panel
    .getByLabel("独立同步密码", { exact: true })
    .fill("synthetic-sync-password");
  await panel.getByRole("button", { name: "加入并同步", exact: true }).click();
  await expect(panel.locator(".sync-details")).toContainText(
    "3a4076c2-5265-4aa1-9d6a-d0ec087f9aaf",
  );
  const request = await page.evaluate(
    () =>
      (window as any).__testCommands.find(
        (c: any) => c.command === "sync_connect",
      ).args.connection,
  );
  expect(request.mode).toBe("join");
  expect(request.libraryId).toBe("3a4076c2-5265-4aa1-9d6a-d0ec087f9aaf");
});

test("connected devices can select a different library and retry wrong passwords without disconnecting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?sync=connected&cloud=multiple");
  await openSettings(page);
  await page
    .getByRole("button", { name: "选择其他同步库合并", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "选择同步库并合并" });
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await expect(dialog).toContainText("原云端库会保留");
  await expect(
    dialog.getByRole("button", { name: "合并并切换到所选库", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("radio").check();
  await dialog
    .getByLabel("独立同步密码", { exact: true })
    .fill("incorrect-password");
  await dialog
    .getByRole("button", { name: "合并并切换到所选库", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("同步密码错误");
  expect(await commandCount(page, "sync_disconnect")).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(741);
  await page.screenshot({
    path: "artifacts/mobile-sync-library-chooser-1.3.2.png",
  });
  await dialog
    .getByLabel("独立同步密码", { exact: true })
    .fill("synthetic-sync-password");
  await dialog
    .getByRole("button", { name: "合并并切换到所选库", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".sync-details")).toContainText(
    "3a4076c2-5265-4aa1-9d6a-d0ec087f9aaf",
  );
  await expect(
    page.getByRole("button", { name: "立即同步", exact: true }),
  ).toBeEnabled();
});

test("joining a library passes its identifier and independent encryption password", async ({
  page,
}) => {
  await openSettings(page);
  const panel = page.locator(".sync-panel");
  await panel.getByLabel("连接方式").selectOption("join");
  await panel.getByLabel("网盘服务").selectOption("custom");
  await panel
    .getByLabel("WebDAV 地址")
    .fill("https://dav.example.test/folder/");
  await panel
    .getByLabel("网盘账号", { exact: true })
    .fill("synthetic@example.test");
  await panel
    .getByLabel("网盘应用密码", { exact: true })
    .fill("synthetic-app-password");
  await panel.getByLabel("手动输入同步库编号").check();
  await panel
    .getByLabel("同步库编号", { exact: true })
    .fill("2971a71b-042c-4f28-b8ae-3c02b713f0f0");
  await panel
    .getByLabel("独立同步密码", { exact: true })
    .fill("synthetic-sync-password");
  await panel.getByRole("button", { name: "加入并同步", exact: true }).click();
  await expect(
    panel.getByRole("switch", { name: "自动同步", exact: true }),
  ).toBeChecked();
  await panel.getByRole("switch", { name: "自动同步", exact: true }).click();
  await expect(
    panel.getByRole("switch", { name: "自动同步", exact: true }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "立即同步", exact: true }).click();
  expect(await commandCount(page, "sync_run")).toBeGreaterThan(0);
});

test("conflicting sync fields are kept until a version is explicitly selected", async ({
  page,
}) => {
  await page.goto("/?sync=conflict");
  await openSettings(page);
  const region = page.getByRole("region", { name: "同步冲突", exact: true });
  await expect(
    region.getByRole("button", { name: "保留所选版本", exact: true }),
  ).toBeDisabled();
  await region.getByLabel("手机名称").check();
  await region
    .getByRole("button", { name: "保留所选版本", exact: true })
    .click();
  await expect(region).toHaveCount(0);
  expect(await commandCount(page, "sync_resolve")).toBe(1);
});

test("HOTP on a secondary device cannot copy or advance and transfer requires acknowledgment", async ({
  page,
}) => {
  await page.goto("/?sync=hotp");
  const card = page
    .locator(".token-card")
    .filter({ hasText: "测试 · 通用 OTP" });
  await expect(card.getByText("仅主设备", { exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "下一验证码" })).toBeDisabled();
  await openSettings(page);
  await page.getByRole("button", { name: "切换到本机", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "设为主设备", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "设为主设备", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await commandCount(page, "sync_claim_hotp")).toBe(1);
});

test("encrypted sync settings fit a narrow phone and preview never starts cloud sync", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?sync=conflict");
  await openSettings(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/mobile-sync-v1.3.0.png",
    fullPage: true,
  });
  await page.goto("/?quick=preview&sync=connected");
  await expect(page.getByText("只读预览", { exact: true })).toBeVisible();
  await page.waitForTimeout(2300);
  expect(await commandCount(page, "sync_run")).toBe(0);
});

async function openQrImport(page: Page) {
  await page
    .getByRole("button", { name: "添加令牌", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "扫码 / 图片", exact: true }).click();
  return page.getByRole("region", { name: "扫码导入令牌" });
}
async function qrImage(text: string) {
  return {
    name: "synthetic-qr.png",
    mimeType: "image/png",
    buffer: await QRCode.toBuffer(text, { width: 512, margin: 4 }),
  };
}
test("Google multi-QR images collect out of order, deduplicate and reject another batch before one atomic import", async ({
  page,
}) => {
  const panel = await openQrImport(page);
  const images = panel.getByLabel("选择二维码图片", { exact: true });
  await images.setInputFiles(await qrImage(googlePages[2]));
  await expect(panel).toContainText("已收集 1/3 张");
  await expect(panel).toContainText("还缺第 1、2 张");
  await expect(
    panel.getByRole("button", { name: "预览令牌", exact: true }),
  ).toBeDisabled();
  expect(await commandCount(page, "import_commit")).toBe(0);
  await images.setInputFiles(await qrImage(googlePages[2]));
  await expect(panel).toContainText("这张二维码已经收集");
  await images.setInputFiles(await qrImage(otherBatchPage));
  await expect(panel.getByRole("alert")).toContainText(
    "不同的 Google 导出批次",
  );
  await expect(panel).toContainText("已收集 1/3 张");
  await images.setInputFiles([
    await qrImage(googlePages[1]),
    await qrImage(googlePages[0]),
  ]);
  await expect(panel).toContainText("已收集 3/3 张");
  await panel.getByRole("button", { name: "预览令牌", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("识别到 3 个令牌");
  expect(await commandCount(page, "import_commit")).toBe(0);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  expect(await commandCount(page, "import_commit")).toBe(1);
});
// The native bridge is mocked here; Rust tests cover V2 payload compatibility.
test("Google V2 synthetic images without batch_id collect out of order and commit all 22 tokens once", async ({
  page,
}) => {
  const panel = await openQrImport(page);
  const images = panel.getByLabel("选择二维码图片", { exact: true });
  const preview = panel.getByRole("button", { name: "预览令牌", exact: true });
  await images.setInputFiles(await qrImage(googleV2Pages[2]));
  await expect(panel).toContainText("已收集 1/3 张");
  await expect(panel).toContainText("识别到 2 个令牌");
  await expect(panel).toContainText("还缺第 1、2 张");
  await expect(preview).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "确认导入", exact: true }),
  ).toHaveCount(0);
  expect(await commandCount(page, "import_commit")).toBe(0);

  await images.setInputFiles(await qrImage(googleV2Pages[2]));
  await expect(panel).toContainText("这张二维码已经收集");
  await expect(panel).toContainText("已收集 1/3 张");
  await expect(panel).toContainText("识别到 2 个令牌");
  expect(await commandCount(page, "import_qr_preview")).toBe(1);

  await images.setInputFiles(await qrImage(googleV2Pages[0]));
  await expect(panel).toContainText("已收集 2/3 张");
  await expect(panel).toContainText("识别到 12 个令牌");
  await expect(panel).toContainText("还缺第 2 张");
  await expect(preview).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "确认导入", exact: true }),
  ).toHaveCount(0);
  expect(await commandCount(page, "import_commit")).toBe(0);

  await images.setInputFiles(await qrImage(googleV2Pages[1]));
  await expect(panel).toContainText("已收集 3/3 张");
  await expect(panel).toContainText("识别到 22 个令牌");
  await expect(preview).toBeEnabled();
  await expect(panel).not.toContainText("还缺第");
  expect(await commandCount(page, "import_commit")).toBe(0);
  await preview.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("识别到 22 个令牌");
  await expect(dialog.locator(".import-token-list > div")).toHaveCount(22);
  expect(
    await dialog.locator(".import-token-list strong").allTextContents(),
  ).toEqual(
    Array.from({ length: 22 }, (_, index) => `Synthetic V2 ${index + 1}`),
  );
  expect(await commandCount(page, "import_commit")).toBe(0);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".token-card").filter({ hasText: /Synthetic V2 / }),
  ).toHaveCount(22);
  expect(await commandCount(page, "import_commit")).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as any).__testCommands
        .filter((entry: any) => entry.command === "import_qr_preview")
        .map((entry: any) => entry.args.payloads),
    ),
  ).toEqual([
    [googleV2Pages[2]],
    [googleV2Pages[2], googleV2Pages[0]],
    [googleV2Pages[2], googleV2Pages[0], googleV2Pages[1]],
  ]);
});
test("one image can contain several QR codes and incomplete collection is cleared on exit", async ({
  page,
}) => {
  const panel = await openQrImport(page);
  const data = await Promise.all(
    [googlePages[0], googlePages[2]].map((text) =>
      QRCode.toDataURL(text, { width: 512, margin: 4 }),
    ),
  );
  const combined = await page.evaluate(async (data) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext("2d")!;
    for (let i = 0; i < data.length; i++) {
      const image = new Image();
      image.src = data[i];
      await image.decode();
      context.drawImage(image, i * 512, 0);
    }
    return canvas.toDataURL("image/png");
  }, data);
  await panel.getByLabel("选择二维码图片", { exact: true }).setInputFiles({
    name: "two-qr.png",
    mimeType: "image/png",
    buffer: Buffer.from(combined.split(",")[1], "base64"),
  });
  await expect(panel).toContainText("已收集 2/3 张");
  await expect(panel).toContainText("还缺第 2 张");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const reopened = await openQrImport(page);
  await expect(
    reopened.getByRole("button", { name: "预览令牌", exact: true }),
  ).toBeDisabled();
  await expect(reopened).not.toContainText("已收集 2/3 张");
});
test("native camera can collect several Google pages and cancellation preserves collected progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?camera=native");
  const panel = await openQrImport(page);
  await panel
    .getByRole("button", { name: "打开相机扫码", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "相机扫码", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (content) =>
      (window as any).__qrNativeResolve({ content, format: "QR_CODE" }),
    googlePages[1],
  );
  await expect(panel).toContainText("已收集 1/3 张");
  await panel.getByRole("button", { name: "继续扫码", exact: true }).click();
  await page.getByRole("button", { name: "停止扫描", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "相机扫码", exact: true }),
  ).toHaveCount(0);
  await expect(panel).toContainText("已收集 1/3 张");
  expect(
    await page.evaluate(() =>
      document.body.classList.contains("qr-camera-active"),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "artifacts/mobile-google-import-1.4.0.png" });
});
test("camera permission failure and invalid images keep import recoverable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    }),
  );
  await page.reload();
  const panel = await openQrImport(page);
  await panel
    .getByRole("button", { name: "打开相机扫码", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("相机权限被拒绝");
  await panel.getByLabel("选择二维码图片", { exact: true }).setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not-an-image"),
  });
  await expect(panel.getByRole("alert")).toContainText("无法打开图片");
  await panel
    .getByLabel("选择二维码图片", { exact: true })
    .setInputFiles(await qrImage(ordinaryQr));
  await expect(panel).toContainText("已收集 1 张 OTP 二维码");
  await expect(
    panel.getByRole("button", { name: "预览令牌", exact: true }),
  ).toBeEnabled();
});

test("production QR decoding works offline under the packaged CSP without CDN requests", async ({
  page,
}) => {
  const csp = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app
    .security.csp;
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
      external.push(url.origin);
      await route.abort();
      return;
    }
    if (route.request().resourceType() === "document") {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": csp },
      });
    } else await route.continue();
  });
  await page.goto("http://127.0.0.1:1422/");
  const panel = await openQrImport(page);
  await panel
    .getByLabel("选择二维码图片", { exact: true })
    .setInputFiles(await qrImage(ordinaryQr));
  await expect(
    panel.getByRole("button", { name: "预览令牌", exact: true }),
  ).toBeEnabled();
  expect(external).toEqual([]);
});

test("desktop camera cancellation returns immediately and stops a late permission grant", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) =>
            Object.assign(window, { __qrMediaResolve: resolve }),
          ),
      },
    }),
  );
  await page.reload();
  const panel = await openQrImport(page);
  await panel
    .getByRole("button", { name: "打开相机扫码", exact: true })
    .click();
  await panel.getByRole("button", { name: "停止扫描", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "打开相机扫码", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    (window as any).__qrMediaResolve({
      getTracks: () => [
        { stop: () => Object.assign(window, { __qrLateTrackStopped: true }) },
      ],
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__qrLateTrackStopped))
    .toBe(true);
  await panel
    .getByLabel("选择二维码图片", { exact: true })
    .setInputFiles(await qrImage(ordinaryQr));
  await expect(
    panel.getByRole("button", { name: "预览令牌", exact: true }),
  ).toBeEnabled();
});

test("a file preview arriving after the import dialog closes is immediately discarded", async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.assign(window, { __deferImportPreview: true }),
  );
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "粘贴密钥 / 链接", exact: true })
    .click();
  await dialog.getByLabel("OTP 链接或令牌 JSON").fill(ordinaryQr);
  await dialog.getByRole("button", { name: "预览令牌", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() =>
    (window as any).__resolveImportPreview({
      previewId: "late-preview-fixture",
      tokens: [{ name: "Synthetic", issuer: "Example", kind: "totp" }],
      duplicates: 0,
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__testCommands.some(
          (c: any) =>
            c.command === "import_discard" &&
            c.args.previewId === "late-preview-fixture",
        ),
      ),
    )
    .toBe(true);
  expect(await commandCount(page, "import_commit")).toBe(0);
});

test("generic authenticator hides Steam features and contains no decorative security messaging", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?generic");
  await expect(
    page.getByRole("heading", { name: "测试 · 通用 OTP" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "交易确认", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "社区市场", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(
      ".overview-grid,.bottom-note,.main-footer,.system-state,.privacy-note",
    ),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    /每一次登录|由你掌控|安心一点|安全空间|保护中|已保护的令牌/,
  );
  await page.screenshot({ path: "artifacts/mobile-generic-1.5.0.png" });
  await openSettings(page);
  await expect(
    page.getByRole("heading", { name: "Steam 网络连接" }),
  ).toHaveCount(0);
  expect(await commandCount(page, "steam_network_settings")).toBe(0);
});

test("service icons and custom avatars save with token edits, can be cancelled and reset", async ({
  page,
}) => {
  const manage = () =>
    page
      .getByRole("button", { name: "管理 测试 · 通用 OTP", exact: true })
      .click();
  await manage();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "更换头像", exact: true }).click();
  await dialog.getByLabel("搜索图标").fill("github");
  await dialog.getByLabel("选择 GitHub 图标", { exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  const card = page
    .locator(".token-card")
    .filter({ hasText: "测试 · 通用 OTP" });
  await expect(card.getByLabel("GitHub", { exact: true })).toBeVisible();
  await manage();
  await dialog.getByRole("button", { name: "更换头像", exact: true }).click();
  await dialog.getByLabel("上传头像").setInputFiles(await qrImage(ordinaryQr));
  await expect(dialog.getByRole("heading", { name: "管理令牌" })).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card.getByRole("img", { name: "自定义头像" })).toBeVisible();
  const size = await card
    .getByRole("img", { name: "自定义头像" })
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });
  expect(size).toEqual([96, 96]);
  await manage();
  await dialog.getByRole("button", { name: "更换头像", exact: true }).click();
  await dialog.getByRole("button", { name: "自动图标", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(card.getByRole("img", { name: "自定义头像" })).toBeVisible();
  await manage();
  await dialog.getByRole("button", { name: "更换头像", exact: true }).click();
  await dialog.getByRole("button", { name: "自动图标", exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card.getByRole("img", { name: "自定义头像" })).toHaveCount(0);
});

test("tray popup copies directly, clears tokens on lock and exposes no management controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 370 });
  await page.goto("/?view=tray");
  await page
    .getByRole("button", { name: "复制 测试 · 通用 OTP 验证码" })
    .click();
  expect(await commandCount(page, "desktop_copy")).toBe(1);
  expect(await commandCount(page, "list_tokens")).toBe(0);
  expect(await commandCount(page, "sync_status")).toBe(0);
  await expect(page.getByRole("button", { name: "添加令牌" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/tray-1.5.0.png" });
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await expect(page.locator(".tray-token")).toHaveCount(0);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  expect(await commandCount(page, "desktop_open_main")).toBe(1);
});

test("desktop residency preference is explicit and persists in the settings view", async ({
  page,
}) => {
  await page.goto("/?desktop");
  await openSettings(page);
  const toggle = page.getByRole("switch", { name: "关闭窗口后常驻托盘" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await commandCount(page, "desktop_configure")).toBe(1);
});

test("compact controls and cloud dialogs fit a 320 pixel screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?sync=connected&cloud=multiple");
  const fits = async () => {
    const outside = await page.evaluate(() =>
      Array.from(document.querySelectorAll("body *"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width && (r.right > innerWidth + 1 || r.left < -1);
        })
        .map(
          (el) =>
            `${el.tagName}.${el.className} ${JSON.stringify(el.getBoundingClientRect().toJSON())}`,
        )
        .slice(0, 10),
    );
    expect(outside).toEqual([]);
  };
  await fits();
  await openSettings(page);
  await fits();
  await page
    .getByRole("button", { name: "选择其他同步库合并", exact: true })
    .click();
  await fits();
});

test("settings start compact and reveal cloud configuration only when requested", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?generic");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("网盘账号", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/settings-compact-1.5.0.png" });
  await page.getByRole("button", { name: "多端同步", exact: true }).click();
  await expect(page.getByLabel("网盘账号", { exact: true })).toBeVisible();
});

test("Steam navigation disappears after the last Steam token is removed", async ({
  page,
}) => {
  for (const name of ["测试 · Steam", "测试 · 待登录"]) {
    await page
      .getByRole("button", { name: `管理 ${name}`, exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除令牌", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "交易确认", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "社区市场", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加 Steam 令牌", exact: true }),
  ).toBeHidden();
  await page.locator("summary").filter({ hasText: "其他添加方式" }).click();
  await page
    .getByRole("button", { name: "添加 Steam 令牌", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Steam 账户名", { exact: true }),
  ).toBeVisible();
});


test("manual HOTP creation and generic parameter editing preserve advanced values", async ({ page }) => {
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "手动添加", exact: true }).click();
  await dialog.getByLabel("服务名称", { exact: true }).fill("Example Service");
  await dialog.getByLabel("账户或显示名称", { exact: true }).fill("工作账户");
  await dialog.getByLabel("密钥（Base32）", { exact: true }).fill("gezd gnbv gy3t qojq");
  await dialog.getByLabel("令牌类型", { exact: true }).selectOption("hotp");
  await dialog.locator("summary").filter({ hasText: "高级参数" }).click();
  await dialog.getByLabel("算法", { exact: true }).selectOption("SHA256");
  await dialog.getByLabel("验证码位数", { exact: true }).selectOption("8");
  await dialog.getByLabel("计数器", { exact: true }).fill("42");
  await dialog.getByRole("button", { name: "保存令牌", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const input = await page.evaluate(() => (window as any).__testCommands.find((c: any) => c.command === "token_create").args.input);
  expect(input).toMatchObject({ issuer: "Example Service", name: "工作账户", secret: "GEZDGNBVGY3TQOJQ", kind: "hotp", algorithm: "SHA256", digits: 8, counter: 42 });
  await page.getByRole("button", { name: "管理 工作账户", exact: true }).click();
  await dialog.locator("summary").filter({ hasText: "高级参数" }).click();
  await expect(dialog.getByLabel("计数器", { exact: true })).toHaveValue("42");
  await dialog.getByLabel("验证码位数", { exact: true }).selectOption("6");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__testCommands.filter((c: any) => c.command === "token_update").at(-1).args.parameters.digits)).toBe(6);
});

test("batch deletion can be undone and trash permanent deletion requires review", async ({ page }) => {
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  await page.getByLabel("选择 测试 · 通用 OTP", { exact: true }).check();
  await page.getByRole("region", { name: "批量管理令牌" }).getByRole("button", { name: "删除", exact: true }).click();
  expect(await commandCount(page, "token_batch")).toBe(0);
  await page.getByRole("dialog").getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试 · 通用 OTP", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试 · 通用 OTP", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管理 测试 · 通用 OTP", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除令牌", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  expect(await commandCount(page, "trash_delete")).toBe(0);
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog).toContainText("回收站为空");
  expect(await commandCount(page, "trash_delete")).toBe(1);
});

test("pin and accessible manual move persist without replacing name and type sorting", async ({ page }) => {
  await page.getByRole("button", { name: "管理 测试 · 通用 OTP", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "上移", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "置顶显示", exact: true }).check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  expect(await commandCount(page, "token_reorder")).toBe(1);
  await expect(page.locator(".token-card").first()).toContainText("测试 · 通用 OTP");
  await page.getByLabel("令牌排序", { exact: true }).selectOption("name");
  await page.getByLabel("令牌排序", { exact: true }).selectOption("type");
  await expect(page.locator(".token-card").first()).toContainText("测试 · 通用 OTP");
});

test("copy obtains the current native code and lightweight polling avoids full token reloads", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const before = await commandCount(page, "list_tokens");
  await page.getByRole("button", { name: "复制 测试 · 通用 OTP 验证码", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("654321");
  expect(await commandCount(page, "token_current_code")).toBe(1);
  await page.waitForTimeout(1200);
  expect(await commandCount(page, "token_codes")).toBeGreaterThan(0);
  expect(await commandCount(page, "list_tokens")).toBeLessThanOrEqual(before + 1); // one initial automatic sync may finish
});

test("changing the master password validates locally and resets quick access after success", async ({ page }) => {
  await openSettings(page);
  await page.locator(".settings-panel").filter({ hasText: "保险库主密码" }).getByRole("button", { name: "修改", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("当前主密码", { exact: true }).fill("wrong");
  await dialog.getByLabel("新主密码", { exact: true }).fill("new-synthetic-password");
  await dialog.getByLabel("再次输入新主密码", { exact: true }).fill("different-password");
  await dialog.getByRole("button", { name: "保存新密码", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("不一致");
  expect(await commandCount(page, "vault_change_password")).toBe(0);
  await dialog.getByLabel("再次输入新主密码", { exact: true }).fill("new-synthetic-password");
  await dialog.getByRole("button", { name: "保存新密码", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("主密码错误");
  await dialog.getByLabel("当前主密码", { exact: true }).fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "保存新密码", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("主密码已修改");
});

test("sync configuration excludes passwords and credential changes preserve library identity", async ({ page }) => {
  await page.goto("/?sync=connected");
  await openSettings(page);
  await page.locator("summary").filter({ hasText: "同步库名称与连接设置" }).click();
  await page.getByRole("button", { name: "显示加入配置二维码", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("不含密码或令牌密钥");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "更新网盘应用密码", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("新的网盘应用密码", { exact: true }).fill("replacement-synthetic-password");
  await dialog.getByRole("button", { name: "验证并更新连接", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await commandCount(page, "sync_update_credentials")).toBe(1);
  expect(await commandCount(page, "sync_disconnect")).toBe(0);
  await expect(page.locator(".sync-details")).toContainText("2971a71b-042c-4f28-b8ae-3c02b713f0f0");
});


test("hidden windows stop code polling and foreground rechecks native lock state", async ({ page }) => {
  await expect.poll(() => commandCount(page, "token_codes")).toBeGreaterThan(0);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const before = await commandCount(page, "token_codes");
  await page.waitForTimeout(1300);
  expect(await commandCount(page, "token_codes")).toBe(before);
  await page.evaluate(async () => { await (window as any).__TAURI_INTERNALS__.invoke("vault_lock"); Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator(".token-card")).toHaveCount(0);
  await expect(page.getByLabel("解锁密码", { exact: true })).toBeVisible();
});

test("a suspended phone locks before showing codes when returning after a minute", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { configurable: true, value: "SteamGuard Android" }));
  await page.reload();
  await expect(page.locator(".token-card")).toHaveCount(3);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await commandCount(page, "vault_background")).toBe(1);
  // Advance wall time without running setTimeout: the WebView was suspended.
  await page.evaluate(() => {
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = realNow;
  });
  await expect(page.locator(".token-card")).toHaveCount(0);
  await expect(page.getByLabel("解锁密码", { exact: true })).toBeVisible();
  expect(await commandCount(page, "vault_lock")).toBe(1);
  const lifecycle = await page.evaluate(() => (window as any).__testCommands.filter((c: any) => c.command === "vault_background").map((c: any) => c.args.hidden));
  expect(lifecycle).toEqual([true, false]);
});

test("joining through a config QR fills only public connection fields", async ({ page }) => {
  await openSettings(page);
  await page.locator("summary").filter({ hasText: "从另一台设备的配置二维码加入" }).click();
  const config = { version: 1, endpoint: "https://dav.other.example.test/dav/", username: "public-account@example.test", libraryId: "2971a71b-042c-4f28-b8ae-3c02b713f0f0" };
  await page.getByLabel("读取二维码图片", { exact: true }).setInputFiles(await qrImage(JSON.stringify(config)));
  await expect(page.getByLabel("WebDAV 地址", { exact: true })).toHaveValue(config.endpoint);
  await expect(page.getByLabel("网盘账号", { exact: true })).toHaveValue(config.username);
  await expect(page.getByLabel("同步库编号", { exact: true })).toHaveValue(config.libraryId);
  await expect(page.getByLabel("网盘应用密码", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("独立同步密码", { exact: true })).toHaveValue("");
  expect(await commandCount(page, "sync_connect")).toBe(0);
});

test("manual TOTP and editing a secondary HOTP omit unsupported counters", async ({ page }) => {
  await page.getByRole("button", { name: "添加令牌", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "手动添加", exact: true }).click();
  await dialog.getByLabel("账户或显示名称", { exact: true }).fill("TOTP 默认参数");
  await dialog.getByLabel("密钥（Base32）", { exact: true }).fill("GEZDGNBVGY3TQOJQ");
  await dialog.getByRole("button", { name: "保存令牌", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const input = await page.evaluate(() => (window as any).__testCommands.find((c: any) => c.command === "token_create").args.input);
  expect(input.kind).toBe("totp");
  expect(input.counter).toBeUndefined();
  await page.getByRole("button", { name: "管理 TOTP 默认参数", exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__testCommands.filter((c: any) => c.command === "token_update").at(-1).args.parameters.counter)).toBeUndefined();
  await page.goto("/?sync=hotp");
  await page.getByRole("button", { name: "管理 测试 · 通用 OTP", exact: true }).click();
  await dialog.locator("summary").filter({ hasText: "高级参数" }).click();
  await expect(dialog.getByLabel("计数器", { exact: true })).toBeDisabled();
  await dialog.getByLabel("显示名称", { exact: true }).fill("副设备改名");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "副设备改名", exact: true })).toBeVisible();
  const parameters = await page.evaluate(() => (window as any).__testCommands.find((c: any) => c.command === "token_update").args.parameters);
  expect(parameters.counter).toBeUndefined();
});

test("backup diff restores only checked entries and prevents selecting conflicts", async ({ page }) => {
  await page.goto("/?backupDiff");
  await openSettings(page);
  await page.locator(".backup-panel").getByRole("button", { name: "查看", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("备份主密码", { exact: true }).fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "验证并预览备份", exact: true }).click();
  const preview = dialog.getByRole("region", { name: "备份差异预览", exact: true });
  await expect(preview.locator("label").filter({ hasText: "密钥冲突的令牌" }).getByRole("checkbox")).toBeDisabled();
  await preview.locator("label").filter({ hasText: "恢复的令牌" }).getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "恢复所选令牌", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已恢复所选的 1 个令牌");
  const args = await page.evaluate(() => (window as any).__testCommands.find((c: any) => c.command === "backup_restore_selected").args);
  expect(args).toEqual({ previewId: "backup-diff", ids: ["totp-test"] });
});

test("external automatic backup chooser cancellation and reset preserve a compact phone layout", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/?externalBackup");
  await openSettings(page);
  const setting = page.locator(".external-backup-setting");
  await expect(setting).toContainText("尚未选择目录");
  await setting.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(setting).toContainText("DeviceBackups");
  await page.evaluate(() => Object.assign(window, { __cancelBackupDirectory: true }));
  await setting.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(setting).toContainText("DeviceBackups");
  await setting.getByRole("button", { name: "重置目录", exact: true }).click();
  await expect(setting).toContainText("尚未选择目录");
  await expect(setting.getByRole("button", { name: "重置目录", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});

test("tray keyboard copies through native validation and polling avoids full avatar snapshots", async ({ page }) => {
  await page.goto("/?view=tray&manyTokens");
  await expect(page.locator(".tray-token")).toHaveCount(6);
  const snapshots = await commandCount(page, "desktop_snapshot");
  const search = page.getByRole("textbox", { name: "搜索令牌", exact: true });
  await search.focus();
  await search.press("ArrowDown");
  await expect(page.getByRole("button", { name: "复制 测试 · Steam 验证码", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "复制 测试 · 待登录 验证码", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).__testCommands.filter((c: any) => c.command === "desktop_copy").at(-1).args.id)).toBe("steam-offline");
  await search.fill("通用");
  await search.press("Enter");
  expect(await page.evaluate(() => (window as any).__testCommands.filter((c: any) => c.command === "desktop_copy").at(-1).args.id)).toBe("totp-test");
  await expect.poll(() => commandCount(page, "desktop_codes")).toBeGreaterThan(0);
  expect(await commandCount(page, "desktop_snapshot")).toBe(snapshots);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tray-token")).toHaveCount(0);
  expect(await commandCount(page, "desktop_hide")).toBe(1);
});

test("a late tray snapshot cannot reveal codes after the popup loses focus", async ({ page }) => {
  await page.goto("/?view=tray&deferDesktopSnapshot");
  await expect.poll(() => page.evaluate(() => typeof (window as any).__resolveDesktopSnapshot)).toBe("function");
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); (window as any).__resolveDesktopSnapshot(); });
  await page.waitForTimeout(1100);
  await expect(page.locator(".tray-token")).toHaveCount(0);
  expect(await commandCount(page, "desktop_codes")).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tray-token")).toHaveCount(3);
});

for (const [width, language] of [[320, "zh-CN"], [390, "ar"], [1180, "en"]] as const) {
  test(`dark theme and large text remain readable at ${width}px in ${language}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await openSettings(page);
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await page.getByLabel("文字大小", { exact: true }).selectOption("125");
    await page.getByRole("combobox", { name: "应用语言", exact: true }).selectOption(language);
    await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `artifacts/qa-dark-settings-${width}-${language}.png`, fullPage: true });
    const navigation = page.locator(width <= 900 ? ".mobile-nav button" : ".sidebar nav button");
    await navigation.first().click();
    await expect(page.locator(".token-card")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `artifacts/qa-dark-tokens-${width}-${language}.png`, fullPage: true });
    await page.locator(".token-menu").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const contrasts = await page.locator(".modal").evaluate(modal => {
      const channels = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
      const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      return ["h2", ".field-label", "input", ".danger-text", ".button.primary"].map(selector => {
        const element = modal.querySelector(selector)!;
        const foreground = channels(getComputedStyle(element).color);
        let backgroundElement: Element | null = element;
        let background = channels(getComputedStyle(element).backgroundColor);
        while (background.length === 4 && background[3] === 0 && backgroundElement?.parentElement) {
          backgroundElement = backgroundElement.parentElement;
          background = channels(getComputedStyle(backgroundElement).backgroundColor);
        }
        const a = luminance(foreground), b = luminance(background);
        return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    });
    for (const contrast of contrasts) expect(contrast.ratio, contrast.selector).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `artifacts/qa-dark-modal-${width}-${language}.png`, fullPage: true });
  });
}


test("a current-code request finishing after manual lock cannot write the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => { await navigator.clipboard.writeText("unchanged-before-lock"); Object.assign(window, { __deferCurrentCode: true }); });
  await page.getByRole("button", { name: "复制 测试 · 通用 OTP 验证码", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__resolveCurrentCode)).toBe("function");
  await openSettings(page);
  await page.getByRole("button", { name: "锁定保险库", exact: true }).click();
  await expect(page.getByLabel("解锁密码", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__resolveCurrentCode());
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged-before-lock");
});

test("scanning a Steam login QR only fills the request and still requires review and approval", async ({ page }) => {
  const card = page.locator(".token-card").filter({ has: page.getByRole("heading", { name: "测试 · Steam", exact: true }) });
  await card.getByRole("button", { name: "已登录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "批准二维码登录" }).click();
  await dialog.getByLabel("读取二维码图片", { exact: true }).setInputFiles(await qrImage("https://example.test/not-a-steam-login"));
  await expect(dialog.getByRole("alert")).toContainText("有效的 Steam 登录二维码");
  expect(await commandCount(page, "steam_qr_info")).toBe(0);
  expect(await commandCount(page, "steam_qr_approve")).toBe(0);
  await dialog.getByLabel("读取二维码图片", { exact: true }).setInputFiles(await qrImage("https://s.team/q/1/123456789"));
  await expect(dialog.getByLabel("Steam 登录二维码链接", { exact: true })).toHaveValue("https://s.team/q/1/123456789");
  expect(await commandCount(page, "steam_qr_info")).toBe(0);
  expect(await commandCount(page, "steam_qr_approve")).toBe(0);
  await dialog.getByRole("button", { name: "核对登录请求", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Fixture PC", exact: true })).toBeVisible();
  expect(await commandCount(page, "steam_qr_approve")).toBe(0);
  await dialog.getByRole("button", { name: "批准登录", exact: true }).click();
  await expect.poll(() => commandCount(page, "steam_qr_approve")).toBe(1);
});
