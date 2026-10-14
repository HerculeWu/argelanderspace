import {
  SETTINGS_UI_ACCENTS,
  SETTINGS_UI_DENSITIES,
  SETTINGS_UI_LANGUAGES,
  SETTINGS_UI_THEMES,
  type SettingChangeRequest,
  type SettingKey,
  type SettingsSnapshot,
} from "@argelanderspace/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { changeSetting, fetchSettings, type SettingChangeFailure } from "../api/settings";
import { onSettingsChanged } from "../api/ws";
import i18n, { DEFAULT_LANGUAGE, UI_MIRROR_KEY } from "../i18n";
import { ACCENTS, type Density, type ThemeName, type Tweaks } from "./theme";

/**
 * The page's appearance preferences and the settings behind them (desktop-app ticket 10).
 *
 * config.toml is the authority: the values come from `GET /api/settings`, a change is a `PUT` of one key, and the
 * page reads again whenever the server says the file changed. What the page shows before the first answer is, in
 * this order: the attributes the server put on `<html>` when it served the page (the configured values, so the very
 * first paint is right), else a copy this browser kept of the last values it applied (`argelander.ui` in
 * localStorage — only for a page not served by the workbench's own server, such as the Vite dev server), else the
 * defaults. That copy is never read once the server has answered, and what the server says replaces it. Preferences
 * an older version stored in the browser (`argelander.tweaks`) are not read and not migrated.
 */

export const DEFAULT_TWEAKS: Tweaks = { theme: "dark", accent: "azure", density: "regular", labels: true, language: DEFAULT_LANGUAGE };

const TWEAK_KEY = { theme: "ui.theme", accent: "ui.accent", density: "ui.density", labels: "ui.labels", language: "ui.language" } as const satisfies Record<keyof Tweaks, SettingKey>;

const oneOf = <T extends string>(all: readonly T[], value: unknown, fallback: T): T => ((all as readonly unknown[]).includes(value) ? (value as T) : fallback);

/** Values that are one of the known choices, whatever was handed in. */
function checked(raw: { theme?: unknown; accent?: unknown; density?: unknown; labels?: unknown; language?: unknown }): Tweaks {
  return {
    theme: oneOf<ThemeName>(SETTINGS_UI_THEMES, raw.theme, DEFAULT_TWEAKS.theme),
    accent: oneOf(SETTINGS_UI_ACCENTS, raw.accent, "azure"),
    density: oneOf<Density>(SETTINGS_UI_DENSITIES, raw.density, DEFAULT_TWEAKS.density),
    labels: typeof raw.labels === "boolean" ? raw.labels : DEFAULT_TWEAKS.labels,
    language: oneOf(SETTINGS_UI_LANGUAGES, raw.language, DEFAULT_LANGUAGE),
  };
}

/** The appearance a settings answer describes. */
export function tweaksOf(settings: SettingsSnapshot): Tweaks {
  const v = settings.values;
  return checked({ theme: v["ui.theme"], accent: v["ui.accent"], density: v["ui.density"], labels: v["ui.labels"], language: v["ui.language"] });
}

/** What the page starts with, before the server has answered. */
export function bootTweaks(): Tweaks {
  try {
    const root = document.documentElement;
    if (root.getAttribute("data-ui-from") === "config") {
      const labels = root.getAttribute("data-labels");
      return checked({
        theme: root.getAttribute("data-theme"),
        accent: root.getAttribute("data-accent"),
        density: root.getAttribute("data-density"),
        labels: labels === "true" ? true : labels === "false" ? false : undefined,
        language: root.lang,
      });
    }
    const raw = localStorage.getItem(UI_MIRROR_KEY);
    if (raw) return checked(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    /* no document or no storage: the defaults */
  }
  return DEFAULT_TWEAKS;
}

function applyToDocument(t: Tweaks): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", t.theme);
  root.setAttribute("data-density", t.density);
  root.setAttribute("data-accent", t.accent);
  root.setAttribute("data-labels", String(t.labels));
  const language = t.language ?? DEFAULT_LANGUAGE;
  root.lang = language;
  const a = ACCENTS[t.accent] ?? ACCENTS.azure!;
  root.style.setProperty("--accent-h", String(a.h));
  root.style.setProperty("--accent-c", String(a.c));
  if (i18n.language !== language) void i18n.changeLanguage(language);
  try {
    localStorage.setItem(UI_MIRROR_KEY, JSON.stringify(t));
  } catch {
    /* the copy is only a convenience */
  }
}

/** A floating notice at the foot of the page: a finished save, or one that was not made. */
export type SettingsNotice =
  | { id: number; kind: "saved" }
  | { id: number; kind: "info"; text: string }
  | { id: number; kind: "failed"; key: SettingKey; reason: SettingChangeFailure };

/** How long a notice that goes away by itself stays. */
export const SAVED_NOTICE_MS = 2200;
const INFO_NOTICE_MS = 3200;

export interface Preferences {
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  /** The settings as the server last gave them; null before the first answer. */
  settings: SettingsSnapshot | null;
  /** The last read got no usable answer (the values shown are the ones read before, or what the page started with). */
  unreachable: boolean;
  /** Change one key; resolves whether config.toml now has the change. */
  change: (key: SettingKey, change: SettingChangeRequest) => Promise<boolean>;
  notices: SettingsNotice[];
  dismiss: (id: number) => void;
  /** A short notice of the page's own (a copied path). */
  notify: (text: string) => void;
}

export function usePreferencesState(): Preferences {
  const [tweaks, setTweaks] = useState<Tweaks>(bootTweaks);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [notices, setNotices] = useState<SettingsNotice[]>([]);
  const latest = useRef<SettingsSnapshot | null>(null);
  /** Changes on their way: while there is one, a settings answer does not move the controls under the user's hand. */
  const pending = useRef(0);
  const readSeq = useRef(0);
  const noticeId = useRef(0);
  const alive = useRef(true);
  const timers = useRef(new Set<number>());

  useEffect(() => applyToDocument(tweaks), [tweaks]);

  const accept = useCallback((snapshot: SettingsSnapshot) => {
    latest.current = snapshot;
    setSettings(snapshot);
    setUnreachable(false);
    if (pending.current === 0) setTweaks(tweaksOf(snapshot));
  }, []);

  const read = useCallback(async () => {
    const mine = ++readSeq.current;
    const snapshot = await fetchSettings().catch(() => null);
    if (!alive.current || mine !== readSeq.current) return;
    if (snapshot) accept(snapshot);
    else setUnreachable(true);
  }, [accept]);

  useEffect(() => {
    alive.current = true;
    void read();
    let off: (() => void) | null = null;
    try {
      off = onSettingsChanged(() => void read(), () => void read());
    } catch {
      /* no live channel: the settings are read when the page opens and after each change */
    }
    const pendingTimers = timers.current;
    return () => {
      alive.current = false;
      off?.();
      for (const timer of pendingTimers) window.clearTimeout(timer);
      pendingTimers.clear();
    };
  }, [read]);

  const dismiss = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), []);
  const later = useCallback(
    (id: number, ms: number) => {
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, ms);
      timers.current.add(timer);
    },
    [dismiss]
  );
  const notify = useCallback(
    (text: string) => {
      const id = ++noticeId.current;
      setNotices((all) => [...all, { id, kind: "info", text }]);
      later(id, INFO_NOTICE_MS);
    },
    [later]
  );

  const change = useCallback(
    async (key: SettingKey, request: SettingChangeRequest): Promise<boolean> => {
      pending.current += 1;
      // Anything read before this change was sent may not have it: such an answer is dropped.
      readSeq.current += 1;
      const outcome = await changeSetting(key, request);
      pending.current -= 1;
      if (!alive.current) return outcome.ok;
      if (outcome.ok) {
        accept(outcome.settings);
        const id = ++noticeId.current;
        // One "written" notice at a time; a failure of the same key is over.
        setNotices((all) => [
          ...all.filter((n) => n.kind !== "saved" && !(n.kind === "failed" && n.key === key)),
          ...(outcome.changed ? [{ id, kind: "saved" as const }] : []),
        ]);
        if (outcome.changed) later(id, SAVED_NOTICE_MS);
        return true;
      }
      // Not made: the controls go back to what the file has, and a notice that stays says why. The file may be
      // written differently now than when it was last read (that can be the reason), so it is read again.
      if (pending.current === 0 && latest.current) setTweaks(tweaksOf(latest.current));
      void read();
      const id = ++noticeId.current;
      setNotices((all) => [
        ...all.filter((n) => n.kind !== "saved" && !(n.kind === "failed" && n.key === key)),
        { id, kind: "failed", key, reason: outcome.reason },
      ]);
      return false;
    },
    [accept, later, read]
  );

  const setTweak = useCallback(
    <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
      if (value === undefined) return;
      let before: Tweaks | null = null;
      setTweaks((prev) => {
        before = prev;
        return { ...prev, [key]: value };
      });
      void change(TWEAK_KEY[key], { set: value }).then((made) => {
        // No settings were ever read (no server answered): there is nothing to go back to but the value before.
        if (!made && alive.current && latest.current === null && before) {
          const previous: Tweaks = before;
          setTweaks((now) => ({ ...now, [key]: previous[key] }));
        }
      });
    },
    [change]
  );

  return useMemo(
    () => ({ tweaks, setTweak, settings, unreachable, change, notices, dismiss, notify }),
    [tweaks, setTweak, settings, unreachable, change, notices, dismiss, notify]
  );
}

const PreferencesContext = createContext<Preferences | null>(null);
export const PreferencesProvider = PreferencesContext.Provider;

/** The Shell's preferences, for a page inside it (the settings page). */
export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences outside the Shell");
  return value;
}
