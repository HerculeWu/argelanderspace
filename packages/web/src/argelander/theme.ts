import type { AppLanguage } from "../i18n";

// Accent palette (oklch hue + chroma), ported from the design's app.jsx.
// Display names live in the i18n catalog under shell.tweaks.accents.<key>.
export const ACCENTS: Record<string, { h: number; c: number }> = {
  azure: { h: 235, c: 0.13 },
  teal: { h: 178, c: 0.11 },
  violet: { h: 292, c: 0.12 },
  amber: { h: 64, c: 0.12 },
  neutral: { h: 260, c: 0.02 },
};

export type ThemeName = "dark" | "light";
export type Density = "compact" | "regular" | "comfy";

/**
 * The appearance preferences. Their values live in config.toml (`[ui]`); `preferences.tsx` reads and changes them
 * through the settings endpoints and applies them to `<html>`.
 */
export interface Tweaks {
  theme: ThemeName;
  accent: string;
  density: Density;
  labels: boolean;
  /** Optional so pre-M3 callers/tests can omit it; the preferences state always fills it. */
  language?: AppLanguage;
}

/**
 * The swatch of an accent: the `oklch()` colour itself, left to the browser's own colour arithmetic. The Tweaks popover
 * and the settings page both show it, so the two cannot disagree.
 */
export function accentSwatch(accent: string, theme: ThemeName): string {
  const a = ACCENTS[accent] ?? ACCENTS.azure!;
  return `oklch(${theme === "dark" ? 0.72 : 0.55} ${a.c} ${a.h})`;
}
