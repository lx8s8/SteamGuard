import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";
import it from "./locales/it.json";
import ar from "./locales/ar.json";
import hi from "./locales/hi.json";
import id from "./locales/id.json";
import tr from "./locales/tr.json";
import vi from "./locales/vi.json";

/** Every resource is bundled at build time; locale selection never fetches a remote file. */
export const resources = {
  "zh-CN": { translation: zhCN },
  "zh-TW": { translation: zhTW },
  en: { translation: en }, ja: { translation: ja }, ko: { translation: ko },
  de: { translation: de }, fr: { translation: fr }, es: { translation: es },
  "pt-BR": { translation: ptBR }, ru: { translation: ru }, it: { translation: it },
  ar: { translation: ar }, hi: { translation: hi }, id: { translation: id },
  tr: { translation: tr }, vi: { translation: vi },
};
