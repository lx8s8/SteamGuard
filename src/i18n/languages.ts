/** Canonical tags are shared with the native menu. Keep this list stable. */
export const languages = [
  { code: "zh-CN", name: "简体中文", locale: "zh-CN", direction: "ltr" },
  { code: "zh-TW", name: "繁體中文", locale: "zh-TW", direction: "ltr" },
  { code: "en", name: "English", locale: "en-US", direction: "ltr" },
  { code: "ja", name: "日本語", locale: "ja-JP", direction: "ltr" },
  { code: "ko", name: "한국어", locale: "ko-KR", direction: "ltr" },
  { code: "de", name: "Deutsch", locale: "de-DE", direction: "ltr" },
  { code: "fr", name: "Français", locale: "fr-FR", direction: "ltr" },
  { code: "es", name: "Español", locale: "es-ES", direction: "ltr" },
  { code: "pt-BR", name: "Português (Brasil)", locale: "pt-BR", direction: "ltr" },
  { code: "ru", name: "Русский", locale: "ru-RU", direction: "ltr" },
  { code: "it", name: "Italiano", locale: "it-IT", direction: "ltr" },
  { code: "ar", name: "العربية", locale: "ar", direction: "rtl" },
  { code: "hi", name: "हिन्दी", locale: "hi-IN", direction: "ltr" },
  { code: "id", name: "Bahasa Indonesia", locale: "id-ID", direction: "ltr" },
  { code: "tr", name: "Türkçe", locale: "tr-TR", direction: "ltr" },
  { code: "vi", name: "Tiếng Việt", locale: "vi-VN", direction: "ltr" },
] as const;
export type Language = (typeof languages)[number]["code"];
export type LanguagePreference = Language | "system";
export const languageStorageKey = "steamguard.language";

export function isLanguage(value: unknown): value is Language {
  return languages.some((language) => language.code === value);
}

/** Unsupported system languages fall back to English. Chinese scripts take priority over regions. */
export function matchLanguage(value: string): Language | undefined {
  const tag = value.trim().replaceAll("_", "-").toLowerCase();
  if (tag === "zh" || tag.startsWith("zh-")) {
    if (tag.includes("hant")) return "zh-TW";
    if (tag.includes("hans")) return "zh-CN";
    return /(?:^|-)(tw|hk|mo)(?:-|$)/.test(tag) ? "zh-TW" : "zh-CN";
  }
  const base = tag.split("-")[0];
  if (base === "pt") return "pt-BR";
  return languages.find((language) => language.code.toLowerCase() === base)?.code;
}

export function resolveLanguage(preference: LanguagePreference, systemLanguages: readonly string[]): Language {
  if (preference !== "system") return preference;
  for (const tag of systemLanguages) {
    const language = matchLanguage(tag);
    if (language) return language;
  }
  return "en";
}

export function parsePreference(value: unknown): LanguagePreference {
  return value === "system" || isLanguage(value) ? value : "system";
}
