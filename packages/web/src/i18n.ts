import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export type AppLanguage = "zh-CN" | "en";
export const DEFAULT_LANGUAGE: AppLanguage = "zh-CN";

// Same localStorage key as useTweaks (argelander/theme.ts); language is one of its fields.
const TWEAKS_LS_KEY = "argelander.tweaks";

export function initialLanguage(): AppLanguage {
  try {
    const raw = localStorage.getItem(TWEAKS_LS_KEY);
    const lang = raw ? (JSON.parse(raw) as { language?: unknown }).language : undefined;
    if (lang === "zh-CN" || lang === "en") return lang;
  } catch {
    /* localStorage unavailable or malformed — fall back to default */
  }
  return DEFAULT_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

export default i18n;
