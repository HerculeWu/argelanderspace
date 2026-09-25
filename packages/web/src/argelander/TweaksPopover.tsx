import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AppLanguage } from "../i18n";
import { ActionButton } from "../ui";
import { ACCENTS, accentHex, type Density, type ThemeName, type Tweaks } from "./theme";

const DENSITIES: Density[] = ["compact", "regular", "comfy"];
const THEMES: ThemeName[] = ["dark", "light"];
const LANGUAGES: AppLanguage[] = ["zh-CN", "en"];

// Accent display names resolve at render time; keys must stay in sync with
// ACCENTS (theme.ts), whose entries drive the swatch list below.
const ACCENT_LABEL_KEYS = {
  azure: "shell.tweaks.accents.azure",
  teal: "shell.tweaks.accents.teal",
  violet: "shell.tweaks.accents.violet",
  amber: "shell.tweaks.accents.amber",
  neutral: "shell.tweaks.accents.neutral",
} as const;

export function TweaksPopover({
  tweaks,
  set,
  onClose,
}: {
  tweaks: Tweaks;
  set: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  return (
    <div className="tweaks-pop" data-ui="tweaks-popover" ref={ref}>
      <div className="tweak-sec">{t("shell.tweaks.theme.label")}</div>
      <div className="tweak-seg">
        {THEMES.map((th) => (
          <ActionButton
            key={th}
            unstyled
            mode="text"
            label={th === "dark" ? t("shell.tweaks.theme.dark") : t("shell.tweaks.theme.light")}
            tooltip={th === "dark" ? t("shell.tweaks.theme.dark") : t("shell.tweaks.theme.light")}
            aria-pressed={tweaks.theme === th}
            data-ui="theme-option" data-ui-key={th}
            className={"tweak-seg-btn" + (tweaks.theme === th ? " on" : "")}
            onClick={() => set("theme", th)}
          >
            {th === "dark" ? t("shell.tweaks.theme.dark") : t("shell.tweaks.theme.light")}
          </ActionButton>
        ))}
      </div>

      <div className="tweak-sec">{t("shell.tweaks.accents.label")}</div>
      <div className="tweak-swatches">
        {Object.keys(ACCENTS).map((k) => (
          <ActionButton
            key={k}
            unstyled
            mode="icon"
            iconName="circle"
            label={t(ACCENT_LABEL_KEYS[k as keyof typeof ACCENT_LABEL_KEYS])}
            tooltip={t(ACCENT_LABEL_KEYS[k as keyof typeof ACCENT_LABEL_KEYS])}
            aria-pressed={tweaks.accent === k}
            data-ui="accent-option" data-ui-key={k}
            className={"tweak-swatch" + (tweaks.accent === k ? " on" : "")}
            style={{ background: accentHex(k, tweaks.theme) }}
            onClick={() => set("accent", k)}
          />
        ))}
      </div>

      <div className="tweak-sec">{t("shell.tweaks.density.label")}</div>
      <div className="tweak-seg">
        {DENSITIES.map((d) => (
          <ActionButton
            key={d}
            unstyled
            mode="text"
            label={d === "compact" ? t("shell.tweaks.density.compact") : d === "regular" ? t("shell.tweaks.density.regular") : t("shell.tweaks.density.comfy")}
            tooltip={d === "compact" ? t("shell.tweaks.density.compact") : d === "regular" ? t("shell.tweaks.density.regular") : t("shell.tweaks.density.comfy")}
            aria-pressed={tweaks.density === d}
            data-ui="density-option" data-ui-key={d}
            className={"tweak-seg-btn" + (tweaks.density === d ? " on" : "")}
            onClick={() => set("density", d)}
          >
            {d === "compact" ? t("shell.tweaks.density.compact") : d === "regular" ? t("shell.tweaks.density.regular") : t("shell.tweaks.density.comfy")}
          </ActionButton>
        ))}
      </div>

      <div className="tweak-sec">{t("shell.tweaks.language.label")}</div>
      <div className="tweak-seg">
        {LANGUAGES.map((lang) => (
          <ActionButton
            key={lang}
            unstyled
            mode="text"
            label={lang === "zh-CN" ? t("shell.tweaks.language.zhCN") : t("shell.tweaks.language.en")}
            tooltip={lang === "zh-CN" ? t("shell.tweaks.language.zhCN") : t("shell.tweaks.language.en")}
            aria-pressed={tweaks.language === lang}
            data-ui="language-option" data-ui-key={lang}
            className={"tweak-seg-btn" + (tweaks.language === lang ? " on" : "")}
            onClick={() => set("language", lang)}
          >
            {lang === "zh-CN" ? t("shell.tweaks.language.zhCN") : t("shell.tweaks.language.en")}
          </ActionButton>
        ))}
      </div>
    </div>
  );
}
