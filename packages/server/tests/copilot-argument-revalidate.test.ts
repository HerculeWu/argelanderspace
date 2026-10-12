/**
 * A pending replace/clear card ends by itself when the argument graph it showed is changed from outside the Copilot
 * (argument graph ticket 09, review round A): the file watcher (the CLI's `argument put`, a hand edit) and a Work merge
 * announce `argument-graph.changed`, and each also rechecks the pending cards, as plans and the Writer do. The click
 * still decides (that is tested with the card); these tests are about the card going stale without anyone clicking.
 * Real server (watcher, routes, Copilot host), scripted provider, temporary data directory.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildArgumentPage,
  type ConversationSnapshot,
  type PageContext,
} from "@argelanderspace/contracts";
import {
  argumentGraphPath,
  emptyWork,
  LibraryStore,
  libraryPaths,
  replaceArgumentGraph,
} from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProviderSettings } from "../src/providers.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const A = "doi:10.1/a";
const C = "doi:10.1/c";
const BRIDGE = "@article{b1,\n author={Ann},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}\n";
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

let dataDir: string;
let server: RunningServer;
let base: string;
let originalEnv: NodeJS.ProcessEnv;
let calls: Record<string, unknown>[];

const argument = (id: string) => ({
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
});
function putGraph(workId: string) {
  const out = replaceArgumentGraph(dataDir, {
    version: 1,
    rev: 0,
    work_id: workId,
    arguments: [argument("a1"), argument("a2")],
    edges: [],
  });
  if (!("saved" in out)) throw new Error("fixture");
  return out.saved;
}

beforeEach(async () => {
  originalEnv = process.env;
  dataDir = makeDataDir();
  process.env = {
    PATH: originalEnv.PATH,
    HOME: dirname(dataDir),
    XDG_CONFIG_HOME: join(dirname(dataDir), "config"),
  };
  const paths = libraryPaths(dataDir);
  const store = LibraryStore.load(paths);
  store.works = [
    { ...emptyWork(A), title: "Alpha galaxies", doi: "10.1/a", cite_key: "a2001", year: 2001 },
    { ...emptyWork(C), title: "Gamma", doi: "10.1/c", cite_key: "c2001", year: 2001 },
  ];
  store.save(paths);
  calls = [];
  const settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, _context: TranscriptContext) {
      const call = calls.shift();
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const message: AssistantMessage = {
          role: "assistant",
          content: call
            ? [
                {
                  type: "toolCall",
                  id: `call_${randomUUID()}`,
                  name: "argument",
                  arguments: call as never,
                },
              ]
            : [{ type: "text", text: "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: call ? "toolUse" : "stop",
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
  server = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources(), pipelines: stubPipelines() },
    watchIntervalMs: 40,
    providerSettings: settings,
  });
  base = `http://127.0.0.1:${await server.ready()}`;
});
afterEach(async () => {
  await server.close();
  process.env = originalEnv;
  rmSync(dirname(dataDir), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const copilot = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A conversation whose model asks to clear the Work's graph; resolves when the card is shown. */
async function cardOn(workId: string, rev: number) {
  calls.push({ action: "clear", workId, expectedRev: rev });
  const view: PageContext = {
    version: 1,
    viewId: randomUUID(),
    revision: 1,
    paneId: 1,
    view: "library",
    status: "unavailable",
    otherPanes: [],
    plan: null,
    library: null,
    argument: buildArgumentPage({
      workId,
      title: "Work",
      phase: "loading",
      graph: null,
      selectedId: null,
    }),
  };
  const created = (await (
    await copilot("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  await copilot(`/views/${view.viewId}`, "PUT", view);
  const sent = await copilot(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "clear it",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(sent.status).toBe(202);
  const snapshot = async () =>
    (await (await copilot(`/conversations/${id}`)).json()) as ConversationSnapshot;
  await vi.waitFor(async () => expect((await snapshot()).confirmations).toHaveLength(1), {
    timeout: 8000,
  });
  return { id, snapshot };
}

test("a hand edit or CLI write that the watcher notices ends the pending card without a click", async () => {
  const stored = putGraph(A);
  const { snapshot } = await cardOn(A, stored.rev);
  // the same rev, other content: only the content digest can tell
  const edited = JSON.parse(readFileSync(argumentGraphPath(dataDir, A), "utf8"));
  edited.arguments[0].claim = "edited from outside";
  writeFileSync(argumentGraphPath(dataDir, A), JSON.stringify(edited, null, 2));
  await vi.waitFor(async () => expect((await snapshot()).confirmations).toEqual([]), {
    timeout: 4000,
  });
  const ended = await snapshot();
  expect(ended.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).toEqual([
    "expired",
  ]);
  // nothing was cleared
  expect(JSON.parse(readFileSync(argumentGraphPath(dataDir, A), "utf8")).arguments).toHaveLength(2);
});

test("a Work merge that takes the Work away announces the graph and ends its pending card", async () => {
  const stored = putGraph(C);
  const { snapshot } = await cardOn(C, stored.rev);
  const merged = await fetch(`${base}/api/library/works`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "bib", bib: BRIDGE }),
  });
  expect(merged.status).toBe(200);
  await vi.waitFor(async () => expect((await snapshot()).confirmations).toEqual([]), {
    timeout: 4000,
  });
  expect(
    (await snapshot()).messages.flatMap((m) => m.operations ?? []).map((o) => o.status)
  ).toEqual(["expired"]);
});
