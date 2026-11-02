import { expect, test, type Page } from "@playwright/test";
import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import {
  googlePages,
  otherBatchPage,
  qrPages,
  ordinaryQr,
} from "./qr-fixtures";

// Synthetic data only. These UI tests do not contact Steam or load private exports.
async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    const tokens = [
      {
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
    const commands: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      isTauri: true,
      __testCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          commands.push({ command, args });
          switch (command) {
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
                token.name = String(args.name);
                token.group = args.group ? String(args.group) : null;
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
            case "backup_now":
              return;
            case "backup_export":
              return "/fixture/SteamGuard-backup.sgvault";
            case "backup_restore": {
              if (args.password !== "synthetic-vault-password")
                throw new Error("密码错误或备份已损坏");
              if (!tokens.some((t) => t.id === "restored-fixture"))
                tokens.push({
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
                { batch: number; index: number; size: number }
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
              if (google && pages.some((p) => p.batch !== pages[0].batch))
                throw new Error(
                  "二维码来自不同的 Google 导出批次，请继续扫描同一次导出的二维码",
                );
              const missing = google
                ? Array.from({ length: pages[0].size }, (_, i) => i)
                    .filter((i) => !pages.some((p) => p.index === i))
                    .map((i) => i + 1)
                : [];
              return {
                source: google ? "google" : "otp",
                received: payloads.length,
                expected: google ? pages[0].size : payloads.length,
                missing,
                duplicateCodes: 0,
                tokenCount: payloads.length,
                complete: !missing.length,
                preview: missing.length
                  ? null
                  : {
                      previewId: "qr-fixture",
                      tokens: payloads.map((_, i) => ({
                        name: `Synthetic ${i + 1}`,
                        issuer: "Example",
                        kind: "totp",
                      })),
                      duplicates: 0,
                      canCommit: true,
                    },
              };
            }
            case "import_preview":
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
            case "import_commit":
              if (args.previewId === "fixture-groups") {
                groups.push("恢复分组");
                tokens[2].group = "恢复分组";
                return 0;
              }
              tokens.push({
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
  await dialog.getByRole("button", { name: "安全登录" }).click();
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
  await dialog.getByRole("button", { name: "安全登录" }).click();
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
  await dialog.getByRole("button", { name: "安全登录" }).click();
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
  await dialog.getByRole("button", { name: "安全登录" }).click();
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
  await dialog.getByRole("button", { name: "安全登录" }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.getByRole("button", { name: "立即锁定" }).click();
  await expect(
    page.getByRole("heading", { name: "解锁你的安全空间" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "测试 · Steam", exact: true }),
  ).toHaveCount(0);
});

test("saves a chosen proxy only on explicit save and shows endpoint diagnostics", async ({
  page,
}) => {
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
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
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
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
  await expect(page.getByText("免密码预览", { exact: true })).toBeVisible();
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
    await page
      .getByRole("navigation", { name: "移动端导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
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
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
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
  await dialog.getByRole("button", { name: "合并恢复", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("密码错误或备份已损坏");
  await dialog.getByLabel("备份主密码").fill("synthetic-vault-password");
  await dialog.getByRole("button", { name: "合并恢复", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("补回 1 个令牌");
  await expect(dialog.getByLabel("备份主密码")).toHaveValue("");
});

test("phone home opens on tokens without statistics or a large add panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".overview-grid")).toBeHidden();
  await expect(page.locator(".page-heading")).toBeHidden();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
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
  await expect(page.getByText("免密码预览", { exact: true })).toBeVisible();
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
