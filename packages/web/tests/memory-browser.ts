/**
 * The test adapters of the workspace state's ports (src/argelander/panes/browser.ts).
 *
 * `memoryBrowser`: an in-memory history with a browser's event semantics — `push` / `replace` fire nothing (happy-dom
 * fires `hashchange` for pushState, a browser does not), `back()` / `forward()` traverse later (a microtask) and fire
 * `popstate`, then `hashchange` when the fragment differs. `pop(url)` and `editHash(url)` are the person's own moves:
 * a Back/Forward arriving at `url` (an entry is added and `popstate` fires at once, as the Shell tests used to do), and
 * a hand-edited address (a new entry and `hashchange` only).
 *
 * `manualTimers`: timers that run only when the test advances the clock.
 */
import type { BrowserLocation, BrowserPort, TimerPort } from "../src/argelander/panes/browser";

const ORIGIN = "http://localhost:3000";

export interface MemoryBrowser {
  port: BrowserPort;
  /** The entries, oldest first, as path + search + hash. */
  readonly entries: string[];
  readonly index: number;
  /** pathname + search + hash of the current entry. */
  url(): string;
  /** A Back/Forward that arrives at `url`: an entry, then `popstate` at once. */
  pop(url: string): void;
  /** A hand-edited address: a new entry, then `hashchange` only. */
  editHash(url: string): void;
  /** Waits for traversals asked for with `back()` / `forward()` (and the events they fire). */
  settle(): Promise<void>;
  forward(): void;
  /** How many listeners are installed (a stopped workspace leaves none). */
  listeners(): number;
}

export function memoryBrowser(start = "/"): MemoryBrowser {
  const entries: string[] = [norm(start)];
  let index = 0;
  const navs = new Set<() => void>();
  let traversals: Promise<void> = Promise.resolve();
  const loc = (): BrowserLocation => {
    const u = new URL(entries[index]!, ORIGIN);
    return { pathname: u.pathname, hash: u.hash, search: u.search, href: u.href };
  };
  const fire = () => {
    for (const nav of [...navs]) nav();
  };
  const traverse = (delta: number) => {
    traversals = traversals.then(async () => {
      await Promise.resolve();
      const to = index + delta;
      if (to < 0 || to >= entries.length) return;
      const before = loc().hash;
      index = to;
      fire(); // popstate
      if (loc().hash !== before) fire(); // hashchange
    });
  };
  const push = (url: string) => {
    entries.splice(index + 1);
    entries.push(norm(url));
    index = entries.length - 1;
  };
  const port: BrowserPort = {
    location: loc,
    push,
    replace: (url) => {
      entries[index] = norm(url);
    },
    back: () => traverse(-1),
    listen: (onNav) => {
      // a new function per listen: popstate and hashchange are both this one handler
      const handler = () => onNav();
      navs.add(handler);
      return () => navs.delete(handler);
    },
  };
  return {
    port,
    get entries() {
      return [...entries];
    },
    get index() {
      return index;
    },
    url: () => entries[index]!,
    pop: (url) => {
      push(url);
      fire();
    },
    editHash: (url) => {
      push(url);
      fire();
    },
    settle: async () => {
      let seen: Promise<void>;
      do {
        seen = traversals;
        await seen;
        await Promise.resolve();
      } while (seen !== traversals);
    },
    forward: () => traverse(1),
    listeners: () => navs.size,
  };
}

function norm(url: string): string {
  const u = new URL(url, ORIGIN);
  return u.pathname + u.search + u.hash;
}

export interface ManualTimers {
  port: TimerPort;
  /** Runs every timer due within `ms` from now, in time order. */
  advance(ms: number): void;
  /** How many timers are set. */
  pending(): number;
}

export function manualTimers(): ManualTimers {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    port: {
      set: (fn, ms) => {
        const handle = next++;
        timers.set(handle, { at: now + ms, fn });
        return handle;
      },
      clear: (handle) => {
        timers.delete(handle);
      },
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}
