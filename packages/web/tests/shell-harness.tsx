/**
 * The Shell test fixture: what a test file that renders the real `<Shell>` sets up around it. `installShellHarness`
 * gives every test the same start and the same reset (language, storage, the `<html>` attributes the preferences
 * write, the address, fetch); `stubShellFetch` is the fetch stand-in — the settings endpoints from settings-fake.ts
 * when the file has them, then the file's own routes, then the paper list, 404 for anything else. Module stand-ins
 * for the `vi.mock` factories are in shell-stubs.tsx; the real routing of server messages is fake-ws.ts.
 */
import type { ConversationSnapshot, CopilotProvider, CopilotViewActionResult, PageContext } from "@argelanderspace/contracts";
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

/** The conversation `copilotRoutes` serves (the panel opens it when the browser remembers it, see `rememberConversation`). */
export const COPILOT_CONVERSATION_ID = "00000000-0000-4000-8000-0000000000c1";

/** What the real Copilot panel loads when a Shell test renders it: one conversation, one provider with a tool model. */
export interface CopilotRoutes {
  route: ShellRoute;
  /** Each PageContext the view published (`PUT /api/copilot/views/<viewId>`), in order. */
  puts: PageContext[];
  /** Each view action result the view reported, with the number of PageContexts published before it. */
  results: { result: CopilotViewActionResult; publishedBefore: number }[];
  /** Resolves with the first published PageContext. */
  firstPut: Promise<PageContext>;
  /** Resolves with the next result reported from now on. */
  nextResult(): Promise<CopilotViewActionResult>;
}

/** The Copilot endpoints for a Shell test that renders the real panel (combine its `route` with the file's own). */
export function copilotRoutes(): CopilotRoutes {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const conversation: ConversationSnapshot["conversation"] = { version: 1, id: COPILOT_CONVERSATION_ID, sessionId: "00000000-0000-4000-8000-0000000000c2", title: "Shell test", createdAt: "2026-10-20", updatedAt: "2026-10-20", model: { provider: "openai", model: "test", thinking: null }, run: null };
  const snapshot: ConversationSnapshot = { version: 1, conversation, messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-0000000000c3", seq: 1 } };
  const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off"], capabilitiesKnown: true, defaultThinking: "off", defaultThinkingValid: true }] };
  const puts: PageContext[] = [];
  const results: CopilotRoutes["results"] = [];
  let published!: (context: PageContext) => void;
  const firstPut = new Promise<PageContext>((resolve) => (published = resolve));
  const waiting: ((result: CopilotViewActionResult) => void)[] = [];
  const route: ShellRoute = (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/copilot/providers") return json({ version: 1, providers: [provider] });
    if (url === "/api/copilot/conversations" && method === "GET") return json({ version: 1, conversations: [conversation] });
    if (url === `/api/copilot/conversations/${COPILOT_CONVERSATION_ID}` && method === "GET") return json(snapshot);
    if (/^\/api\/copilot\/views\/[^/]+$/.test(url) && method === "PUT") {
      const context = JSON.parse(String(init?.body)) as PageContext;
      puts.push(context);
      if (puts.length === 1) published(context);
      return json({ saved: true });
    }
    if (/^\/api\/copilot\/views\/[^/]+\/action-results$/.test(url) && method === "POST") {
      const result = JSON.parse(String(init?.body)) as CopilotViewActionResult;
      results.push({ result, publishedBefore: puts.length });
      for (const resolve of waiting.splice(0)) resolve(result);
      return json({ saved: true });
    }
    return null;
  };
  return { route, puts, results, firstPut, nextResult: () => new Promise((resolve) => waiting.push(resolve)) };
}

/** The browser remembers the conversation `copilotRoutes` serves: the Copilot panel loads it even while closed. */
export function rememberConversation(): void {
  window.localStorage.setItem("argelander.copilot.conversation", COPILOT_CONVERSATION_ID);
}
