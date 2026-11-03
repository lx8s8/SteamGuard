import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, preciseClock = false) {
  await page.addInitScript((preciseClock) => {
    localStorage.setItem("steamguard.language", "zh-CN");
    const token = { id: "animation-fixture", name: "Animation fixture", issuer: "Example", kind: "totp", code: "123456", remaining: 24, period: 30, loggedIn: false };
    const calls: string[] = [];
    let clockAnchored = false;
    Object.assign(window, {
      isTauri: true,
      __otpCalls: calls,
      __otpSample: (value: object) => Object.assign(token, value),
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          calls.push(command);
          switch (command) {
            case "vault_status": return { initialized: true, locked: false, tokenCount: 1 };
            case "list_tokens": {
              if (preciseClock && !clockAnchored) {
                clockAnchored = true;
                const start = performance.now();
                Date.now = () => 1_793_318_400_950 + Math.floor(performance.now() - start);
              }
              return [{ ...token }];
            }
            case "token_groups": return [];
            case "token_codes":
            case "desktop_codes": return { revision: "animation-fixture", codes: [{ ...token }] };
            case "desktop_snapshot": return { revision: "animation-fixture", initialized: true, locked: false, preview: false, previewEnabled: false, tokens: [{ ...token }] };
            case "sync_status": return { configured: false, active: false };
            case "desktop_settings": return { supported: false };
            default: return null;
          }
        },
      },
    });
  }, preciseClock);
}
const scale = (page: Page, selector: string) => page.locator(selector).evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a);

for (const view of ["main", "tray"]) {
  test(`${view} countdown decreases between native polls without per-frame IPC`, async ({ page }) => {
    await fixture(page);
    await page.goto(view === "tray" ? "/?view=tray" : "/");
    if (view === "tray") await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const selector = view === "tray" ? ".tray-progress .otp-progress-fill" : ".token-progress .otp-progress-fill";
    await expect(page.locator(selector)).toBeVisible();
    const before = await scale(page, selector);
    await page.waitForTimeout(180);
    const middle = await scale(page, selector);
    await page.waitForTimeout(180);
    const after = await scale(page, selector);
    expect(before - middle).toBeGreaterThan(0.002);
    expect(middle - after).toBeGreaterThan(0.002);
    expect(before - after).toBeLessThan(0.025);
    expect(await page.locator(selector).evaluate(node => node.getAnimations().filter(animation => animation.playState === "running").length)).toBe(1);
    const codeCalls = await page.evaluate(() => (window as any).__otpCalls.filter((name: string) => name === "token_codes" || name === "desktop_codes").length);
    expect(codeCalls).toBeLessThanOrEqual(1);
  });
}

test("a new native cycle refills immediately and never animates backwards", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const progress = page.getByRole("progressbar");
  await expect(progress).toBeVisible();
  await page.evaluate(() => (window as any).__otpSample({ remaining: 1, code: "111111" }));
  await expect(progress).toHaveAttribute("aria-valuenow", "1");
  await page.waitForTimeout(1100);
  expect(await scale(page, ".otp-progress-fill")).toBeLessThan(0.002);
  await page.evaluate(() => (window as any).__otpSample({ remaining: 30, code: "222222" }));
  await expect(progress).toHaveAttribute("aria-valuenow", "30");
  expect(await scale(page, ".otp-progress-fill")).toBeGreaterThan(0.95);
  const frames = await page.locator(".otp-progress-fill").evaluate(node => node.getAnimations()[0].effect!.getKeyframes().map(frame => frame.transform));
  expect(Number(String(frames[0]).match(/scaleX\((.+)\)/)?.[1])).toBeGreaterThan(0.96);
  expect(frames[1]).toBe("scaleX(0)");
  await expect(page.getByRole("button", { name: "复制 Animation fixture 验证码" })).toHaveText("222222");
});

test("hidden documents stop animations and native code polling", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const fill = page.locator(".otp-progress-fill");
  await expect(fill).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await fill.evaluate(node => node.getAnimations().length)).toBe(0);
  const before = await page.evaluate(() => (window as any).__otpCalls.filter((name: string) => name === "token_codes").length);
  await page.waitForTimeout(1150);
  expect(await page.evaluate(() => (window as any).__otpCalls.filter((name: string) => name === "token_codes").length)).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(fill).toBeVisible();
  await expect.poll(() => fill.evaluate(node => node.getAnimations().length)).toBe(1);
});

test("reduced motion keeps the countdown readable without continuous animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.goto("/");
  const fill = page.locator(".otp-progress-fill");
  await expect(fill).toBeVisible();
  expect(await fill.evaluate(node => node.getAnimations().length)).toBe(0);
  const before = await scale(page, ".otp-progress-fill");
  await page.waitForTimeout(220);
  expect(await scale(page, ".otp-progress-fill")).toBe(before);
  await expect(page.getByRole("button", { name: "复制 Animation fixture 验证码" })).toHaveText("123456");
});

test("reduced motion repaints a fresh native remaining value instead of retaining the old sample", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, true);
  await page.goto("/");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "24");
  const before = await scale(page, ".otp-progress-fill");
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    (window as any).__otpSample({ remaining: 23 });
    window.dispatchEvent(new Event("steamguard:sync-updated"));
  });
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "23");
  // Browser startup can cross the fixture's fractional-second boundary.
  // Verify the real decrease from its first paint, rather than assuming that
  // the first React commit happened within 50 ms of list_tokens returning.
  await expect.poll(() => scale(page, ".otp-progress-fill")).toBeLessThan(before - 0.025);
  expect(await scale(page, ".otp-progress-fill")).toBeLessThanOrEqual(23 / 30 + 0.000001);
  expect(await page.locator(".otp-progress-fill").evaluate(node => node.getAnimations().length)).toBe(0);
});

test("a delayed same-code sample cannot make the countdown gain a second", async ({ page }) => {
  await fixture(page, true);
  await page.goto("/");
  const progress = page.getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "24");
  await page.waitForTimeout(1120);
  const before = await scale(page, ".otp-progress-fill");
  await page.evaluate(() => {
    (window as any).__otpSample({ remaining: 23 });
    window.dispatchEvent(new Event("steamguard:sync-updated"));
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "23");
  expect(await scale(page, ".otp-progress-fill")).toBeLessThanOrEqual(before + 0.001);
  // An older response can also arrive after a newer one, without being a wrap.
  await page.evaluate(() => {
    (window as any).__otpSample({ remaining: 24 });
    window.dispatchEvent(new Event("steamguard:sync-updated"));
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "24");
  expect(await scale(page, ".otp-progress-fill")).toBeLessThanOrEqual(before + 0.001);
});

test("successful explicit clock synchronization reanchors on the next native sample", async ({ page }) => {
  await fixture(page, true);
  await page.goto("/");
  const progress = page.getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "24");
  await page.waitForTimeout(1120);
  const before = await scale(page, ".otp-progress-fill");
  await page.evaluate(async () => {
    const { api } = await import("/src/api.ts");
    await api.syncTime();
    (window as any).__otpSample({ remaining: 25 });
    window.dispatchEvent(new Event("steamguard:sync-updated"));
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "25");
  expect(await scale(page, ".otp-progress-fill")).toBeGreaterThan(before + 0.04);
});
