import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const resource = (language: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), "utf8")) as Record<string, string>;

test("changing English to Japanese preserves form state and persists on reload", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("steamguard.language")) localStorage.setItem("steamguard.language", "en");
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: resource("en")["创建保险库"], exact: true })).toBeVisible();
  await page.locator("#vault-password").fill("synthetic-form-state");
  await page.getByRole("combobox").selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("button", { name: resource("ja")["创建保险库"], exact: true })).toBeVisible();
  await expect(page.locator("#vault-password")).toHaveValue("synthetic-form-state");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("combobox")).toHaveValue("ja");
});

test.describe("system language", () => {
  test.use({ locale: "ja-JP" });
  test("resolves a regional locale without saving a forced language", async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem("steamguard.language"));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("combobox")).toHaveValue("system");
    await expect(page.getByRole("button", { name: resource("ja")["创建保险库"], exact: true })).toBeVisible();
  });
});

test("Arabic uses RTL, localized formatting, literal account names and ASCII OTPs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("steamguard.language", "ar"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: resource("ar")["创建保险库"], exact: true })).toBeVisible();
  const formatted = await page.evaluate(async () => {
    // Load the same module as the app; no production-only test globals are added.
    const module = await import("/src/i18n.ts");
    const account = "synthetic@example.test";
    return {
      number: module.formatNumber(123456),
      expectedNumber: new Intl.NumberFormat(module.getCurrentLocale()).format(123456),
      date: module.formatDateTime(Date.UTC(2026, 10, 2), { year: "numeric", month: "long", timeZone: "UTC" }),
      otp: module.formatOtp("001234"),
      steam: module.formatOtp("AB2CD"),
      unknown: module.translateNativeText(account),
      error: module.translateError("保险库已锁定"),
      literalLabel: module.translateNativeText("重复 Steam 令牌的 保险库已锁定 冲突"),
      quantity: module.t("识别到 {{length}} 个令牌", { length: 123456 }),
    };
  });
  expect(formatted.number).toBe(formatted.expectedNumber);
  expect(formatted.date).toMatch(/\p{Script=Arabic}/u);
  expect(formatted.otp).toBe("001234");
  expect(formatted.steam).toBe("AB2CD");
  expect(formatted.unknown).toBe("synthetic@example.test");
  expect(formatted.error).toBe(resource("ar")["保险库已锁定"]);
  expect(formatted.literalLabel).toBe(resource("ar")["重复 Steam 令牌的 {{label}} 冲突"].replace("{{label}}", "保险库已锁定"));
  expect(formatted.quantity).toContain(formatted.expectedNumber);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("combobox").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("native menus and authentication prompt receive the selected language", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("steamguard.language", "en");
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      isTauri: true, __languageNativeCalls: calls,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        if (command === "vault_status") return { initialized: true, locked: true, tokenCount: 0 };
        if (command === "backup_status") return { enabled: true, entries: [] };
        return null;
      } },
    });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect.poll(() => page.evaluate(() => (window as any).__languageNativeCalls.filter((call: any) => call.command === "desktop_localize").length)).toBeGreaterThan(0);
  await page.getByRole("combobox").selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  const labels = await page.evaluate(() => {
    const calls = (window as any).__languageNativeCalls as { command: string; args: Record<string, any> }[];
    return { menus: calls.filter(call => call.command === "desktop_localize").at(-1)?.args.labels, prompt: calls.filter(call => call.command === "ui_localize").at(-1)?.args };
  });
  expect(labels.menus.open).toBe(resource("ja")["打开应用"]);
  expect(labels.menus.lock).toBe(resource("ja")["锁定"]);
  expect(labels.prompt.reason).toBe(resource("ja")["验证后解锁 SteamGuard"]);
  expect(labels.prompt.fallback).toBe(resource("ja")["使用主密码"]);
});
