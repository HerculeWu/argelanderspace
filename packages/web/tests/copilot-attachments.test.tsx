/**
 * Copilot composer attachments (ticket 15), prototype A: the plus button, the removable chips, upload progress and
 * failure, and the ids that travel with the message. The real Copilot component against a scripted HTTP API.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = { version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null };
const snap = (extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation, messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let uploadStatus = 201;
let uploadCount = 0;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string, method?: string) => fetchMock.mock.calls.filter(([url, options]) => String(url).includes(part) && (!method || (options as RequestInit | undefined)?.method === method));
const memory = new Map<string, string>();
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; memory.clear(); uploadStatus = 201; uploadCount = 0;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/attachments") && options?.method === "POST") {
      if (uploadStatus !== 201) return json({ code: uploadStatus === 413 ? "capacity" : "unavailable" }, uploadStatus);
      uploadCount += 1;
      void 0;
      return json({ id: `00000000-0000-4000-8000-00000000010${uploadCount}`, filename: "paper.pdf", size: 4, contentType: "application/pdf", sha256: "a".repeat(64), createdAt: "2026-10-04" }, 201);
    }
    if (url.includes("/attachments/") && options?.method === "DELETE") return json({ removed: true });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(snap(), 201) : json({ version: 1, conversations: [conversation], unreadable: [] });
    if (url.endsWith("/messages")) return json({ messageId: "m", runId: "r" }, 202);
    if (url.includes("/views/")) return json({ saved: true });
    return json(snap());
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const pdf = (name = "paper.pdf") => new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });
const choose = async (...files: File[]) => { const input = ui("copilot-attach-input") as HTMLInputElement; await act(async () => { fireEvent.change(input, { target: { files } }); }); };

test("the plus button opens the file picker and is named for it", async () => {
  await open();
  const button = ui("copilot-attach") as HTMLElement;
  expect(button.getAttribute("aria-label")).toBe("Attach a file");
  const input = ui("copilot-attach-input") as HTMLInputElement;
  const click = vi.spyOn(input, "click");
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
});

test("a chosen file is uploaded as raw bytes with its name, shown as a chip with paperclip, name and remove, and its id travels with the message only", async () => {
  await open();
  await choose(pdf());
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("ready"));
  const [url, options] = calls("/attachments", "POST")[0] as [string, RequestInit];
  expect(url).toMatch(/\/conversations\/[0-9a-f-]{36}\/attachments$/);
  expect((options.headers as Record<string, string>)["X-Filename"]).toBe("paper.pdf");
  expect(options.body).toBeInstanceOf(File);
  const chip = ui("copilot-attachment") as HTMLElement;
  expect(chip.textContent).toContain("paper.pdf");
  expect(chip.querySelector("svg")).not.toBeNull();
  fireEvent.change(ui("copilot-input") as HTMLTextAreaElement, { target: { value: "use my file" } });
  fireEvent.click(ui("copilot-send") as HTMLElement);
  await waitFor(() => expect(calls("/messages", "POST")).toHaveLength(1));
  const body = JSON.parse(String((calls("/messages", "POST")[0] as [string, RequestInit])[1].body));
  expect(body.attachmentIds).toEqual(["00000000-0000-4000-8000-000000000101"]);
  expect(JSON.stringify(body)).not.toContain("%PDF");
  await waitFor(() => expect(ui("copilot-attachment")).toBeNull()); // the chip leaves the composer once sent
});

test("a chip can be removed before sending: the stored file is deleted and the message carries no attachment", async () => {
  await open();
  await choose(pdf());
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("ready"));
  fireEvent.click(ui("copilot-attachment-remove") as HTMLElement);
  await waitFor(() => expect(calls("/attachments/", "DELETE")).toHaveLength(1));
  expect(ui("copilot-attachment")).toBeNull();
  fireEvent.change(ui("copilot-input") as HTMLTextAreaElement, { target: { value: "no file now" } });
  fireEvent.click(ui("copilot-send") as HTMLElement);
  await waitFor(() => expect(calls("/messages", "POST")).toHaveLength(1));
  expect(JSON.parse(String((calls("/messages", "POST")[0] as [string, RequestInit])[1].body)).attachmentIds).toBeUndefined();
});

test("an upload in progress or failed blocks Send and says so; Retry uploads again", async () => {
  uploadStatus = 503;
  await open();
  await choose(pdf());
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("failed"));
  fireEvent.change(ui("copilot-input") as HTMLTextAreaElement, { target: { value: "try" } });
  expect((ui("copilot-send") as HTMLButtonElement).disabled).toBe(true);
  expect(ui("copilot-attachment-retry")?.textContent).toBe("Retry");
  uploadStatus = 201;
  fireEvent.click(ui("copilot-attachment-retry") as HTMLElement);
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("ready"));
  expect((ui("copilot-send") as HTMLButtonElement).disabled).toBe(false);
});

test("a sent message shows its files in the conversation, and the label is translated", async () => {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(snap(), 201) : json({ version: 1, conversations: [conversation], unreadable: [] });
    if (url.includes("/views/")) return json({ saved: true });
    return json(snap({ messages: [{ id: "u1", role: "user", text: "please upload", attachments: [{ id: "00000000-0000-4000-8000-000000000101", filename: "paper.pdf", size: 4, contentType: "application/pdf", sha256: "a".repeat(64), createdAt: "2026-10-04" }] }] }));
  });
  await open();
  await waitFor(() => expect(ui("copilot-message-attachment")?.textContent).toContain("paper.pdf"));
  await i18n.changeLanguage("zh-CN");
  await waitFor(() => expect(ui("copilot-attach")?.getAttribute("aria-label")).toBe("添加附件"));
});

/** A fresh panel with no conversation open; each created conversation gets its own id. */
function noConversationYet() {
  let created = 0;
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (String(url).endsWith("/conversations")) {
      if (options?.method !== "POST") return json({ version: 1, conversations: [], unreadable: [] });
      created += 1;
      const id = `00000000-0000-4000-8000-0000000002${String(created).padStart(2, "0")}`;
      return json(snap({ conversation: { ...conversation, id } }), 201);
    }
    return base(url, options);
  });
}

test("W2: files chosen together with no conversation open create exactly one conversation and all upload to it", async () => {
  noConversationYet();
  await open();
  await choose(pdf("a.pdf"), pdf("b.pdf"));
  await waitFor(() => expect(document.querySelectorAll('[data-ui="copilot-attachment"][data-status="ready"]')).toHaveLength(2));
  expect(calls("/conversations", "POST").filter(([url]) => String(url).endsWith("/conversations"))).toHaveLength(1);
  const targets = new Set(calls("/attachments", "POST").map(([url]) => String(url).split("/")[3]));
  expect(targets.size).toBe(1);
});

test("W2: a chip still uploading when the user moves to another conversation is dropped, and its stored file is removed once it lands", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (String(url).endsWith("/attachments") && options?.method === "POST") await gate;
    return base(url, options);
  });
  noConversationYet();
  await open();
  await choose(pdf());
  expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("uploading");
  fireEvent.click(ui("copilot-new-conversation") as HTMLElement);
  await waitFor(() => expect(ui("copilot-attachment")).toBeNull());
  release();
  await waitFor(() => expect(calls("/attachments/", "DELETE")).toHaveLength(1));
});

test("W4: an upload in progress or failed is announced as a status; Retry names the file; a refused file offers no retry and says why", async () => {
  uploadStatus = 503;
  await open();
  await choose(pdf("flaky.pdf"));
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("failed"));
  expect(ui("copilot-attachment")?.getAttribute("role")).toBe("status");
  expect(ui("copilot-attachment-retry")?.getAttribute("aria-label")).toBe("Retry uploading flaky.pdf");
  expect(ui("copilot-attachment")?.textContent).toContain("Upload failed");
  fireEvent.click(ui("copilot-attachment-remove") as HTMLElement);
  await waitFor(() => expect(ui("copilot-attachment")).toBeNull());
  uploadStatus = 413;
  await choose(pdf("huge.pdf"));
  await waitFor(() => expect(ui("copilot-attachment")?.getAttribute("data-status")).toBe("failed"));
  expect(ui("copilot-attachment-retry")).toBeNull();
  expect(ui("copilot-attachment")?.textContent).toContain("50 MiB");
});

test("W4: removing a chip moves focus to the next chip's remove button, then to the attach button", async () => {
  await open();
  await choose(pdf("a.pdf"), pdf("b.pdf"));
  await waitFor(() => expect(document.querySelectorAll('[data-ui="copilot-attachment"][data-status="ready"]')).toHaveLength(2));
  const [first] = [...document.querySelectorAll<HTMLElement>('[data-ui="copilot-attachment-remove"]')];
  fireEvent.click(first as HTMLElement);
  await waitFor(() => expect(document.activeElement).toBe(ui("copilot-attachment-remove")));
  fireEvent.click(ui("copilot-attachment-remove") as HTMLElement);
  await waitFor(() => expect(document.activeElement).toBe(ui("copilot-attach")));
});
