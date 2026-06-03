import { useSyncExternalStore } from "react";

export type ThemeName = "dark" | "light";

function readTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

// A single shared observer for the whole app. Every figure subscribes through
// this one store, so toggling the theme notifies all subscribers from ONE
// MutationObserver and React coalesces them into a single batched render pass —
// rather than one observer + one state update per figure (which spikes a frame
// on figure-heavy papers). Mirrors the external-store pattern in store.tsx.
let current: ThemeName = readTheme();
const subscribers = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(cb: () => void): () => void {
  if (!observer && typeof document !== "undefined") {
    observer = new MutationObserver(() => {
      const next = readTheme();
      if (next !== current) {
        current = next;
        subscribers.forEach((f) => f());
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  // Catch any change between module init and this subscribe (useSyncExternalStore
  // re-reads the snapshot right after subscribing, so this stays consistent).
  current = readTheme();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

const getSnapshot = (): ThemeName => current;
const getServerSnapshot = (): ThemeName => "dark";

/** Track the shell's active theme (set as `data-theme` on <html> by useTweaks).
 *  Kept reader-local — the document components depend only on the attribute the
 *  shell already writes, not on the HubbleSpace Workspace context. */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
