/**
 * Ticket 32, lane B: a truly concurrent user source save and Copilot `text` save_source on one text Doc, end to end on
 * the real seam (real Pi session, real HTTP routes, real source/annotation files). Only the model provider is
 * scripted. Cases are recorded in `.scratch/copilot/evidence/32/seams/README.md`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  type PageContext,
  type ReaderPage,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath, readDocumentForReading } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import type { WsHub } from "../src/ws.js";
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
let docMutations: DocMutationRegistry;
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
const W1 = "doi:10.1000/w1";
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
                  name: out.tool ?? "reader",
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
  docMutations = new DocMutationRegistry();
  app = createApp({
    docMutations,
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

const textReq = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function makeTextDoc(): Promise<string> {
  const res = await textReq("/api/library/text-docs", "POST", {
    workId: W1,
    operationId: `op-${randomUUID()}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: { doc_id: string } }).description.doc_id;
}
const SRC =
  "# Weak lensing\n\nFirst paragraph here. The UNIQUE-TEXT-LAST marker ends it.\n\n- alpha\n- beta\n";
async function generatedTextDoc(): Promise<string> {
  const docId = await makeTextDoc();
  expect(
    (await textReq(`/api/paper/${docId}/source`, "PUT", { expectedRev: 0, markdown: SRC })).status
  ).toBe(200);
  expect(
    (
      await textReq(`/api/paper/${docId}/source/generate`, "POST", {
        sourceRev: 1,
        operationId: "gen-seed-0001",
      })
    ).status
  ).toBe(200);
  return docId;
}
function textReaderPage(docId: string): ReaderPage {
  const { ir, file, assets } = readDocumentForReading(join(root, "data"), docId);
  return {
    docId,
    format: "text",
    sync: { phase: "ready" },
    reading: buildReaderReading({ ir, file, assets }),
    position: null,
    selection: null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
  };
}
function textPage(docId: string, rev = 1): PageContext {
  return {
    version: 1,
    viewId: randomUUID(),
    revision: rev,
    paneId: 1,
    view: "doc",
    status: "complete",
    otherPanes: [],
    plan: null,
    reader: textReaderPage(docId),
  };
}
async function runScript(context: PageContext, text = "Work on this text") {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}
const settledRun = (id: string) =>
  vi.waitFor(
    async () =>
      expect(["completed", "stopped", "failed"]).toContain(
        (await host.snapshot(id)).conversation.run?.status
      ),
    { timeout: 10000 }
  );
const opsOf = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);

// ---- (a) the user's source save and the agent's save_source, truly concurrent ---------------------------------- //
test("(a) the page's source PUT and the agent's save_source on the same source rev race at several offsets: exactly one wins, the other is told, no blind overwrite", async () => {
  const docId = await generatedTextDoc();
  const winners: string[] = [];
  for (const [round, delay] of [null, 0, 1, 3, 8, 15].entries()) {
    const current = (await (await textReq(`/api/paper/${docId}/source`)).json()) as {
      rev: number;
      markdown: string;
    };
    const userText = `# User ${round}\n\nTyped by the user.\n`;
    const send = () =>
      textReq(`/api/paper/${docId}/source`, "PUT", {
        expectedRev: current.rev,
        markdown: userText,
      });
    let userPut: Promise<Response> | Response | undefined;
    seen = [];
    script = [
      () => ({ tool: "text", call: { action: "read_source", docId } }),
      () => {
        userPut =
          delay === null
            ? send()
            : new Promise<void>((resolve) => setTimeout(resolve, delay)).then(send);
        return {
          tool: "text",
          call: {
            action: "save_source",
            docId,
            expectedRev: current.rev,
            markdown: `# Agent ${round}\n\nWritten by the agent.\n`,
          },
        };
      },
      () => ({ text: "done" }),
    ];
    const id = await runScript(textPage(docId));
    await settledRun(id);
    const put = await userPut;
    const after = (await (await textReq(`/api/paper/${docId}/source`)).json()) as {
      rev: number;
      markdown: string;
    };
    const write = opsOf(await host.snapshot(id)).find((o) => o.action === "save_source");
    if (put?.status === 200) {
      expect(write?.status, `round ${round}`).toBe("conflict");
      expect(after.markdown).toBe(userText);
      winners.push("user");
    } else {
      expect(put?.status, `round ${round}`).toBe(409);
      expect(write?.status, `round ${round}`).toBe("ok");
      expect(after.markdown).toBe(`# Agent ${round}\n\nWritten by the agent.\n`);
      winners.push("agent");
    }
    expect(after.rev, `round ${round}`).toBe(current.rev + 1);
  }
  expect(winners[0]).toBe("user");
  expect(winners).toContain("agent");
});
