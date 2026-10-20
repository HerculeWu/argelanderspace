/**
 * The ports the workspace state (workspace-state.ts) reaches the world through: the browser's address and history, the
 * timers, and the workspace's leave guards. The production adapters below use `window` and workspace.tsx; the tests
 * use an in-memory history with browser semantics (tests/memory-browser.ts), manual timers and a scripted leave guard.
 */
import { askWorkspaceLeave, confirmWorkspaceLeave } from "../workspace";

export interface BrowserLocation {
  pathname: string;
  hash: string;
  search: string;
  href: string;
}

export interface BrowserPort {
  location(): BrowserLocation;
  /** A new history entry; no navigation event (as `history.pushState`). */
  push(url: string): void;
  /** The current entry rewritten; no navigation event (as `history.replaceState`). */
  replace(url: string): void;
  /** The browser's Back: the traversal and its `popstate` (and `hashchange`) come later. */
  back(): void;
  /** `onNav` for every `popstate` and every `hashchange`; the returned function stops listening. */
  listen(onNav: () => void): () => void;
}

export interface TimerPort {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

/** The workspace's leave-draft protection (workspace.tsx), its signatures and meaning unchanged. */
export interface LeavePort {
  ask: typeof askWorkspaceLeave;
  confirm: typeof confirmWorkspaceLeave;
}

export function windowBrowser(): BrowserPort {
  return {
    location: () => {
      const { pathname, hash, search, href } = window.location;
      return { pathname, hash, search, href };
    },
    push: (url) => window.history.pushState(null, "", url),
    replace: (url) => window.history.replaceState(null, "", url),
    back: () => window.history.back(),
    listen: (onNav) => {
      window.addEventListener("popstate", onNav);
      window.addEventListener("hashchange", onNav);
      return () => {
        window.removeEventListener("popstate", onNav);
        window.removeEventListener("hashchange", onNav);
      };
    },
  };
}

export function windowTimers(): TimerPort {
  return {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (handle) => window.clearTimeout(handle),
  };
}

export const workspaceLeave: LeavePort = { ask: askWorkspaceLeave, confirm: confirmWorkspaceLeave };
