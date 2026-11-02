import { useId, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import {
  getLanguagePreference, languages, setLanguagePreference, subscribeLanguagePreference,
  type LanguagePreference,
} from "./i18n";

/** Device preference is available on both the locked and unlocked settings screens. */
export function LanguageSettings({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const preference = useSyncExternalStore(subscribeLanguagePreference, getLanguagePreference, () => "system" as const);
  return (
    <section className={`settings-panel language-settings${compact ? " language-settings-compact" : ""}`} aria-labelledby={`${id}-title`}>
      <div className="panel-title">
        <Languages size={19} aria-hidden="true" />
        <h2 id={`${id}-title`}>{t("语言")}</h2>
      </div>
      <label className="setting-row" htmlFor={`${id}-select`}>
        <span>{t("应用语言")}</span>
        <select id={`${id}-select`} value={preference} onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)}>
          <option value="system">{t("跟随系统")}</option>
          {languages.map((language) => <option key={language.code} value={language.code} lang={language.code} dir={language.direction}>{language.name}</option>)}
        </select>
      </label>
      {!compact && <p className="form-hint">{t("仅保存在这台设备，不随令牌同步。")}</p>}
    </section>
  );
}
