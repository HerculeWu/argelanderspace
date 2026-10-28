/**
 * Copilot `library` tool (copilot ticket 13), end to end on the real seam: real Pi session, real HTTP
 * routes, real library lock/store/disk and library.changed notification, real /ws sockets as browser tabs.
 * Only the model provider is scripted; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
  type LibraryPage,
  type PageContext,
  summarizeLibraryRef,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { WsHub } from "../src/ws.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
let paths: ReturnType<typeof libraryPaths>;
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

const work = (n: number, extra: object = {}) => ({
  id: `doi:10.1000/w${n}`,
  title: `Work number ${n}`,
  authors: [`Author${n}`],
  year: 2000 + n,
  venue: "MNRAS",
  type: "article",
  doi: `10.1000/w${n}`,
  cite_key: `author${n}`,
  doc_ids: [],
  ...extra,
});
const seedFile = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  x_top: { nested: [1] },
  works: [
    work(1, { doc_ids: ["d1", "d2", "d3"], x_work: "keep-me", read: true, note: "Private note" }),
    work(2, { doc_ids: ["e1"], x_other: 7 }),
    work(3),
  ],
});
const writeLibrary = (file: object = seedFile()) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));
const disk = () => JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const bytes = () => readFileSync(paths.libraryJson, "utf8");
const W1 = "doi:10.1000/w1";
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lastResult = (context: TranscriptContext) => {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};
const uiPatch = (body: object) =>
  app.request("/api/library/refs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-library-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  script = [];
  seen = [];
  broadcasts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const step = script[seen.length - 1];
      const index = seen.length;
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.call
            ? [
                {
                  type: "toolCall",
                  id: `call_${index}`,
                  name: out.tool ?? "library",
                  arguments: out.call as never,
                },
              ]
            : [{ type: "text", text: out.text ?? "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: out.call ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })();
      return stream;
    },
  });
  host = new CopilotHost(join(root, "data"), settings, () => {});
  app = createApp({
    paths,
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
});

// ---- fake browser tab over the real /ws hub ------------------------------------------------------- //
let server: Server | undefined;
let hub: WsHub | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  hub?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  hub = undefined;
  server = undefined;
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
async function openTab(
  viewId: string,
  conversationId: string,
  actions: Record<string, unknown>[],
  answer: (action: Record<string, unknown>) => { ok: boolean; detail?: string } = () => ({
    ok: true,
  })
) {
  server = createServer();
  hub = new WsHub(server, { heartbeatMs: 0, onViewSubscribed: (id) => host.viewConnected(id) });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  host.useViewDelivery((id, message) => hub?.sendToView(id, message) ?? false);
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "copilot.view-action") return;
    actions.push(message.action);
    void request(`/views/${viewId}/action-results`, "POST", {
      actionId: message.actionId,
      ...answer(message.action),
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const subscribed = new Promise<void>((resolve) =>
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "copilot.subscribed") resolve();
    })
  );
  ws.send(JSON.stringify({ type: "copilot.subscribe", conversationId, viewId }));
  await subscribed;
}

// ---- page + conversation helpers -------------------------------------------------------------------- //
function libraryPage(extra: Partial<LibraryPage> = {}): LibraryPage {
  const works = seedFile().works.map((w) => ({
    id: w.id,
    title: w.title,
    authors: `${w.authors[0]}`,
    year: w.year,
    venue: w.venue,
    type: "article" as const,
    cite: w.cite_key,
    tags: [],
    pdf: false,
    read: false,
    star: false,
    doc_ids: w.doc_ids,
  }));
  return {
    source: "live",
    query: "",
    total: works.length,
    matched: works.length,
    refs: works.map((w) => summarizeLibraryRef(w)),
    links: [],
    selectedRefId: null,
    detail: null,
    temporaryLabels: {},
    sidebarCollapsed: false,
    graph: { labelsOn: false },
    ...extra,
  };
}
function page(
  library: LibraryPage = libraryPage(),
  revision = 1,
  viewId = randomUUID()
): PageContext {
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "library",
    status: library.source === "live" ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    library,
  };
}
async function run(context: PageContext, text = "Check my library", tab = false) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const actions: Record<string, unknown>[] = [];
  if (tab) await openTab(context.viewId, id, actions);
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 8000 }
  );
  return { id, snapshot: await host.snapshot(id), actions };
}
const ops = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);
const changed = () => broadcasts.filter((m) => m.type === "library.changed");

test("the library tool is registered beside plan and workspace and nothing else", async () => {
  script = [() => ({ call: { action: "read", limit: 1 } }), () => ({ text: "ok" })];
  await run(page());
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).toEqual([
    "plan",
    "workspace",
    "library",
    "reader",
    "writer",
    "text",
    "argument",
    "shelf",
  ]);
});

test("the UI PATCH and the tool leave the same bytes, keep unknown fields and send the same event", async () => {
  const viaUi = await uiPatch({ id: W1, doc_id: "d3" });
  expect(viaUi.status).toBe(200);
  const uiBytes = bytes();
  const uiEvents = changed().map((m) => (m as { cause: string }).cause);
  writeLibrary();
  broadcasts = [];
  script = [
    () => ({
      call: { action: "set_main_doc", refId: W1, docId: "d3", expectedMainDocId: "d1" },
    }),
    () => ({ text: "set" }),
  ];
  const { snapshot, actions } = await run(page(), "Check my library", true);
  // A write is a background edit: it never asks the browser to show anything.
  expect(actions).toEqual([]);
  expect(bytes()).toBe(uiBytes);
  expect(changed().map((m) => (m as { cause: string }).cause)).toEqual(uiEvents);
  expect(uiEvents).toEqual(["patch"]);
  const after = disk();
  expect(after.works[0]).toMatchObject({
    doc_ids: ["d3", "d1", "d2"],
    x_work: "keep-me",
    read: true,
  });
  expect(after.works[1]).toEqual(seedFile().works[1]);
  expect(after.x_top).toEqual({ nested: [1] });
  expect(after.project.x_project).toBe("keep");
  expect(ops(snapshot)).toMatchObject([
    { action: "set_main_doc", status: "ok", object: { kind: "work", id: W1 } },
  ]);
});

test("a user change to an unrelated field is kept; a changed main Doc is a conflict that writes nothing", async () => {
  script = [
    () => ({ call: { action: "read", refId: W1 } }),
    async (ctx) => {
      expect(lastResult(ctx).ref.doc_ids).toEqual(["d1", "d2", "d3"]);
      // Meanwhile the user (UI) edits another field and a new Doc is attached at the end.
      const raw = disk();
      raw.works[0].read = false;
      raw.works[0].doc_ids.push("d4");
      writeLibrary(raw);
      return {
        call: { action: "set_main_doc", refId: W1, docId: "d2", expectedMainDocId: "d1" },
      };
    },
    async (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: true, status: "ok" });
      expect(disk().works[0]).toMatchObject({ read: false, doc_ids: ["d2", "d1", "d3", "d4"] });
      // The user then makes d3 the main Doc; the model's second request still believes d2 is main.
      expect((await uiPatch({ id: W1, doc_id: "d3" })).status).toBe(200);
      return {
        call: { action: "set_main_doc", refId: W1, docId: "d4", expectedMainDocId: "d2" },
      };
    },
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({
        ok: false,
        status: "conflict",
        current: { mainDocId: "d3" },
      });
      return { text: "conflict seen" };
    },
  ];
  const { snapshot } = await run(page());
  expect(disk().works[0].doc_ids[0]).toBe("d3");
  expect(ops(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "read:ok",
    "set_main_doc:ok",
    "set_main_doc:conflict",
  ]);
});

test("a storage failure keeps the original bytes and sends no notification", async () => {
  mkdirSync(join(paths.libraryDir, "library.json.tmp"));
  const before = bytes();
  script = [
    () => ({ call: { action: "set_main_doc", refId: W1, docId: "d2", expectedMainDocId: "d1" } }),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "error" });
      return { text: "failed" };
    },
  ];
  const { snapshot } = await run(page());
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
  expect(ops(snapshot)[0]).toMatchObject({ status: "error" });
});

test("a repeated operationId answers the first result and does not write twice", async () => {
  const call = {
    action: "set_main_doc",
    refId: W1,
    docId: "d2",
    expectedMainDocId: "d1",
    operationId: "op-1",
  };
  script = [
    () => ({ call }),
    () => ({ call }),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: true, duplicate: true });
      return { text: "done" };
    },
  ];
  await run(page());
  expect(changed()).toHaveLength(1);
  expect(disk().works[0].doc_ids).toEqual(["d2", "d1", "d3"]);
});

test("read uses the page's filter and pages through the whole library; one work comes with its BibTeX and note", async () => {
  const many = seedFile();
  for (let n = 4; n <= 260; n++) many.works.push(work(n) as never);
  writeLibrary(many);
  script = [
    () => ({ call: { action: "read", query: "NUMBER 2", limit: 5 } }),
    (ctx) => {
      const first = lastResult(ctx);
      // Titles "Work number N" containing "number 2": N = 2, 20-29 and 200-260.
      expect(first).toMatchObject({ matched: 72, returned: 5, nextOffset: 5 });
      expect(first.refs.every((r: { title: string }) => /number 2/i.test(r.title))).toBe(true);
      expect(first.total).toBe(260);
      return { call: { action: "read", offset: 250, limit: 200, links: true } };
    },
    (ctx) => {
      const last = lastResult(ctx);
      expect(last.refs.at(-1).id).toBe("doi:10.1000/w260");
      expect(last.nextOffset).toBeNull();
      expect(last.links).toEqual([]);
      return { call: { action: "read", refId: W1 } };
    },
    (ctx) => {
      const one = lastResult(ctx);
      expect(one.ref.note).toBe("Private note");
      expect(one.bibtex).toContain("@article{author1,");
      return { call: { action: "read", refId: "doi:nope" } };
    },
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "not_found" });
      return { text: "done" };
    },
  ];
  const { snapshot, actions } = await run(page(), "Check my library", true);
  expect(actions).toEqual([]); // reading never opens or selects anything
  expect(ops(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "read:ok",
    "read:ok",
    "read:ok",
    "read:not_found",
  ]);
  expect(changed()).toHaveLength(0);
});

test("an unreadable library is an error, never an empty library", async () => {
  writeFileSync(paths.libraryJson, "{ not json");
  script = [
    () => ({ call: { action: "read" } }),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "error" });
      return { text: "cannot read" };
    },
  ];
  const { snapshot } = await run(page());
  expect(ops(snapshot)[0]).toMatchObject({ status: "error" });
});

test("fields and actions the Library page has no control for are refused and write nothing", async () => {
  const before = bytes();
  script = [
    () => ({ call: { action: "set_note", refId: W1, note: "x" } }),
    () => ({ call: { action: "set_main_doc", refId: W1, docId: "d2" } }),
    () => ({ call: { action: "set_main_doc", refId: W1, docId: "nope", expectedMainDocId: "d1" } }),
    () => ({ call: { action: "import_bibtex", bib: "@article{}" } }),
    () => ({ call: { action: "read", path: "/etc/passwd" } }),
    () => ({ text: "refused" }),
  ];
  const { snapshot } = await run(page());
  // Unknown actions and unknown fields never reach the store (the SDK's schema check refuses them: error);
  // a request that parses but misses the version it relies on is unsupported; an unattached Doc is rejected.
  // `path` is a field of attach_local_pdf (project intake ticket 01), so on `read` it passes the SDK's check and
  // fails the shared zod schema: unsupported, still nothing written.
  expect(ops(snapshot).map((o) => o.status)).toEqual([
    "error",
    "unsupported",
    "rejected",
    "error",
    "unsupported",
  ]);
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
});

test("the last entry of a long filtered list reaches the model; the rest of the library is only a count", async () => {
  const refs = Array.from({ length: 600 }, (_, n) =>
    summarizeLibraryRef({
      id: `doi:10.1000/long${n}`,
      title: `Long list entry ${n}`,
      authors: "Someone",
      year: 2020,
      venue: "ApJ",
      type: "article",
      cite: `long${n}`,
      tags: [],
      pdf: false,
      read: false,
      star: false,
    })
  );
  const context = page(
    libraryPage({ query: "Long list", total: 4000, matched: 600, refs, selectedRefId: null })
  );
  script = [() => ({ text: "seen" })];
  const { snapshot } = await run(context);
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toContain("doi:10.1000/long599");
  expect(sent).toContain('\\"total\\":4000');
  expect(sent).not.toContain("doi:10.1000/long600");
  expect(snapshot.messages[0]?.context).toMatchObject({ view: "library", status: "complete" });
});

test("a conversation sent from a Library page with an open work loads back after a restart (its object is the work)", async () => {
  script = [() => ({ text: "seen" })];
  const { id } = await run(page(libraryPage({ selectedRefId: W1 })));
  await host.close();
  const again = new CopilotHost(join(root, "data"), settings, () => {});
  try {
    const snapshot = await again.snapshot(id);
    expect(snapshot.messages[0]?.context?.objects).toMatchObject([{ id: W1, rev: 0 }]);
  } finally {
    await again.close();
  }
  host = new CopilotHost(join(root, "data"), settings, () => {});
});

test("demo data is reported as unavailable context and the selected work is the message's object", async () => {
  const demo = page(libraryPage({ source: "demo" }));
  script = [() => ({ text: "demo seen" })];
  const { snapshot } = await run(demo);
  expect(snapshot.messages[0]?.context).toMatchObject({ view: "library", status: "unavailable" });
  expect(JSON.stringify(seen[0]?.messages)).toContain('\\"source\\":\\"demo\\"');
  // The message keeps a summary of what the Library carried, for the context details.
  expect(snapshot.messages[0]?.context?.library).toMatchObject({
    source: "demo",
    total: 3,
    matched: 3,
  });
  const selected = page(libraryPage({ selectedRefId: W1 }));
  const second = await run(selected);
  expect(second.snapshot.messages[0]?.context?.objects).toEqual([
    { id: W1, rev: 0, name: "Work number 1" },
  ]);
});

test("view actions reach the bound tab only and a temporary label says it is not saved", async () => {
  const context = page();
  script = [
    () => ({ call: { action: "filter_library", query: "number 2" } }),
    () => ({ call: { action: "select_work", refId: "doi:10.1000/w2" } }),
    () => ({ call: { action: "set_detail_tab", tab: "files" } }),
    () => ({ call: { action: "set_sidebar", collapsed: true } }),
    () => ({ call: { action: "set_graph_labels", on: true } }),
    () => ({ call: { action: "graph_control", control: "fit" } }),
    () => ({ call: { action: "set_temp_label", refId: "doi:10.1000/w2", label: "red" } }),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: true, temporary: true });
      expect(lastResult(ctx).detail).toMatch(/not saved/);
      return { call: { action: "set_temp_label", refId: "doi:10.1000/missing", label: "blue" } };
    },
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "not_found" });
      return { text: "arranged" };
    },
  ];
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const actions: Record<string, unknown>[] = [];
  await openTab(context.viewId, id, actions, (action) =>
    action.refId === "doi:10.1000/missing" ? { ok: false, detail: "not_found" } : { ok: true }
  );
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  expect(
    (
      await request(`/conversations/${id}/messages`, "POST", {
        clientMessageId: randomUUID(),
        text: "Show me",
        viewId: context.viewId,
        contextRevision: 1,
      })
    ).status
  ).toBe(202);
  await vi.waitFor(async () => {
    expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
  });
  expect(actions.map((a) => a.action)).toEqual([
    "filter_library",
    "select_work",
    "set_detail_tab",
    "set_sidebar",
    "set_graph_labels",
    "graph_control",
    "set_temp_label",
    "set_temp_label",
  ]);
  const snapshot = await host.snapshot(id);
  expect(ops(snapshot).at(-2)).toMatchObject({ action: "set_temp_label", status: "ok" });
  expect(ops(snapshot).at(-1)).toMatchObject({ status: "not_found" });
  expect(changed()).toHaveLength(0);
});

test("view actions without a connected browser are not displayed", async () => {
  script = [
    () => ({ call: { action: "select_work", refId: W1 } }),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "not_displayed" });
      return { text: "not shown" };
    },
  ];
  const { snapshot } = await run(page());
  expect(ops(snapshot)[0]).toMatchObject({ status: "not_displayed" });
});

test("a library that could not be read reaches the model as an error with its reason, and the system rules cover expectedMainDocId", async () => {
  const failed = page(libraryPage({ source: "error", error: "HTTP 500" }));
  failed.status = "error";
  script = [() => ({ text: "cannot read" })];
  const { snapshot } = await run(failed);
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toContain('\\"source\\":\\"error\\"');
  expect(sent).toContain("HTTP 500");
  expect(snapshot.messages[0]?.context).toMatchObject({
    status: "error",
    library: { source: "error", error: "HTTP 500" },
  });
  expect(sent).toMatch(/expectedMainDocId[\s\S]*never repeat it blindly/);
  expect(sent).toMatch(/source is error means the library could not be read/);
});
