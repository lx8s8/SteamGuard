import type { Language } from "./languages";

type LocaleMessages = Record<string, string>;
type LocaleLoader = () => Promise<{ default: LocaleMessages }>;

/** 所有语言包在构建时拆分为本地离线 chunk，按当前语言按需加载，不发起任何远程请求。 */
export const localeLoaders: Record<Language, LocaleLoader> = {
  "zh-CN": () => import("./locales/zh-CN.json"),
  "zh-TW": () => import("./locales/zh-TW.json"),
  en: () => import("./locales/en.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  de: () => import("./locales/de.json"),
  fr: () => import("./locales/fr.json"),
  es: () => import("./locales/es.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ru: () => import("./locales/ru.json"),
  it: () => import("./locales/it.json"),
  ar: () => import("./locales/ar.json"),
  hi: () => import("./locales/hi.json"),
  id: () => import("./locales/id.json"),
  tr: () => import("./locales/tr.json"),
  vi: () => import("./locales/vi.json"),
};

const cache = new Map<Language, Promise<LocaleMessages>>();

/** 加载指定语言的离线翻译词典并缓存，避免重复解析。 */
export function loadLocaleMessages(language: Language): Promise<LocaleMessages> {
  let pending = cache.get(language);
  if (!pending) {
    pending = localeLoaders[language]().then((module) => module.default);
    cache.set(language, pending);
  }
  return pending;
}
