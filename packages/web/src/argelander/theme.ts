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

// Representative hex swatch per accent/theme, computed once via an oklch probe
// (so the tweaks panel can show real color chips without per-render DOM work).
const ACCENT_HEX: Record<ThemeName, Record<string, string>> = (() => {
  const out: Record<ThemeName, Record<string, string>> = { dark: {}, light: {} };
  if (typeof document === "undefined") return out;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  for (const [k, a] of Object.entries(ACCENTS)) {
    for (const [theme, L] of [["dark", 0.72], ["light", 0.55]] as const) {
      probe.style.color = `oklch(${L} ${a.c} ${a.h})`;
      const m = getComputedStyle(probe).color.match(/\d+/g);
      out[theme][k] = m
        ? "#" + m.slice(0, 3).map((x) => (+x).toString(16).padStart(2, "0")).join("")
        : "#888888";
    }
  }
  probe.remove();
  return out;
})();

export function accentHex(key: string, theme: ThemeName): string {
  return (ACCENT_HEX[theme] || ACCENT_HEX.dark)[key] || "#888888";
}
