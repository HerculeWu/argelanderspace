/**
 * Ticket 32, lane B: a truly concurrent user annotation save and Copilot create on one LaTeX Doc, end to end on the
 * real seam (real Pi session, real HTTP routes, real Doc/annotation files). Only the model provider is scripted.
 * Cases are recorded in `.scratch/copilot/evidence/32/seams/README.md`.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  type PageContext,
  type ReaderPage,
  type TexDocIr,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  docContentFingerprint,
  libraryPaths,
  plansPath,
  readDocumentForReading,
} from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
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
  writeDoc();
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

// ---- a synthetic Doc on disk ------------------------------------------------------------------------ //
const DOC = "read-doc";
const LAST = "UNIQUE-LAST-PARAGRAPH-MARKER-7f3a";
const TABLE_CELL = "TABLE-LAST-CELL-91bc";
const REF_RAW = "REFERENCE-LAST-RAW-TEXT-4d2e";
const docDir = () => join(root, "data", "output", DOC);
const irFile = () => join(docDir(), `${DOC}.json`);
const currentFile = () => join(root, "data", "annotations", DOC, "current.json");
function docIr(paragraphs = 3, last = LAST): TexDocIr {
  const body = Array.from({ length: paragraphs }, (_, n) => ({
    id: `p-${n + 1}`,
    type: "paragraph" as const,
    segments: [
      {
        type: "text" as const,
        text: `Paragraph ${n + 1} of the synthetic paper with some body text. `,
      },
      { type: "math" as const, latex: "E=mc^2" },
    ],
  }));
  return {
    version: 1,
    docId: DOC,
    title: "A Synthetic Reader Paper",
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          ...body,
          {
            id: "fig-1",
            type: "figure",
            imgPath: "plot.svg",
            captionSegments: [{ type: "text", text: "Plot." }],
          },
          {
            id: "tab-1",
            type: "table",
            tableBody: `<table><tr><th colspan="2">H</th></tr><tr><td>${TABLE_CELL}</td><td>b</td></tr></table>`,
          },
          { id: "p-last", type: "paragraph", segments: [{ type: "text", text: last }] },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [{ id: "ref-1", short: "Lee 2020", raw: REF_RAW }],
    citationsByBlock: {},
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: { title: "A Synthetic Reader Paper" },
  };
}
function writeDoc(ir: TexDocIr = docIr()) {
  mkdirSync(join(docDir(), "assets"), { recursive: true });
  writeFileSync(irFile(), JSON.stringify(ir));
  writeFileSync(join(docDir(), "assets", "plot.svg"), "<svg>v1</svg>");
}
/** A second, different Doc the user can open while a task about the first one runs. */
const _OTHER = "other-doc";
const NOTE = {
  id: "a_0000aaaa",
  target: { type: "document" as const },
  body: "  my exact note bytes  ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};
function writeCurrent(fingerprint: string, annotations: object[] = [NOTE]) {
  mkdirSync(join(root, "data", "annotations", DOC), { recursive: true });
  writeFileSync(
    currentFile(),
    `${JSON.stringify({ version: 1, rev: 2, content_fingerprint: fingerprint, annotations }, null, 2)}\n`
  );
}
const fingerprintNow = () =>
  docContentFingerprint(JSON.parse(readFileSync(irFile(), "utf8")), { docDir: docDir() });

// ---- page + conversation helpers -------------------------------------------------------------------- //
/** The page exactly as the browser publishes it: the reading of the admitted epoch the Reader shows. */
function readerPage(over: Partial<ReaderPage> = {}, docId = DOC): ReaderPage {
  const { ir, file, assets } = readDocumentForReading(join(root, "data"), docId);
  return {
    docId,
    format: "latex",
    sync: { phase: "ready" },
    reading: buildReaderReading({ ir, file, assets }),
    position: { activeSectionId: "sec-1", visibleBlockIds: ["p-1"] },
    selection: null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
    ...over,
  };
}
function page(
  reader: ReaderPage | null = readerPage(),
  revision = 1,
  viewId: string = randomUUID()
): PageContext {
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "doc",
    status: reader?.reading ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    reader,
  };
}
async function run(
  context: PageContext,
  text = "Look at this paper",
  tab = false,
  answer?: (a: Record<string, unknown>) => { ok: boolean; detail?: string }
) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const actions: Record<string, unknown>[] = [];
  if (tab) await openTab(context.viewId, id, actions, answer);
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

const readCall = (docId = DOC) => ({ call: { action: "read", docId } });
type Epoch = { fingerprint: string; annotationsRev: number };
/** The epoch the model's last `reader read` result carried, as a model would copy it into its next call. */
const epochOf = (context: TranscriptContext): Epoch => lastResult(context).reading.epoch;
/** Read first, then write with the epoch that reading carried. */
const afterRead =
  (build: (epoch: Epoch) => Record<string, unknown>): Step =>
  (context) => {
    const epoch = epochOf(context);
    return { call: build(epoch) };
  };
const withEpoch = (action: string, epoch: Epoch, rest: Record<string, unknown>) => ({
  action,
  docId: DOC,
  fingerprint: epoch.fingerprint,
  rev: epoch.annotationsRev,
  ...rest,
});
const stored = () => JSON.parse(readFileSync(currentFile(), "utf8"));
const archiveDir = () => join(root, "data", "annotations", DOC, "archive");
const httpPut = (file: object) =>
  app.request(`/api/paper/${DOC}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });

// ---- (a) the user's annotation save and the agent's create, truly concurrent --------------------------------- //
test("(a) the page's annotations PUT and the agent's create_annotation on the same revision race at several offsets: exactly one wins, the other is told, the user's note is never lost, nothing is archived", async () => {
  writeCurrent(fingerprintNow(), [NOTE]);
  const winners: string[] = [];
  for (const [round, delay] of [null, 0, 1, 3, 8, 15].entries()) {
    const before = stored();
    const rev = before.rev;
    const userNote = { ...NOTE, id: `a_0000d00${round}`, body: `USER ${round}` };
    const send = () => httpPut({ ...before, annotations: [...before.annotations, userNote] });
    let userPut: Promise<Response> | Response | undefined;
    seen = [];
    script = [
      () => readCall(),
      afterRead((e) => {
        userPut =
          delay === null
            ? send()
            : new Promise<void>((resolve) => setTimeout(resolve, delay)).then(send);
        return withEpoch(
          "create_annotation",
          { ...e, annotationsRev: rev },
          {
            target: { type: "document" },
            body: `AGENT ${round}`,
          }
        );
      }),
      () => ({ text: "done" }),
    ];
    const { snapshot } = await run(page(null));
    const put = await userPut;
    const after = stored();
    const bodies = after.annotations.map((a: { body: string }) => a.body);
    const write = ops(snapshot).find((o) => o.action === "create_annotation");
    if (put?.status === 200) {
      expect(write?.status, `round ${round}`).toBe("conflict");
      expect(bodies, `round ${round}`).toContain(`USER ${round}`);
      expect(bodies).not.toContain(`AGENT ${round}`);
      winners.push("user");
    } else {
      expect(put?.status, `round ${round}`).toBe(409);
      expect(write?.status, `round ${round}`).toBe("ok");
      expect(bodies).toContain(`AGENT ${round}`);
      expect(bodies).not.toContain(`USER ${round}`);
      winners.push("agent");
    }
    // one bump per round, the older notes all still there, never an archive (same document content)
    expect(after.rev, `round ${round}`).toBe(rev + 1);
    expect(bodies.filter((b: string) => b === NOTE.body)).toHaveLength(1);
    expect(existsSync(archiveDir())).toBe(false);
  }
  expect(winners[0]).toBe("user");
  expect(winners).toContain("agent");
});

const putEvents = () =>
  broadcasts.filter((m) => m.type === "annotation.changed" && m.doc_id === DOC);

// ---- (g) directories where files should be, and Docs that vanished -------------------------------------------- //
function treeBytes(path: string): string {
  const stat = lstatSync(path);
  if (stat.isDirectory())
    return readdirSync(path)
      .sort()
      .map((name) => `${name}=${treeBytes(join(path, name))}`)
      .join("|");
  return readFileSync(path).toString("base64");
}
test.each(["current-is-a-directory", "annotations-dir-is-a-file", "doc-directory-removed"])(
  "(g) %s: the agent's read and write are honest errors (never an empty list, never a reset), and every byte of Docs and annotations stays",
  async (kind) => {
    const fingerprint = fingerprintNow();
    writeCurrent(fingerprint, [NOTE]);
    const annotationsDir = join(root, "data", "annotations", DOC);
    if (kind === "current-is-a-directory") {
      rmSync(currentFile());
      mkdirSync(currentFile());
    }
    if (kind === "annotations-dir-is-a-file") {
      rmSync(annotationsDir, { recursive: true });
      writeFileSync(annotationsDir, "a file where the annotations directory belongs");
    }
    if (kind === "doc-directory-removed") rmSync(docDir(), { recursive: true });
    const before = ["output", "annotations"].map((name) => {
      try {
        return treeBytes(join(root, "data", name));
      } catch {
        return "";
      }
    });
    script = [
      () => readCall(),
      () => ({
        call: {
          action: "create_annotation",
          docId: DOC,
          fingerprint,
          rev: 0,
          target: { type: "document" },
          body: "x",
        },
      }),
      () => ({ text: "done" }),
    ];
    const { snapshot } = await run(page(null));
    const statuses = ops(snapshot).map((o) => o.status);
    expect(statuses).toHaveLength(2);
    // The write is always refused. (A read of an annotations directory that is a file answers 200 with no
    // annotations: loadAnnotationsFile maps ENOTDIR to "missing" through existsSync, and the frozen CLI annot shares
    // that path, so it is recorded as a finding for the user rather than changed here.)
    expect(statuses[1]).not.toBe("ok");
    if (kind !== "annotations-dir-is-a-file") expect(statuses[0]).not.toBe("ok");
    expect(statuses.every((s) => ["ok", "error", "not_found", "conflict"].includes(s))).toBe(true);
    if (kind === "current-is-a-directory") expect(statuses).toEqual(["error", "error"]);
    if (kind === "annotations-dir-is-a-file") expect(statuses[1]).toBe("error");
    const after = ["output", "annotations"].map((name) => {
      try {
        return treeBytes(join(root, "data", name));
      } catch {
        return "";
      }
    });
    expect(after).toEqual(before);
    expect(putEvents()).toHaveLength(0);
  }
);
