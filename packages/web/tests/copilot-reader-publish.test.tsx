import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { buildReaderReading, type ConversationSnapshot, type CopilotProvider, type PageContext, type TexDocIr, type WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; viewAction?: (message: { type: "copilot.view-action"; viewId: string; actionId: string; action: unknown }) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const snapshot: ConversationSnapshot = { version: 1, conversation: { version: 1, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null }, messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } };
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const ir: TexDocIr = { version: 1, docId: "d", title: "T", source: { type: "latex", origin: "x", main_tex: "m.tex" }, meta: {}, sections: [{ id: "sec-1", level: 1, heading: "H", blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text: "Body" }] }], children: [] }], refsManifest: [], bib: [], citationsByBlock: {} };
const reading = (fp: string) => buildReaderReading({ ir, file: { version: 1, rev: 0, content_fingerprint: fp, annotations: [] }, assets: [] });
const page = (revision: number, fp = "fp-1", visible: string[] = []): PageContext => ({
  ...context, revision, view: "doc", status: "complete",
  reader: { docId: "d", format: "latex", sync: { phase: "ready" }, reading: reading(fp), position: { activeSectionId: "sec-1", visibleBlockIds: visible }, selection: null, panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" }, canGoBack: false },
});
let fetchMock: ReturnType<typeof vi.fn>;
let refusedRefs = false;
const puts = () => fetchMock.mock.calls.filter(([url, options]) => url.includes("/views/") && options?.method === "PUT").map(([, options]) => JSON.parse(options.body as string));
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; refusedRefs = false;
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(snapshot, 201) : json({ version: 1, conversations: [snapshot.conversation] });
    if (url.includes("/views/") && options?.method === "PUT") {
      const body = JSON.parse(options.body as string);
      return refusedRefs && body.reader?.readingRef ? json({ code: "stale" }, 409) : json({ saved: true });
    }
    return json(snapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a page that only scrolled is published by reference; the reading goes whole again when its epoch changes or the service lost it", async () => {
  const component = render(<Copilot open context={page(1)} onClose={vi.fn()} />);
  await screen.findByText("Copilot");
  await waitFor(() => expect(puts().length).toBeGreaterThan(0));
  expect(puts()[0].reader.reading.entries.length).toBe(2);
  expect(puts()[0].reader.readingRef).toBeUndefined();
  // the user scrolls: only the position changed
  component.rerender(<Copilot open context={page(2, "fp-1", ["p-1"])} onClose={vi.fn()} />);
  await waitFor(() => expect(puts().some((body) => body.revision === 2)).toBe(true));
  const second = puts().find((body) => body.revision === 2);
  expect(second.reader.reading).toBeNull();
  expect(second.reader.readingRef).toEqual({ fingerprint: "fp-1", annotationsRev: 0 });
  expect(second.reader.position.visibleBlockIds).toEqual(["p-1"]);
  // a new epoch is a new reading: sent whole
  component.rerender(<Copilot open context={page(3, "fp-2")} onClose={vi.fn()} />);
  await waitFor(() => expect(puts().some((body) => body.revision === 3)).toBe(true));
  expect(puts().find((body) => body.revision === 3).reader.reading.epoch.fingerprint).toBe("fp-2");
  // the service no longer holds the reading (restart): it answers stale and the view sends it whole
  refusedRefs = true;
  component.rerender(<Copilot open context={page(4, "fp-2", ["p-1"])} onClose={vi.fn()} />);
  await waitFor(() => expect(puts().filter((body) => body.revision === 4).length).toBe(2));
  const fourth = puts().filter((body) => body.revision === 4);
  expect(fourth[0].reader.readingRef).toBeDefined();
  expect(fourth[1].reader.reading.epoch.fingerprint).toBe("fp-2");
  expect(fourth[1].reader.readingRef).toBeUndefined();
});

test("the context details name the reading section by its path, not its id", async () => {
  render(<Copilot open context={{ ...page(1), reader: { ...page(1).reader!, position: { activeSectionId: "sec-1", visibleBlockIds: [] } } }} onClose={vi.fn()} />);
  await screen.findByText("Copilot");
  (document.querySelector('[data-ui="copilot-context"]') as HTMLElement).click();
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-reader-summary"]')?.textContent).toContain("Reading section: H"));
  expect(document.querySelector('[data-ui="copilot-reader-summary"]')?.textContent).not.toContain("sec-1");
});
