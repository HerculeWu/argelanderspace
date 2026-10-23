/**
 * The Copilot `shelf` tool (shelf ticket 07) end to end on the real seam: a real Pi session, the real app (Shelf
 * routes, annotations access path, library lock, disk) and a real Shelf store in a throwaway directory (never the
 * global data directory). Only the model provider is scripted. Acceptance: every write (add, replace, delete, take)
 * waits for the real user's card; what the card shows is what runs; nothing the model sends approves or changes it; a
 * change between the card and the click writes nothing and says so; the tutorial project has no shelf tool.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type {
  AnnotationsFile,
  ConversationSnapshot,
  CopilotConfirmation,
  PageContext,
  ShelfListRow,
  TexDocIr,
} from "@argelanderspace/contracts";
import {
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  plansPath,
  publishPdfDoc,
} from "@argelanderspace/core";
import { createShelfStore, type ShelfStore } from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string };
type Step = (context: TranscriptContext) => Out | Promise<Out>;

const W_A = "doi:10.1234/shelf-a";
const W_B = "doi:10.1234/shelf-b";
const LATEX_A = "paper-a";
const LATEX_B = "paper-b";
const NOTE_B = "a private note of project B";
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

let root: string;
let originalEnv: NodeJS.ProcessEnv;
let shelf: ShelfStore;
let settings: ProviderSettings;
let host: CopilotHost;
let script: Step[];
let seen: TranscriptContext[];
let projectA: string;
let pathsA: LibraryPaths;
let appA: Hono;
let pathsB: LibraryPaths;
let appB: Hono;
let pdfA = "";
let tutorialFile: string;

const ir = (docId: string, text: string): TexDocIr =>
  ({
    version: 1,
    docId,
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text }] }],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
    meta: { title: `Doc ${docId}` },
  }) as TexDocIr;
function writeDoc(paths: LibraryPaths, docId: string, text = "Hello world") {
  mkdirSync(join(paths.outputDir, docId), { recursive: true });
  writeFileSync(join(paths.outputDir, docId, `${docId}.json`), JSON.stringify(ir(docId, text)));
}
const annotation = (id: string, body: string) => ({
  id,
  target: {
    type: "text" as const,
    block: "p-1",
    container: { type: "content" as const },
    start: 0,
    end: 5,
    quote: "Hello",
  },
  body,
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
});
async function annotate(app: Hono, docId: string, items: { id: string; body: string }[]) {
  const url = `/api/paper/${docId}/annotations`;
  const current = (await (await app.request(url)).json()) as AnnotationsFile;
  const res = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: items.map((a) => annotation(a.id, a.body)),
    }),
  });
  expect(res.status).toBe(200);
}
const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const copilot = (path: string, method = "GET", body?: unknown) =>
  call(appA, method, `/api/copilot${path}`, body);
const shelfRows = async (): Promise<ShelfListRow[]> =>
  ((await (await call(appA, "GET", "/api/shelf")).json()) as { entries: ShelfListRow[] }).entries;
/** Every file under a directory with its SHA-256: a byte image of a project (or the Shelf). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
/** The project's own data (the Copilot's conversation records are not project data). */
const projectBytes = () => {
  const all = tree(pathsA.dataDir);
  return Object.fromEntries(Object.entries(all).filter(([p]) => !p.startsWith("copilot")));
};

function makeProject(name: string) {
  const paths = libraryPaths(join(root, name, "literatures"));
  mkdirSync(paths.libraryDir, { recursive: true });
  const statusDir = join(root, name, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  return { paths, statusDir };
}
function makeAppA() {
  const { statusDir } = { statusDir: join(root, "a", "status") };
  appA = createApp({
    paths: pathsA,
    statusDir,
    projectRoot: projectA,
    tutorial: { file: tutorialFile, sampleDir: null },
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "a", "jobs") }),
    docMutations: new DocMutationRegistry(),
    providerSettings: settings,
    copilot: host,
    broadcast: () => {},
    shelf,
  }) as unknown as Hono;
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-shelf-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  shelf = createShelfStore({ dir: join(root, "global", "shelf") });
  tutorialFile = join(root, "global", "tutorial.json");

  // Project A: the one the Copilot works in. A LaTeX Doc with annotations and a PDF Doc.
  const a = makeProject("a");
  pathsA = a.paths;
  projectA = join(root, "a");
  writeDoc(pathsA, LATEX_A);
  const workA = emptyWork(W_A);
  Object.assign(workA, {
    title: "Shelf Paper A",
    authors: ["Doe"],
    year: 2021,
    doi: "10.1234/shelf-a",
    note: "a note of project A",
    doc_ids: [LATEX_A],
  });
  new LibraryStore([workA]).save(pathsA);
  pdfA = publishPdfDoc(pathsA, {
    workId: W_A,
    bytes: syntheticPdf(),
    filename: "a.pdf",
    pages: [
      { width: 360, height: 480, rotation: 0 },
      { width: 400, height: 240, rotation: 90 },
      { width: 280, height: 280, rotation: 0 },
    ],
  }).doc_id;

  // Project B: where the entry to take comes from (no Copilot there).
  const b = makeProject("b");
  pathsB = b.paths;
  writeDoc(pathsB, LATEX_B);
  const workB = emptyWork(W_B);
  Object.assign(workB, {
    title: "Shelf Paper B",
    authors: ["Roe", "Moe"],
    year: 2022,
    doi: "10.1234/shelf-b",
    note: NOTE_B,
    doc_ids: [LATEX_B],
  });
  new LibraryStore([workB]).save(pathsB);
  appB = createApp({
    paths: pathsB,
    statusDir: b.statusDir,
    projectRoot: join(root, "b"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "b", "jobs") }),
    docMutations: new DocMutationRegistry(),
    broadcast: () => {},
    shelf,
  }) as unknown as Hono;

  script = [];
  seen = [];
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
                  name: out.tool ?? "shelf",
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
  host = new CopilotHost(pathsA.dataDir, settings, () => {});
  makeAppA();
  await annotate(appA, LATEX_A, [
    { id: "a_0000aaa1", body: "keep this one" },
    { id: "a_0000aaa2", body: "not chosen" },
  ]);
  await annotate(appB, LATEX_B, [
    { id: "a_0000bbb1", body: "first of B" },
    { id: "a_0000bbb2", body: "second of B" },
  ]);
});

afterEach(async () => {
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

// ---- conversation helpers ----------------------------------------------------------------------------------- //
const page = (viewId = randomUUID()): PageContext => ({
  version: 1,
  viewId,
  revision: 1,
  paneId: 1,
  view: "library",
  status: "complete",
  otherPanes: [],
  plan: null,
  library: {
    source: "live",
    query: "",
    total: 0,
    matched: 0,
    refs: [],
    links: [],
    selectedRefId: null,
    detail: null,
    temporaryLabels: {},
    sidebarCollapsed: false,
    graph: { labelsOn: false },
  },
});
async function start(context: PageContext, text = "Shelf work") {
  const created = (await (
    await copilot("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await copilot(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await copilot(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}
const settled = (id: string) =>
  vi.waitFor(
    async () =>
      expect(["completed", "stopped", "failed"]).toContain(
        (await host.snapshot(id)).conversation.run?.status
      ),
    { timeout: 15000 }
  );
async function card(id: string): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await host.snapshot(id)).confirmations[0];
      expect(found).toBeDefined();
    },
    { timeout: 10000 }
  );
  return found as CopilotConfirmation;
}
const answer = (c: CopilotConfirmation, viewId: string, decision: "approve" | "decline") =>
  copilot(`/confirmations/${c.id}`, "POST", {
    decision,
    viewId,
    action: c.action,
    objectId: c.object.id,
    baseRev: c.baseRev,
  });
/** The JSON payload of the n-th tool result the model was given (1-based by provider call). */
const resultSeenAt = (callIndex: number) => {
  const context = seen[callIndex];
  if (!context) throw new Error(`no provider call ${callIndex}`);
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result");
  const part = last.content[0];
  const raw = part && part.type === "text" ? part.text : "{}";
  try {
    return JSON.parse(raw);
  } catch {
    // Pi's own refusal (an unknown tool, arguments its schema rejects) is plain text.
    return { raw, isError: last.isError };
  }
};
const ops = async (id: string) =>
  (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
/** Put project B's Work on the Shelf through the page's own route (no Copilot): the entry to take. */
async function shelveB(extra: Record<string, unknown> = {}) {
  const res = await call(appB, "POST", "/api/shelf/entries", {
    workId: W_B,
    docs: [{ docId: LATEX_B, annotationIds: ["a_0000bbb1", "a_0000bbb2"] }],
    argumentGraph: false,
    note: true,
    ...extra,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { entry: { entryId: string; rev: number } }).entry;
}

// ---- list ----------------------------------------------------------------------------------------------------- //
describe("list and search", () => {
  test("gives the route's summary rows (bibliography, Doc kinds, counts) and never an annotation body or the note", async () => {
    const entry = await shelveB();
    script = [
      () => ({ call: { action: "list" } }),
      () => ({ call: { action: "list", query: "roe" } }),
      () => ({ call: { action: "list", query: "nothing like it" } }),
    ];
    const id = await start(page());
    await settled(id);
    const all = resultSeenAt(1);
    expect(all).toMatchObject({ ok: true, total: 1, matched: 1 });
    expect(all.entries[0]).toMatchObject({
      status: "ok",
      entryId: entry.entryId,
      rev: entry.rev,
      title: "Shelf Paper B",
      authors: ["Roe", "Moe"],
      year: 2022,
      docs: [{ docId: LATEX_B, kind: "latex", annotations: 2 }],
      annotations: 2,
      argumentGraph: false,
      note: true,
    });
    const text = JSON.stringify(seen.map((s) => s.messages));
    for (const secret of ["first of B", "second of B", NOTE_B]) expect(text).not.toContain(secret);
    expect(resultSeenAt(2)).toMatchObject({ matched: 1 });
    expect(resultSeenAt(3)).toMatchObject({ matched: 0, entries: [] });
    // reading writes nothing and asks nothing
    expect((await host.snapshot(id)).confirmations).toEqual([]);
  });
});

// ---- add ------------------------------------------------------------------------------------------------------- //
describe("add", () => {
  test("waits for the card; the card is the request and its preview, and an approval carries exactly that", async () => {
    const view = page();
    script = [
      () => ({
        call: { action: "add", workId: W_A, annotations: { [LATEX_A]: ["a_0000aaa1"] } },
      }),
    ];
    const before = projectBytes();
    const id = await start(view);
    const c = await card(id);
    // nothing is on the Shelf while the card waits
    expect(await shelfRows()).toEqual([]);
    expect(c).toMatchObject({
      action: "shelf_add",
      object: { kind: "work", id: W_A, workId: W_A },
      label: "Shelf Paper A",
      request: {
        workId: W_A,
        docs: [
          { docId: LATEX_A, annotationIds: ["a_0000aaa1"] },
          { docId: pdfA, annotationIds: [] },
        ],
        argumentGraph: false,
        note: false,
      },
      carried: {
        docs: [
          { docId: LATEX_A, kind: "latex", annotations: 1 },
          { docId: pdfA, kind: "pdf", annotations: 0 },
        ],
        argumentGraph: false,
        note: false,
      },
      notCarried: [],
      impact: null,
    });
    expect((await answer(c, view.viewId, "approve")).status).toBe(200);
    await settled(id);
    const result = resultSeenAt(1);
    expect(result).toMatchObject({ ok: true, status: "ok", replaced: [], archived: [] });
    expect(result.carried).toEqual(c.action === "shelf_add" ? c.carried : null);
    const rows = await shelfRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "ok",
      entryId: result.entry.entryId,
      docs: [
        { docId: LATEX_A, kind: "latex", annotations: 1 },
        { docId: pdfA, kind: "pdf", annotations: null },
      ],
      note: false,
    });
    // the project is untouched by an add
    expect(projectBytes()).toEqual(before);
    expect(await ops(id)).toEqual([
      expect.objectContaining({ tool: "shelf", action: "add", status: "ok" }),
    ]);
  });

  test("annotations of older content: the card says per Doc how many old annotations the add will archive, and the add archives exactly those", async () => {
    // the text changed after the annotations were made: the access path will archive that batch at the add
    writeDoc(pathsA, LATEX_A, "Rewritten text");
    const view = page();
    script = [
      () => ({ call: { action: "add", workId: W_A, annotations: { [LATEX_A]: ["a_0000aaa1"] } } }),
    ];
    const archive = join(pathsA.dataDir, "annotations", LATEX_A, "archive");
    const id = await start(view);
    const c = await card(id);
    expect(c).toMatchObject({
      action: "shelf_add",
      wouldArchive: [{ docId: LATEX_A, count: 2 }],
      notCarried: [{ docId: LATEX_A, annotationIds: ["a_0000aaa1"] }],
    });
    // nothing is archived while the card waits
    expect(existsSync(archive)).toBe(false);
    expect((await answer(c, view.viewId, "approve")).status).toBe(200);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({
      ok: true,
      archived: [{ docId: LATEX_A, count: 2 }],
    });
    expect(readdirSync(archive)).toHaveLength(1);
  });

  test("an ordinary add says nothing will be archived", async () => {
    script = [() => ({ call: { action: "add", workId: W_A } })];
    const view = page();
    const id = await start(view);
    const c = await card(id);
    expect(c).toMatchObject({ action: "shelf_add", wouldArchive: [] });
    expect((await answer(c, view.viewId, "decline")).status).toBe(200);
    await settled(id);
  });

  test("declined: nothing on the Shelf, the project byte for byte as it was", async () => {
    const view = page();
    script = [() => ({ call: { action: "add", workId: W_A } })];
    const before = projectBytes();
    const id = await start(view);
    const c = await card(id);
    expect((await answer(c, view.viewId, "decline")).status).toBe(200);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "declined" });
    expect(await shelfRows()).toEqual([]);
    expect(projectBytes()).toEqual(before);
  });

  test("a replacement shows every entry it removes, and the approval replaces exactly those", async () => {
    const first = await call(appA, "POST", "/api/shelf/entries", {
      workId: W_A,
      docs: [{ docId: LATEX_A, annotationIds: [] }],
      argumentGraph: false,
      note: false,
    });
    expect(first.status).toBe(200);
    const old = ((await first.json()) as { entry: { entryId: string; rev: number } }).entry;
    const view = page();
    script = [() => ({ call: { action: "add", workId: W_A, docIds: [pdfA], note: true } })];
    const id = await start(view);
    const c = await card(id);
    expect(c).toMatchObject({
      action: "shelf_add",
      request: { docs: [{ docId: pdfA, annotationIds: [] }], note: true },
      impact: {
        entries: [
          {
            entryId: old.entryId,
            rev: old.rev,
            title: "Shelf Paper A",
            docs: [{ docId: LATEX_A, kind: "latex" }],
          },
        ],
      },
    });
    expect((await answer(c, view.viewId, "approve")).status).toBe(200);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({
      ok: true,
      entry: { entryId: old.entryId, rev: old.rev + 1 },
      replaced: [{ entryId: old.entryId, rev: old.rev }],
    });
    const rows = await shelfRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: old.entryId,
      rev: old.rev + 1,
      docs: [{ docId: pdfA }],
      note: true,
    });
  });

  test("a change after the card and before the click: the click is refused, nothing of the card is written", async () => {
    const view = page();
    script = [() => ({ call: { action: "add", workId: W_A, docIds: [LATEX_A] } })];
    const id = await start(view);
    const c = await card(id);
    expect(c).toMatchObject({ impact: null });
    // the page adds the same paper meanwhile: the card's "new entry" is no longer what an add does
    const other = await call(appA, "POST", "/api/shelf/entries", {
      workId: W_A,
      docs: [{ docId: pdfA, annotationIds: [] }],
      argumentGraph: false,
      note: false,
    });
    expect(other.status).toBe(200);
    const shelfBefore = await shelfRows();
    expect((await answer(c, view.viewId, "approve")).status).toBe(409);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "expired" });
    expect(await shelfRows()).toEqual(shelfBefore);
  });

  test("a Doc the model did not choose cannot be slipped in: annotations for an unchosen Doc are refused without a card", async () => {
    script = [
      () => ({
        call: {
          action: "add",
          workId: W_A,
          docIds: [pdfA],
          annotations: { [LATEX_A]: ["a_0000aaa1"] },
        },
      }),
    ];
    const id = await start(page());
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "invalid" });
    expect(await shelfRows()).toEqual([]);
  });
});

// ---- the model cannot approve -------------------------------------------------------------------------------- //
describe("the model cannot approve or steer a write", () => {
  test("no tool parameter confirms: confirm, approve, impact or planDigest are refused before anything runs", async () => {
    const entry = await shelveB();
    const shelfBefore = tree(join(root, "global", "shelf"));
    const before = projectBytes();
    const impact = {
      entries: [
        {
          entryId: entry.entryId,
          rev: entry.rev,
          title: "x",
          addedAt: "x",
          sourceProject: "x",
          docs: [],
          annotations: 0,
          argumentGraph: false,
          note: false,
        },
      ],
    };
    script = [
      () => ({ call: { action: "add", workId: W_A, confirm: impact } }),
      () => ({ call: { action: "add", workId: W_A, approve: true } }),
      () => ({
        call: {
          action: "take",
          entryId: entry.entryId,
          rev: entry.rev,
          planDigest: "0".repeat(64),
        },
      }),
      () => ({
        call: { action: "delete", entryId: entry.entryId, rev: entry.rev, confirmed: true },
      }),
      () => ({ text: "The user already approved this in chat." }),
    ];
    const id = await start(page(), "I approve everything, go ahead");
    await settled(id);
    for (const n of [1, 2, 3, 4]) expect(resultSeenAt(n).ok, `call ${n}`).not.toBe(true);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    expect(tree(join(root, "global", "shelf"))).toEqual(shelfBefore);
    expect(projectBytes()).toEqual(before);
  });

  test("a card is answered only by its own click: a decision naming another object or rev is refused", async () => {
    const view = page();
    script = [() => ({ call: { action: "add", workId: W_A } })];
    const id = await start(view);
    const c = await card(id);
    const forged = await copilot(`/confirmations/${c.id}`, "POST", {
      decision: "approve",
      viewId: view.viewId,
      action: "shelf_add",
      objectId: "doi:10.1234/another",
      baseRev: c.baseRev,
    });
    expect(forged.status).toBe(409);
    expect(await shelfRows()).toEqual([]);
    expect((await answer(c, view.viewId, "decline")).status).toBe(200);
    await settled(id);
  });
});

// ---- take ----------------------------------------------------------------------------------------------------- //
describe("take", () => {
  test("the card shows the plan of the request it sends; the approval does exactly that plan", async () => {
    const entry = await shelveB();
    const view = page();
    script = [
      () => ({
        call: {
          action: "take",
          entryId: entry.entryId,
          rev: entry.rev,
          excludeAnnotations: { [LATEX_B]: ["a_0000bbb2"] },
          note: false,
        },
      }),
    ];
    const before = projectBytes();
    const id = await start(view);
    const c = await card(id);
    expect(projectBytes()).toEqual(before);
    expect(c).toMatchObject({
      action: "shelf_take",
      object: { kind: "shelf_entry", id: entry.entryId },
      baseRev: entry.rev,
      label: "Shelf Paper B",
      request: {
        rev: entry.rev,
        excludeAnnotations: { [LATEX_B]: ["a_0000bbb2"] },
        argumentGraph: true,
        note: false,
      },
      plan: {
        work: { id: W_B, created: true },
        docs: { taken: [{ docId: LATEX_B, kind: "latex", annotations: 1 }], skipped: [] },
        note: "not_chosen",
      },
    });
    expect((await answer(c, view.viewId, "approve")).status).toBe(200);
    await settled(id);
    const result = resultSeenAt(1);
    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(result.result).toEqual(c.action === "shelf_take" ? c.plan : null);
    const work = LibraryStore.load(pathsA).get(W_B);
    expect(work?.doc_ids).toEqual([LATEX_B]);
    expect(work?.note ?? "").toBe("");
    const current = JSON.parse(
      readFileSync(join(pathsA.dataDir, "annotations", LATEX_B, "current.json"), "utf8")
    ) as AnnotationsFile;
    expect(current.annotations.map((a) => a.id)).toEqual(["a_0000bbb1"]);
  });

  test("the project changes after the card: the click is refused and nothing is taken", async () => {
    const entry = await shelveB();
    const view = page();
    script = [() => ({ call: { action: "take", entryId: entry.entryId, rev: entry.rev } })];
    const id = await start(view);
    const c = await card(id);
    // a Doc of that id appears in the project: the plan would now skip it
    writeDoc(pathsA, LATEX_B, "another text");
    const before = projectBytes();
    expect((await answer(c, view.viewId, "approve")).status).toBe(409);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "expired" });
    expect(LibraryStore.load(pathsA).get(W_B)).toBeUndefined();
    expect(projectBytes()).toEqual(before);
  });

  test("an entry replaced after the card: refused at the click, nothing taken", async () => {
    const entry = await shelveB();
    const view = page();
    script = [() => ({ call: { action: "take", entryId: entry.entryId, rev: entry.rev } })];
    const id = await start(view);
    const c = await card(id);
    const impact = await call(appB, "POST", "/api/shelf/entries", {
      workId: W_B,
      docs: [{ docId: LATEX_B, annotationIds: [] }],
      argumentGraph: false,
      note: false,
    });
    const replaced = (await impact.json()) as { impact: unknown };
    expect(
      (
        await call(appB, "POST", "/api/shelf/entries", {
          workId: W_B,
          docs: [{ docId: LATEX_B, annotationIds: [] }],
          argumentGraph: false,
          note: false,
          confirm: replaced.impact,
        })
      ).status
    ).toBe(200);
    expect((await answer(c, view.viewId, "approve")).status).toBe(409);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "expired" });
    expect(LibraryStore.load(pathsA).get(W_B)).toBeUndefined();
  });
});

// ---- delete --------------------------------------------------------------------------------------------------- //
describe("delete", () => {
  test("waits for the card naming the entry at its rev; the approval deletes only the Shelf's copy", async () => {
    const entry = await shelveB();
    const bBefore = tree(pathsB.dataDir);
    const view = page();
    script = [() => ({ call: { action: "delete", entryId: entry.entryId, rev: entry.rev } })];
    const id = await start(view);
    const c = await card(id);
    expect(c).toMatchObject({
      action: "shelf_delete",
      object: { kind: "shelf_entry", id: entry.entryId },
      baseRev: entry.rev,
      status: "ok",
      label: "Shelf Paper B",
      entry: { entryId: entry.entryId, rev: entry.rev, annotations: 2, note: true },
    });
    expect(await shelfRows()).toHaveLength(1);
    expect((await answer(c, view.viewId, "approve")).status).toBe(200);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({
      ok: true,
      deleted: { entryId: entry.entryId, rev: entry.rev },
    });
    expect(await shelfRows()).toEqual([]);
    expect(tree(pathsB.dataDir)).toEqual(bBefore);
  });

  test("an entry that cannot be looked at when the user clicks is a system error, not a change: nothing deleted, said so", async () => {
    const entry = await shelveB();
    const view = page();
    script = [() => ({ call: { action: "delete", entryId: entry.entryId, rev: entry.rev } })];
    const id = await start(view);
    const c = await card(id);
    const dir = join(root, "global", "shelf", "entries", `${entry.entryId}.r${entry.rev}`);
    chmodSync(dir, 0o000);
    try {
      expect((await answer(c, view.viewId, "approve")).status).toBe(500);
      await settled(id);
      expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "error" });
      expect(resultSeenAt(1).detail).toContain("not a change");
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(await shelfRows()).toMatchObject([{ entryId: entry.entryId, rev: entry.rev }]);
  });

  test("a rev the Shelf no longer has is refused without a card", async () => {
    const entry = await shelveB();
    script = [() => ({ call: { action: "delete", entryId: entry.entryId, rev: entry.rev + 1 } })];
    const id = await start(page());
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "conflict" });
    expect(await shelfRows()).toHaveLength(1);
  });

  test("the entry replaced after the card: refused at the click, the new entry stays", async () => {
    const entry = await shelveB();
    const view = page();
    script = [() => ({ call: { action: "delete", entryId: entry.entryId, rev: entry.rev } })];
    const id = await start(view);
    const c = await card(id);
    const asked = (await (
      await call(appB, "POST", "/api/shelf/entries", {
        workId: W_B,
        docs: [],
        argumentGraph: false,
        note: false,
      })
    ).json()) as { impact: unknown };
    expect(
      (
        await call(appB, "POST", "/api/shelf/entries", {
          workId: W_B,
          docs: [],
          argumentGraph: false,
          note: false,
          confirm: asked.impact,
        })
      ).status
    ).toBe(200);
    expect((await answer(c, view.viewId, "approve")).status).toBe(409);
    await settled(id);
    expect(resultSeenAt(1)).toMatchObject({ ok: false, status: "expired" });
    expect(await shelfRows()).toMatchObject([{ entryId: entry.entryId, rev: entry.rev + 1 }]);
  });
});

// ---- tutorial ------------------------------------------------------------------------------------------------ //
describe("the tutorial project", () => {
  const bindTutorial = () => {
    writeFileSync(
      join(projectA, "argelanderspace-tutorial.json"),
      JSON.stringify({ version: 1, sample: 1 })
    );
    const at = "2026-10-23T00:00:00.000Z";
    writeFileSync(
      tutorialFile,
      JSON.stringify({
        version: 1,
        project: { path: projectA },
        startedAt: at,
        updatedAt: at,
        position: null,
        steps: {},
        appVersion: "0.0.0",
      })
    );
  };
  const declared = (context: TranscriptContext | undefined) =>
    JSON.stringify(context?.messages ?? []).includes('"name":"shelf"');

  test("has no shelf tool: a run there cannot list or write the Shelf; the same project unbound has it again", async () => {
    // the tool is declared to the model in an ordinary project
    script = [() => ({ text: "hello" })];
    let id = await start(page());
    await settled(id);
    expect(declared(seen[0])).toBe(true);

    await shelveB();
    bindTutorial();
    const shelfBefore = tree(join(root, "global", "shelf"));
    seen = [];
    script = [
      () => ({ call: { action: "list" } }),
      () => ({ call: { action: "add", workId: W_A } }),
    ];
    id = await start(page());
    await settled(id);
    expect(declared(seen[0])).toBe(false);
    for (const n of [1, 2]) expect(resultSeenAt(n).ok).not.toBe(true);
    expect(JSON.stringify(seen.map((s) => s.messages))).not.toContain("Shelf Paper B");
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    expect(tree(join(root, "global", "shelf"))).toEqual(shelfBefore);
  });
});
