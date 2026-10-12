/**
 * A real Copilot host (real Pi session, HTTP routes and argument-graph store) with a scripted model provider, an isolated
 * data directory and an isolated HOME: the shared setup of the argument tests that need the whole host.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArgumentGraph,
  buildArgumentPage,
  type ConversationSnapshot,
  type CopilotConfirmation,
  type PageContext,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  argumentGraphPath,
  libraryPaths,
  loadArgumentGraph,
  plansPath,
} from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

export type Out = {
  text?: string;
  call?: Record<string, unknown>;
  calls?: Record<string, unknown>[];
  tool?: string;
};
export type Step = (context: TranscriptContext) => Out | Promise<Out>;
// biome-ignore lint: probe
export type Loose = Record<string, any>;
export const WORK = "doi:10.1000/w1";
export const OTHER = "doi:10.1000/w2";
export const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

export const H = {
  root: "",
  dataDir: "",
  statusDir: "",
  host: undefined as unknown as CopilotHost,
  app: undefined as unknown as ReturnType<typeof createApp>,
  settings: undefined as unknown as ProviderSettings,
  originalEnv: process.env,
  script: [] as Step[],
  seen: [] as TranscriptContext[],
  broadcasts: [] as WsServerMessage[],
  paths: undefined as unknown as ReturnType<typeof libraryPaths>,
};
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
export const writeLibrary = () =>
  writeFileSync(
    H.paths.libraryJson,
    JSON.stringify(
      {
        version: 1,
        project: { name: "Synthetic", short: "S", field: "" },
        works: [work(1, { doc_ids: ["d1", "d2"] }), work(2), work(3, { doc_ids: ["e1"] })],
      },
      null,
      2
    )
  );
export const request = (path: string, method = "GET", body?: unknown) =>
  H.app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const lastResult = (context: TranscriptContext) => {
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  const text = part && part.type === "text" ? part.text : "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { status: "RAW", detail: text.slice(0, 300) };
  }
};
export async function registerProvider() {
  (await H.settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      H.seen.push(structuredClone(context));
      const index = H.seen.length;
      const step = H.script[index - 1];
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.calls
            ? out.calls.map((c, k) => ({
                type: "toolCall" as const,
                id: `call_${index}_${k}`,
                name: "argument",
                arguments: c as never,
              }))
            : out.call
              ? [
                  {
                    type: "toolCall",
                    id: `call_${index}`,
                    name: out.tool ?? "argument",
                    arguments: out.call as never,
                  },
                ]
              : [{ type: "text", text: out.text ?? "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: out.call || out.calls ? "toolUse" : "stop",
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
}
export function makeHost() {
  H.host = new CopilotHost(H.dataDir, H.settings, () => {});
  H.app = createApp({
    paths: H.paths,
    statusDir: H.statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(H.root, "jobs") }),
    providerSettings: H.settings,
    copilot: H.host,
    broadcast: (message) => H.broadcasts.push(message),
  });
}
export async function setup() {
  H.originalEnv = process.env;
  H.root = mkdtempSync(join(tmpdir(), "probe-"));
  process.env = {
    PATH: H.originalEnv.PATH,
    HOME: H.root,
    XDG_CONFIG_HOME: join(H.root, "config"),
    TMPDIR: H.originalEnv.TMPDIR,
  };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  H.statusDir = join(H.root, "status");
  mkdirSync(H.statusDir, { recursive: true });
  writeFileSync(plansPath(H.statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  H.dataDir = join(H.root, "data");
  H.paths = libraryPaths(H.dataDir);
  mkdirSync(H.paths.libraryDir, { recursive: true });
  writeLibrary();
  H.script = [];
  H.seen = [];
  H.broadcasts = [];
  H.settings = new ProviderSettings();
  await H.settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  await registerProvider();
  makeHost();
}
export async function teardown() {
  await H.host.close().catch(() => {});
  process.env = H.originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
export const arg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  claim: `Claim ${id}`,
  grounds: `Grounds ${id}`,
  warrant: `Warrant ${id}`,
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal" as const,
  sources: [],
  ...extra,
});
export const graph = (ids: string[], rev = 0, workId = WORK): ArgumentGraph =>
  ({
    version: 1,
    rev,
    work_id: workId,
    arguments: ids.map((id) => arg(id)),
    edges: ids
      .slice(1)
      .map((id, i) => ({ from: id, to: ids[i] as string, role: "grounds" as const })),
  }) as ArgumentGraph;
export async function userPuts(next: ArgumentGraph, expectStatus = 200) {
  const res = await H.app.request(`/api/works/${encodeURIComponent(next.work_id)}/argument-graph`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  expect(res.status).toBe(expectStatus);
  return (await res.json()) as ArgumentGraph;
}
export const disk = (workId = WORK) => loadArgumentGraph(H.dataDir, workId);
export const fileOf = (workId = WORK) => argumentGraphPath(H.dataDir, workId);
export const bytes = (workId = WORK) => {
  try {
    return readFileSync(fileOf(workId), "utf8");
  } catch {
    return "";
  }
};
export function viewing(
  viewId: string = randomUUID(),
  revision = 1,
  page?: PageContext["argument"]
): PageContext {
  const argument =
    page ??
    buildArgumentPage({
      workId: WORK,
      title: "Work number 1",
      phase: "loading",
      graph: null,
      selectedId: null,
    });
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "library",
    status: page && (page.phase === "ready" || page.phase === "empty") ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    library: null,
    argument,
  } as PageContext;
}
export async function newConversation() {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  return created.conversation.id;
}
export async function send(id: string, view: PageContext, text = "do it") {
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  return request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: view.viewId,
    contextRevision: view.revision,
  });
}
export async function start(view: PageContext, text = "Organize the argument graph of this paper") {
  const id = await newConversation();
  const sent = await send(id, view, text);
  expect(sent.status).toBe(202);
  return id;
}
export const runStatus = async (id: string) => (await H.host.snapshot(id)).conversation.run?.status;
export async function until(id: string, wanted: string[]) {
  await vi.waitFor(async () => expect(wanted).toContain(await runStatus(id)), { timeout: 8000 });
}
export async function run(steps: Step[], view: PageContext = viewing()) {
  H.script = steps;
  H.seen = [];
  const id = await start(view);
  await until(id, ["completed", "failed", "stopped"]);
  const results = H.seen.slice(1).map((context) => lastResult(context));
  return { id, results, view };
}
export async function card(id: string): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await H.host.snapshot(id)).confirmations[0];
      expect(found).toBeDefined();
    },
    { timeout: 8000 }
  );
  return found as CopilotConfirmation;
}
export const answer = (
  confirmation: CopilotConfirmation,
  view: PageContext,
  decision: "approve" | "decline",
  over: Record<string, unknown> = {}
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId: view.viewId,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
    ...over,
  });
export const call = (action: string, over: Record<string, unknown> = {}) => ({
  call: { action, workId: WORK, ...over },
});
export const changed = () => H.broadcasts.filter((m) => m.type === "argument-graph.changed");
