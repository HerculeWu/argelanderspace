/**
 * The running workbench's windows and the navigation relay (release-0.2 ticket 05; `docs/operation-catalog.md`
 * "Navigation"). A window is one page's `/ws` socket. The page names itself and says when the user gave it their
 * attention (`window.active`: it gained focus, became visible, or connected visible) or lost it (`window.hidden`); the
 * server only keeps that order. "Most recently active" is therefore:
 *
 * - among windows that have identified themselves and are not hidden, the one whose last `window.active` report came
 *   last (an ordering counter, not a clock, so two reports in the same millisecond still have an order);
 * - if every identified window is hidden, the one that was active last before hiding;
 * - no window has identified itself (nobody has the workbench open): there is none, and navigation says so.
 *
 * Blur is not a report: a window the user clicked away from but still sees (a second monitor) stays the latest until
 * another window is focused or shown. The server never raises, focuses or opens an operating-system window.
 *
 * {@link WorkbenchWindows.navigate} sends one `workbench.navigate` frame to the chosen window and waits for that
 * window's own `window.navigated` answer; it never claims a place was shown without it.
 */
import { randomUUID } from "node:crypto";
import {
  type NavigationTarget,
  WindowClientMessageSchema,
  type WsWorkbenchNavigate,
} from "@argelanderspace/contracts";

/** How the window answered, or why nobody could. */
export type NavigationOutcome =
  | { kind: "shown" }
  | { kind: "no_window" }
  /** The window ran it and could not show it; `detail` is the page's own reason. */
  | { kind: "refused"; detail: string }
  | { kind: "timeout" }
  /** The window went away before it answered. */
  | { kind: "closed" }
  /** The asker left (the CLI was interrupted). */
  | { kind: "aborted" };

/** What a handler may use to ask the workbench to open somewhere. Only the running workbench has one. */
export interface NavigationPort {
  navigate(
    target: NavigationTarget,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<NavigationOutcome>;
}

/** One socket's side of the registry. */
export interface WindowLink {
  /** A parsed-or-not client frame; anything that is not a window frame is ignored. */
  receive(raw: unknown): boolean;
  /** The socket closed. */
  close(): void;
}

interface WindowState {
  windowId: string | null;
  hidden: boolean;
  /** Ordering counter of the last `window.active`; 0 = never active. */
  activeAt: number;
  send: (frame: WsWorkbenchNavigate) => boolean;
  closed: boolean;
}

interface Pending {
  window: WindowState;
  navId: string;
  settle: (outcome: NavigationOutcome) => void;
}

export interface WorkbenchWindowsOptions {
  /** How long to wait for the window's answer (default 15 s). */
  reportMs?: number;
}

export class WorkbenchWindows implements NavigationPort {
  private readonly windows = new Set<WindowState>();
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private readonly reportMs: number;

  constructor(options: WorkbenchWindowsOptions = {}) {
    this.reportMs = options.reportMs ?? 15_000;
  }

  /** A socket opened. `send` returns false when the socket cannot take the frame. */
  attach(send: (frame: WsWorkbenchNavigate) => boolean): WindowLink {
    const window: WindowState = { windowId: null, hidden: false, activeAt: 0, send, closed: false };
    this.windows.add(window);
    return {
      receive: (raw) => this.receive(window, raw),
      close: () => {
        window.closed = true;
        this.windows.delete(window);
        for (const entry of [...this.pending.values()])
          if (entry.window === window) entry.settle({ kind: "closed" });
      },
    };
  }

  /** The window a navigation would go to now, or null. */
  private latest(): WindowState | null {
    const known = [...this.windows].filter((window) => window.windowId !== null && !window.closed);
    const visible = known.filter((window) => !window.hidden);
    const pool = visible.length > 0 ? visible : known;
    let best: WindowState | null = null;
    for (const window of pool) if (best === null || window.activeAt > best.activeAt) best = window;
    return best;
  }

  /** The id of the window a navigation would go to now (tests, diagnostics). */
  latestWindowId(): string | null {
    return this.latest()?.windowId ?? null;
  }

  private receive(window: WindowState, raw: unknown): boolean {
    const parsed = WindowClientMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const message = parsed.data;
    // A socket keeps the one id it first named; a frame naming another id is not this window's.
    if (window.windowId === null) window.windowId = message.windowId;
    else if (window.windowId !== message.windowId) return true;
    if (message.type === "window.active") {
      window.hidden = false;
      window.activeAt = ++this.counter;
    } else if (message.type === "window.hidden") {
      window.hidden = true;
    } else {
      const entry = this.pending.get(message.navId);
      if (entry && entry.window === window)
        entry.settle(
          message.ok
            ? { kind: "shown" }
            : { kind: "refused", detail: message.detail ?? "unavailable" }
        );
    }
    return true;
  }

  navigate(
    target: NavigationTarget,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<NavigationOutcome> {
    const window = this.latest();
    if (window === null || window.windowId === null) return Promise.resolve({ kind: "no_window" });
    const navId = randomUUID();
    const windowId = window.windowId;
    return new Promise<NavigationOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (outcome: NavigationOutcome) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(navId);
        resolve(outcome);
      };
      const onAbort = () => settle({ kind: "aborted" });
      this.pending.set(navId, { window, navId, settle });
      if (options.signal?.aborted) return settle({ kind: "aborted" });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle({ kind: "timeout" }), this.reportMs);
      timer.unref();
      if (!window.send({ type: "workbench.navigate", windowId, navId, target }))
        settle({ kind: "closed" });
    });
  }
}
