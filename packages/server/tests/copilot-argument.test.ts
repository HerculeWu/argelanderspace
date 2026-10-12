/**
 * The argument graph view's page for the Copilot (argument graph ticket 04, ADR 0005), end to end on the real seam: real
 * Pi session and HTTP routes; only the model provider is scripted. The view lives in the browser tab, so what the model
 * sees is the page that tab published: accepted whole or partial, refused when it is not strictly the contract's shape,
 * summarised on the message, and listed (not repeated) in a later observation of the same task.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGUMENT_PAGE_FULL_MAX,
  type ArgumentGraph,
  type ArgumentPage,
  buildArgumentPage,
  type ConversationSnapshot,
  type PageContext,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import type { MetadataSources } from "@argelanderspace/core";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
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
let sources: MetadataSources;
let runner: JobRunner;
let autoPdf = false;
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
const _disk = () => JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const _bytes = () => readFileSync(paths.libraryJson, "utf8");
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const _lastText = (context: TranscriptContext): string => {
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  const part = last?.role === "toolResult" ? last.content[0] : undefined;
  return part && part.type === "text" ? part.text : "";
};
const _lastResult = (context: TranscriptContext) => {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-argument-"));
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
  sources = stubSources();
  autoPdf = false;
  runner = new JobRunner({ dir: join(root, "jobs") });
  host = new CopilotHost(join(root, "data"), settings, () => {});
  app = createApp({
    paths,
    statusDir,
    makeSources: () => sources,
    pipelines: stubPipelines(),
    fetchArxivPdf: async () =>
      readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    autoIngestArxiv: () => autoPdf,
    runner,
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
});

afterEach(async () => {
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

// ---- page + conversation helpers -------------------------------------------------------------------- //
const WORK = "doi:10.1000/w1";
const graphOf = (count: number, fieldChars = 0, rev = 3): ArgumentGraph => ({
  version: 1,
  rev,
  work_id: WORK,
  arguments: Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    title: `Argument ${i}`,
    claim: fieldChars ? `claim ${i} `.padEnd(fieldChars, "x") : `Claim ${i}`,
    grounds: `Grounds ${i}`,
    warrant: "",
    backing: "",
    qualifier: "",
    rebuttal: "",
    warrant_implicit: false,
    kind: i === 0 ? ("end" as const) : i === count - 1 ? ("native" as const) : ("normal" as const),
    sources: [],
  })),
  edges: Array.from({ length: count - 1 }, (_, i) => ({
    from: `a${i + 1}`,
    to: `a${i}`,
    role: "grounds" as const,
  })),
});
const argumentPage = (
  graph: ArgumentGraph | null,
  selectedId: string | null = null,
  phase: Parameters<typeof buildArgumentPage>[0]["phase"] = "ready"
) => buildArgumentPage({ workId: WORK, title: "Work number 1", phase, graph, selectedId });
function viewing(argument: ArgumentPage, revision = 1, viewId: string = randomUUID()): PageContext {
  const complete = argument.phase === "ready" || argument.phase === "empty";
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "library",
    status: complete ? "complete" : argument.phase === "loading" ? "unavailable" : "error",
    otherPanes: [],
    plan: null,
    library: null,
    argument,
  };
}
const put = (context: PageContext) => request(`/views/${context.viewId}`, "PUT", context);
async function create() {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  return created.conversation.id;
}
async function send(id: string, context: PageContext, text = "Summarise this argument graph") {
  expect((await put(context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  await vi.waitFor(
    async () => expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running"),
    { timeout: 8000 }
  );
  return host.snapshot(id);
}
const userEnvelope = (context: TranscriptContext) => {
  const first = context.messages.find((m) => m.role === "user");
  const text =
    first && typeof first.content !== "string"
      ? first.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : String(first?.content);
  return JSON.parse(text) as { context: PageContext };
};
const observations = (context: TranscriptContext) =>
  context.messages
    .map((m) =>
      m.role === "user"
        ? typeof m.content === "string"
          ? m.content
          : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : ""
    )
    .filter((text) => text.includes("taskContextId"))
    .map((text) => JSON.parse(text) as { page: PageContext });

describe("argument graph page", () => {
  test("a whole page is accepted, reaches the model whole, and is summarised on the message", async () => {
    const context = viewing(argumentPage(graphOf(3), "a1"));
    script = [() => ({ text: "ok" })];
    const snapshot = await send(await create(), context);
    const sent = userEnvelope(seen[0] as TranscriptContext).context;
    expect(sent.argument?.partial).toBe(false);
    expect(sent.argument?.graph?.arguments).toHaveLength(3);
    expect(sent.argument?.selectedId).toBe("a1");
    const message = snapshot.messages.find((m) => m.role === "user");
    expect(message?.context?.argument).toEqual({
      state: "ready",
      rev: 3,
      arguments: 3,
      edges: 2,
      findings: expect.any(Number),
      selectedId: "a1",
      selectedTitle: "Argument 1",
      partial: false,
    });
    expect(message?.context?.objects).toEqual([{ id: WORK, rev: 3, name: "Work number 1" }]);
    expect(message?.context?.status).toBe("complete");
    expect(
      JSON.stringify((seen[0] as TranscriptContext).messages.filter((m) => m.role === "system"))
    ).toContain("argument graph of the Library tab");
  });

  test("a graph above the budget is published partial: every argument listed, the selected one in full", async () => {
    const graph = graphOf(60, 2000);
    expect(JSON.stringify(graph).length).toBeGreaterThan(ARGUMENT_PAGE_FULL_MAX);
    const context = viewing(argumentPage(graph, "a5"));
    script = [() => ({ text: "ok" })];
    const snapshot = await send(await create(), context);
    const sent = userEnvelope(seen[0] as TranscriptContext).context.argument;
    expect(sent).toMatchObject({ partial: true, graph: null, selectedId: "a5" });
    expect(sent?.outline).toHaveLength(60);
    expect(sent?.edges).toHaveLength(59);
    expect(sent?.selected?.claim.length).toBe(2000);
    expect(sent?.note).toContain("Partial");
    expect(snapshot.messages.find((m) => m.role === "user")?.context?.argument).toMatchObject({
      partial: true,
      arguments: 60,
      selectedId: "a5",
    });
  });

  test.each(["loading", "not-found", "corrupt", "error"] as const)(
    "a %s page is accepted and is not complete",
    async (phase) => {
      const context = viewing(argumentPage(null, null, phase));
      expect((await put(context)).status).toBe(200);
      script = [() => ({ text: "ok" })];
      const snapshot = await send(await create(), context);
      expect(snapshot.messages.find((m) => m.role === "user")?.context).toMatchObject({
        status: phase === "loading" ? "unavailable" : "error",
        argument: { state: phase, arguments: 0 },
      });
    }
  );

  test("an empty graph is a complete page", async () => {
    const context = viewing(argumentPage(graphOf(0)));
    expect(context.argument?.phase).toBe("empty");
    expect(context.status).toBe("complete");
    expect((await put(context)).status).toBe(200);
  });

  test("the page is strict: an unknown field, a wrong coverage or a mismatched count is refused", async () => {
    const good = viewing(argumentPage(graphOf(2), "a0"));
    expect((await put({ ...good, argument: { ...good.argument, extra: 1 } } as never)).status).toBe(
      400
    );
    expect((await put({ ...good, status: "unavailable" })).status).toBe(400);
    expect(
      (
        await put({
          ...good,
          argument: { ...good.argument, counts: { arguments: 5, edges: 1 } },
        } as never)
      ).status
    ).toBe(400);
    expect(
      (await put({ ...good, argument: { ...good.argument, selectedId: "nope" } } as never)).status
    ).toBe(400);
    // a partial page that still carries the graph, and a whole page that carries an outline
    const partial = argumentPage(graphOf(60, 2000), "a1");
    expect((await put(viewing({ ...partial, graph: graphOf(60, 2000) }))).status).toBe(400);
    expect((await put(viewing({ ...argumentPage(graphOf(2)), outline: [] }))).status).toBe(400);
    // a Work title that is not a string
    expect(
      (
        await put({
          ...good,
          argument: { ...good.argument, work: { id: WORK, title: 5 } },
        } as never)
      ).status
    ).toBe(400);
    expect((await put(good)).status).toBe(200);
  });

  test("a later observation of the same task lists the graph the task holds instead of repeating it", async () => {
    // long claims: a listing of this graph is shorter than the graph, so the task's held copy is not repeated
    const graph = graphOf(4, 3000);
    const viewId = randomUUID();
    const first = viewing(argumentPage(graph, "a1"), 1, viewId);
    const second = viewing(argumentPage(graph, "a2"), 2, viewId);
    const third = viewing(argumentPage(graphOf(4, 3000, 4), "a2"), 3, viewId);
    script = [
      async () => {
        expect((await put(second)).status).toBe(200);
        return { tool: "library", call: { action: "read_discovery" } };
      },
      async () => {
        expect((await put(third)).status).toBe(200);
        return { tool: "library", call: { action: "read_discovery" } };
      },
      () => ({ text: "done" }),
    ];
    await send(await create(), first);
    expect(seen).toHaveLength(3);
    // request 2: selection changed, same graph revision -> partial form with the selected argument in full
    const [selection] = observations(seen[1] as TranscriptContext);
    expect(selection?.page.argument).toMatchObject({
      partial: true,
      graph: null,
      selectedId: "a2",
      selected: { id: "a2" },
    });
    expect(selection?.page.argument?.note).toContain("its text is not repeated");
    // request 3: a new revision is not held, so it comes whole
    const latest = observations(seen[2] as TranscriptContext).at(-1);
    expect(latest?.page.argument).toMatchObject({ partial: false, selectedId: "a2" });
    expect(latest?.page.argument?.graph?.rev).toBe(4);
  });

  test("a revision change in an empty graph never writes a page the history cannot read back", async () => {
    const viewId = randomUUID();
    const first = viewing(argumentPage(graphOf(0, 0, 3)), 1, viewId);
    const second = viewing(argumentPage(graphOf(0, 0, 3)), 2, viewId);
    script = [
      async () => {
        expect((await put(second)).status).toBe(200);
        return { tool: "library", call: { action: "read_discovery" } };
      },
      () => ({ text: "done" }),
    ];
    const id = await create();
    await send(id, first);
    expect(seen).toHaveLength(2);
    const [observation] = observations(seen[1] as TranscriptContext);
    expect(observation?.page.argument).toMatchObject({
      phase: "empty",
      partial: false,
      graph: { rev: 3 },
    });
    // a new host on the same data directory: the conversation lists and loads
    await host.close();
    host = new CopilotHost(join(root, "data"), settings, () => {});
    const listed = await host.list();
    expect(listed.unreadable).toEqual([]);
    expect(listed.conversations.map((c) => c.id)).toContain(id);
    const snapshot = await host.snapshot(id);
    expect(snapshot.conversation.id).toBe(id);
  });

  test.each(["loading", "not-found", "corrupt", "error"] as const)(
    "an observation of a %s page is written and read back",
    async (phase) => {
      const viewId = randomUUID();
      const first = viewing(argumentPage(graphOf(3), "a1"), 1, viewId);
      const second = viewing(argumentPage(null, null, phase), 2, viewId);
      script = [
        async () => {
          expect((await put(second)).status).toBe(200);
          return { tool: "library", call: { action: "read_discovery" } };
        },
        () => ({ text: "done" }),
      ];
      const id = await create();
      await send(id, first);
      expect(observations(seen[1] as TranscriptContext).at(-1)?.page.argument?.phase).toBe(phase);
      await host.close();
      host = new CopilotHost(join(root, "data"), settings, () => {});
      expect((await host.list()).unreadable).toEqual([]);
      expect((await host.snapshot(id)).conversation.id).toBe(id);
    }
  );

  test("a whole graph an observation sends is listed, not sent again, until its revision changes", async () => {
    // the task starts on a view without the graph, so the first observation of it is the whole graph
    const viewId = randomUUID();
    const g = (rev: number) => graphOf(4, 3000, rev);
    const first = viewing(argumentPage(null, null, "loading"), 1, viewId);
    const steps = [
      viewing(argumentPage(g(5), "a1"), 2, viewId),
      viewing(argumentPage(g(5), "a2"), 3, viewId),
      viewing(argumentPage(g(5), "a3"), 4, viewId),
      viewing(argumentPage(g(6), "a3"), 5, viewId),
      viewing(argumentPage(g(6), "a1"), 6, viewId),
    ];
    script = steps.map((context) => async () => {
      expect((await put(context)).status).toBe(200);
      return { tool: "library", call: { action: "read_discovery" } };
    });
    script.push(() => ({ text: "done" }));
    await send(await create(), first);
    const forms = steps.map((_, i) => {
      const page = observations(seen[i + 1] as TranscriptContext).at(-1)?.page.argument;
      return `${page?.partial ? "partial" : "whole"}:${page?.rev}`;
    });
    expect(forms).toEqual(["whole:5", "partial:5", "partial:5", "whole:6", "partial:6"]);
  });
});
