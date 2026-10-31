import { expect, test, type Page } from "@playwright/test";

// Synthetic data only. These UI tests do not contact Steam or load private exports.
async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    const tokens = [
      {
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
    const quickScenario = new URLSearchParams(location.search).get("quick");
    let locked = !!quickScenario;
    let previewEnabled = quickScenario === "preview";
    let biometricEnabled =
      quickScenario === "biometric" || quickScenario === "cancel";
    let previewActive = false;
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
            case "vault_status":
              return {
                initialized: true,
                locked,
                tokenCount: tokens.length,
                previewEnabled,
                biometricEnabled,
                previewActive,
              };
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
            case "import_preview":
              return {
                previewId: "fixture-preview",
                tokens: [
                  { name: "测试 · 导入令牌", issuer: "Example", kind: "totp" },
                ],
                duplicates: 0,
              };
            case "import_commit":
              tokens.push({
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
