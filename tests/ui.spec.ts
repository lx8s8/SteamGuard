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
    let locked = false;
    const commands: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      isTauri: true,
      __testCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          commands.push({ command, args });
          switch (command) {
            case "vault_status":
              return { initialized: true, locked, tokenCount: tokens.length };
            case "list_tokens":
              return locked ? [] : tokens;
            case "vault_unlock":
              locked = false;
              return;
            case "vault_lock":
              locked = true;
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
            case "steam_login":
              return {
                status: "guard",
                guards: [{ confirmationType: 3, associatedMessage: "" }],
                pollInterval: 10_000,
              };
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
              return { status: "pending", guards: [], pollInterval: 10_000 };
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
