/**
 * The Shell test fixture: what a test file that renders the real `<Shell>` sets up around it. `installShellHarness`
 * gives every test the same start and the same reset (language, storage, the `<html>` attributes the preferences
 * write, the address, fetch); `stubShellFetch` is the fetch stand-in — the settings endpoints from settings-fake.ts
 * when the file has them, then the file's own routes, then the paper list, 404 for anything else. Module stand-ins
 * for the `vi.mock` factories are in shell-stubs.tsx; the real routing of server messages is fake-ws.ts.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import type { FakeSettings } from "./settings-fake";

/** One of a test file's endpoints: its answer, or null / undefined (also later) to pass the request on. */
export type ShellRoute = (url: string, init: RequestInit | undefined) => Response | null | undefined | Promise<Response | null | undefined>;

export interface ShellFetch {
  /**
   * The settings endpoints' stand-in, read at each request (a test may replace it). Without one, `/api/settings`
   * answers 404 like any unknown URL: the page then has no settings (unreachable; appearance and language from
   * the boot copy).
   */
  settings?: () => FakeSettings;
  /** The file's own endpoints, asked after the settings and before the paper list. */
  routes?: ShellRoute;
  /** What `/api/papers` lists (none unless given). */
  papers?: () => readonly string[];
}

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response;

/** Replaces `fetch` (a `vi.fn`, so a test can read its calls) until the globals are unstubbed. */
export function stubShellFetch(o: ShellFetch = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const settingsAnswer = o.settings?.().handle(input, init);
      if (settingsAnswer) return settingsAnswer;
      const url = String(input);
      const own = o.routes?.(url, init);
      const routed = own instanceof Promise ? await own : own;
      if (routed) return routed;
      if (url === "/api/papers") return answer({ papers: [...(o.papers?.() ?? [])] });
      return notFound();
    })
  );
}

/** The attributes of `<html>` the page's appearance is written to (and the server's boot copy is read from). */
export const BOOT_ATTRIBUTES = ["data-theme", "data-density", "data-accent", "data-labels", "data-ui-from", "lang", "style"];

function resetPage(): void {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const name of BOOT_ATTRIBUTES) document.documentElement.removeAttribute(name);
  window.history.replaceState(null, "", "/");
}

export interface ShellHarnessOptions extends ShellFetch {
  /**
   * The language set before each test. A page takes its language from the settings (`ui.language` of the settings
   * stand-in) once it has read them; this is what it starts with. Null leaves it as it is. Default "en".
   */
  language?: "en" | null;
}

/**
 * Registers the hooks every Shell test file shares; call it before the file's own `beforeEach`. Before each test: the
 * language, empty local and session storage, no appearance on `<html>`, the address `/`, and fetch by
 * `stubShellFetch(options)`. After each: unmount, real timers, globals unstubbed, spies restored, the same page
 * reset, and the default language back.
 */
export function installShellHarness(options: ShellHarnessOptions = {}): void {
  beforeEach(async () => {
    if (options.language !== null) await i18n.changeLanguage(options.language ?? "en");
    resetPage();
    stubShellFetch(options);
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetPage();
    await i18n.changeLanguage("zh-CN");
  });
}

/** Renders the Shell, at `route` when given (the address it boots from). */
export function renderShell(route?: string) {
  if (route !== undefined) window.history.replaceState(null, "", route);
  return render(<Shell />);
}
