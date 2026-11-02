import i18n, { type FormatterModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { resources } from "./i18n/resources";
import nativeMessages from "./i18n/native-messages.json";
import {
  languages, languageStorageKey, parsePreference, resolveLanguage,
  type Language, type LanguagePreference,
} from "./i18n/languages";
export { languages, languageStorageKey, matchLanguage, resolveLanguage } from "./i18n/languages";
export type { Language, LanguagePreference } from "./i18n/languages";

const systemLanguages = () => typeof navigator === "undefined" ? ["en"] : navigator.languages?.length ? navigator.languages : [navigator.language];
function readPreference(): LanguagePreference {
  try { return parsePreference(globalThis.localStorage?.getItem(languageStorageKey)); }
  catch { return "system"; }
}
let preference = readPreference();
const listeners = new Set<() => void>();
const quantities = new Set(["count", "length", "tokenCount", "groupCount", "duplicates", "remaining", "period", "received", "expected", "newCount", "updateCount", "unchangedCount", "conflictCount", "latencyMs"]);
const extraFormats = new Map<string, (value: unknown, language: string | undefined, options: unknown) => string>();
const quantityFormatter: FormatterModule = {
  type: "formatter",
  init() {},
  add(name, formatter) { extraFormats.set(name, formatter); },
  addCached(name, factory) { extraFormats.set(name, (value, language, options) => factory(language, options)(value)); },
  format(value, format, language, options) {
    const extra = format ? extraFormats.get(format) : undefined;
    if (extra) return extra(value, language, options);
    // Only quantities are localized. IDs, protocol values, versions and OTP strings stay literal.
    if (typeof value === "number" && quantities.has(options?.interpolationkey)) {
      const locale = languages.find(({ code }) => code === language)?.locale ?? "en-US";
      return new Intl.NumberFormat(locale).format(value);
    }
    return value == null ? "" : String(value);
  },
};
export const getLanguagePreference = () => preference;
export const getCurrentLanguage = (): Language => resolveLanguage(preference, systemLanguages());
export const getCurrentLocale = () => languages.find(({ code }) => code === getCurrentLanguage())!.locale;
export function subscribeLanguagePreference(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function updateDocument(language: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
}
void i18n.use(quantityFormatter).use(initReactI18next).init({
  resources,
  lng: getCurrentLanguage(),
  fallbackLng: ["en", "zh-CN"],
  supportedLngs: languages.map(({ code }) => code),
  load: "currentOnly",
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: {
    escapeValue: false, // React escapes every rendered string.
    alwaysFormat: true,
  },
  react: { useSuspense: false, bindI18n: "languageChanged" },
});
updateDocument(i18n.language);
let nativeLabelsReady: Promise<unknown> = Promise.resolve();
export function awaitNativeLocalization() { return nativeLabelsReady; }
function localizeDesktopMenu() {
  if (typeof window === "undefined" || !isTauri() || new URLSearchParams(window.location.search).get("view") === "tray") return;
  const menus = invoke("desktop_localize", { labels: {
    open: i18n.t("打开应用"), lock: i18n.t("锁定"), quit: i18n.t("退出"),
    tokens: i18n.t("令牌"), quick: i18n.t("快捷复制"),
  } }).catch(() => { /* Menu localization does not block mobile/older native hosts. */ });
  const dialogs = invoke("ui_localize", {
    reason: i18n.t("验证后解锁 SteamGuard"), fallback: i18n.t("使用主密码"),
  }).catch(() => { /* Unsupported/older hosts use their built-in system prompt. */ });
  nativeLabelsReady = Promise.all([menus, dialogs]);
}
localizeDesktopMenu();
i18n.on("languageChanged", (language) => {
  updateDocument(language);
  localizeDesktopMenu();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("steamguard:languagechange", { detail: { language, preference } }));
});
function applyPreference(value: LanguagePreference) {
  preference = value;
  void i18n.changeLanguage(getCurrentLanguage());
  listeners.forEach((listener) => listener());
}
export function setLanguagePreference(value: LanguagePreference) {
  const valid = parsePreference(value);
  try { globalThis.localStorage?.setItem(languageStorageKey, valid); }
  catch { /* Memory preference still works when device storage is unavailable. */ }
  applyPreference(valid);
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === languageStorageKey || event.key === null) applyPreference(readPreference());
  });
  window.addEventListener("languagechange", () => {
    if (preference === "system") applyPreference("system");
  });
}

/** Safe only for application-owned source keys; never pass token/account names here. */
export const t: typeof i18n.t = i18n.t.bind(i18n);
export default i18n;

export function formatDateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(getCurrentLocale(), options ?? { dateStyle: "medium", timeStyle: "short" }).format(date);
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(getCurrentLocale(), options).format(value);
}
/** OTPs are protocol values, never localized numbers. Preserve leading zeros and Steam letters. */
export function formatOtp(value: string): string { return value; }

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nativePatterns = Object.entries(nativeMessages).filter(([source]) => /\{(?:[a-zA-Z_]\w*)?\}/.test(source)).map(([source, key]) => {
  const names: string[] = [];
  let index = 0;
  let last = 0;
  let pattern = "^";
  for (const match of source.matchAll(/\{([a-zA-Z_]\w*)?\}/g)) {
    index += 1;
    pattern += escapeRegExp(source.slice(last, match.index)) + "([\\s\\S]*?)";
    names.push(match[1] || `value${index}`);
    last = match.index! + match[0].length;
  }
  pattern += escapeRegExp(source.slice(last)) + "$";
  return { expression: new RegExp(pattern, "u"), source, key, names };
});
const nestedNativeSlots: Record<string, ReadonlySet<string>> = {
  "{operation}失败：{}（EResult {result}）": new Set(["operation", "value2"]),
  "{}失败（HTTP {}）：{}": new Set(["value1", "value3"]),
};

/** Translate only exact, known native messages and anchored templates. Variable values stay data. */
export function translateNativeText(message: string): string {
  const key = (nativeMessages as Record<string, string>)[message];
  if (key) return t(key);
  if (message.length > 8192) return message;
  for (const { expression, source, key: template, names } of nativePatterns) {
    const match = expression.exec(message);
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, index) => {
      const value = match[index + 1];
      // Only known operation/reason slots may contain another native label. User values stay literal,
      // even when an account or file happens to have the same name as an application message.
      const nested = nestedNativeSlots[source]?.has(name) ? (nativeMessages as Record<string, string>)[value] : undefined;
      return [name, nested ? t(nested) : value];
    }));
    return t(template, values);
  }
  return message;
}
export function translateError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
  const translated = translateNativeText(message);
  if (translated !== message) return translated;
  if (i18n.exists(message)) return t(message);
  const activeMessages = resources[getCurrentLanguage()].translation;
  if (Object.values(activeMessages).includes(message)) return message;
  return t("操作未完成：{{detail}}", { detail: message });
}
export const errorText = translateError;
