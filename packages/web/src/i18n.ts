import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export type AppLanguage = "zh-CN" | "en";
export const DEFAULT_LANGUAGE: AppLanguage = "zh-CN";

/**
 * Where this browser keeps a copy of the appearance the page last applied (argelander/preferences.tsx). It is not
 * the authority — config.toml is — and is only looked at when the page was not served with the configured values.
 */
export const UI_MIRROR_KEY = "argelander.ui";

/**
 * The language the page starts in, before the settings are read: the one the server put on `<html>` when it served
 * the page from config.toml, else this browser's copy, else the default.
 */
export function initialLanguage(): AppLanguage {
  try {
    const root = document.documentElement;
    if (root.getAttribute("data-ui-from") === "config" && (root.lang === "zh-CN" || root.lang === "en")) return root.lang;
    const raw = localStorage.getItem(UI_MIRROR_KEY);
    const lang = raw ? (JSON.parse(raw) as { language?: unknown }).language : undefined;
    if (lang === "zh-CN" || lang === "en") return lang;
  } catch {
    /* no document, no storage, or a malformed copy — fall back to the default */
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
