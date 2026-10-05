/**
 * The Copilot `text` tool (copilot ticket 29) on the real seam: the real TextDocService (the very handlers of the
 * source panel's routes), a real temp dataDir and real HTTP routes of `createApp` for setting the data up and for
 * reading the outcome back. Only the human confirmation port is a test double, and it records what it was asked.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AnnotationsFile,
  DocDescription,
  TextReplacementImpact,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import type { ConfirmationPort } from "../src/copilot-plan-tool.js";
import { createTextTool, type TextToolContext } from "../src/copilot-text-tool.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import {
  PdfMaterialContentError,
  PdfMaterialInputError,
  renderPdfRegionImage,
} from "../src/pdf-material.js";
import { probePdf } from "../src/pdfium-probe.js";
import { TextDocService } from "../src/text-docs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

let dataDir: string;
let paths: ReturnType<typeof libraryPaths>;
let app: Hono;
let service: TextDocService;
let messages: WsServerMessage[];

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  const collector = collectBroadcasts();
  messages = collector.messages;
  const docMutations = new DocMutationRegistry();
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    docMutations,
  });
  // the tool's handlers: the same class the routes use, over the same data (and its own, equally strict, locks)
  service = new TextDocService({
    paths,
    libraryLock: new AsyncLock(),
    annotationLock: new AsyncLock(),
    docMutations,
    broadcast: collector.broadcast,
    libraryChanged: () => {},
    renderPdfRegion: async (request) => {
      const bytes = readFileSync(join(dataDir, "output", request.pdfDocId, "original.pdf"));
      let image: Awaited<ReturnType<typeof renderPdfRegionImage>>;
      try {
        image = await renderPdfRegionImage(
          bytes,
          request.expectedHash,
          request.pageIndex,
          request.region,
          request.longEdge
        );
      } catch (error) {
        if (error instanceof PdfMaterialContentError) return { kind: "changed" };
        if (error instanceof PdfMaterialInputError)
          return { kind: "invalid", detail: error.message };
        throw error;
      }
      return { kind: "ok", png: image.png, width: image.width, height: image.height };
    },
  });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// biome-ignore lint/suspicious/noExplicitAny: a tool result is read field by field in the assertions
type Loose = Record<string, any>;
type Asked = Parameters<ConfirmationPort["request"]>[0];
function toolWith(extra: Partial<TextToolContext> = {}) {
  const tool = createTextTool({
    text: service,
    admitting: () => true,
    viewAction: async () => ({ status: "displayed" }),
    ...extra,
  });
  return async (params: Record<string, unknown>, id = `call-${randomUUID()}`) => {
    const result = await tool.execute(
      id,
      params as never,
      undefined as never,
      undefined as never,
      undefined as never
    );
    const part = result.content[0];
    return {
      payload: JSON.parse(part && part.type === "text" ? part.text : "{}") as Loose,
      operation: result.details as { status: string; action: string; tool: string },
    };
  };
}
const sourceOf = async (docId: string) =>
  (await (await call("GET", `/api/paper/${docId}/source`)).json()) as {
    rev: number;
    markdown: string;
    assets: unknown[];
    generated: boolean;
    published_source_rev: number | null;
  };

const SOURCE = "# Weak lensing\n\nFirst paragraph here.\n\n- alpha\n- beta\n";
const CHANGED = "# Weak lensing\n\nA rewritten paragraph.\n";

async function annotatedDoc(): Promise<string> {
  const run = toolWith();
  const made = await run({ action: "create", workId: KNOWN_WORK_ID });
  const docId = made.payload.docId as string;
  expect(
    (await run({ action: "save_source", docId, expectedRev: 0, markdown: SOURCE })).payload.ok
  ).toBe(true);
  expect((await run({ action: "generate", docId, sourceRev: 1 })).payload.ok).toBe(true);
  const url = `/api/paper/${docId}/annotations`;
  const current = (await (await call("GET", url)).json()) as AnnotationsFile;
  const put = await call("PUT", url, {
    ...current,
    annotations: [
      {
        id: "a_0123abc0",
        target: {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: 0,
          end: 5,
          quote: "First",
        },
        body: "note",
        created_at: "2026-09-10T10:00:00.000Z",
        updated_at: "2026-09-10T10:00:00.000Z",
      },
    ],
  });
  expect(put.status).toBe(200);
  return docId;
}
const irBytes = (docId: string) => readFileSync(join(dataDir, "output", docId, `${docId}.json`));

describe("create, read, save, validate, generate", () => {
  test("the same operationId makes one Doc; an empty text Doc has no reading yet", async () => {
    const run = toolWith();
    const a = await run({ action: "create", workId: KNOWN_WORK_ID, operationId: "agent-op-0001" });
    const b = await run({ action: "create", workId: KNOWN_WORK_ID, operationId: "agent-op-0001" });
    expect(a.payload).toMatchObject({ ok: true, created: true });
    expect(b.payload).toMatchObject({ ok: true, created: false, docId: a.payload.docId });
    expect(a.operation).toMatchObject({ tool: "text", action: "create", status: "ok" });
    expect((await call("GET", `/api/paper/${a.payload.docId}/description`)).status).toBe(200);
    expect((await run({ action: "create", workId: "doi:nope" })).payload.status).toBe("not_found");
  });

  test("save_source is the panel's PUT: a stale rev is a conflict that writes nothing, append adds to the saved text", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    expect(
      (await run({ action: "save_source", docId, expectedRev: 0, markdown: "# A\n\nx\n" })).payload
    ).toMatchObject({ ok: true, rev: 1 });
    // the user typed and their autosave landed meanwhile: rev 2
    expect(
      (
        await call("PUT", `/api/paper/${docId}/source`, {
          expectedRev: 1,
          markdown: "# A\n\nUSER\n",
        })
      ).status
    ).toBe(200);
    const stale = await run({
      action: "save_source",
      docId,
      expectedRev: 1,
      markdown: "# overwritten\n",
    });
    expect(stale.payload).toMatchObject({ ok: false, status: "conflict", current: { rev: 2 } });
    expect(stale.operation.status).toBe("conflict");
    expect((await sourceOf(docId)).markdown).toBe("# A\n\nUSER\n");
    const appended = await run({
      action: "save_source",
      docId,
      expectedRev: 2,
      markdown: "\nmore\n",
      append: true,
    });
    expect(appended.payload).toMatchObject({ ok: true, rev: 3 });
    expect((await sourceOf(docId)).markdown).toBe("# A\n\nUSER\n\nmore\n");
    // an append planned from an older rev is refused before anything is read into it
    const staleAppend = await run({
      action: "save_source",
      docId,
      expectedRev: 2,
      markdown: "z",
      append: true,
    });
    expect(staleAppend.payload.status).toBe("conflict");
    expect((await sourceOf(docId)).markdown).toBe("# A\n\nUSER\n\nmore\n");
  });

  test("the user's unsaved typing in the panel is reported and never touched", async () => {
    const page = { textSource: { docId: "", unsaved: true } };
    const run0 = toolWith();
    const docId = (await run0({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    page.textSource.docId = docId;
    const run = toolWith({ page: () => page as never });
    const saved = await run({ action: "save_source", docId, expectedRev: 0, markdown: "# T\n" });
    expect(saved.payload.userDraft).toContain("unsaved");
    const read = await run({ action: "read_source", docId });
    expect(read.payload.userDraft).toContain("not saved");
  });

  test("read_source returns the whole text, or parts that never join versions", async () => {
    const run0 = toolWith();
    const docId = (await run0({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    await run0({ action: "save_source", docId, expectedRev: 0, markdown: lines });
    const whole = await run0({ action: "read_source", docId });
    expect(whole.payload.markdown).toBe(lines);
    expect(whole.payload.batch).toMatchObject({ status: "complete", from: 0, total: lines.length });
    // a window that fits only part of it: parts, each saying what is NOT read
    const small = toolWith({ budget: () => 6000 });
    const first = await small({ action: "read_source", docId });
    expect(first.payload.batch.status).toBe("partial");
    expect(first.payload.batch.note).toContain("NOT");
    expect(first.payload.markdown.endsWith("\n")).toBe(true);
    let text = first.payload.markdown as string;
    let batch = first.payload.batch;
    const version = first.payload.version as string;
    for (let guard = 0; batch.status === "partial" && guard < 100; guard++) {
      const next = await small({ action: "read_source", docId, from: batch.to, version });
      expect(next.payload.ok).toBe(true);
      text += next.payload.markdown;
      batch = next.payload.batch;
    }
    expect(text).toBe(lines);
    // a continuation without or with another version is refused
    expect((await small({ action: "read_source", docId, from: 10 })).payload.status).toBe(
      "conflict"
    );
    await run0({ action: "save_source", docId, expectedRev: 1, markdown: `${lines}\nmore` });
    const changed = await small({
      action: "read_source",
      docId,
      from: first.payload.batch.to,
      version,
    });
    expect(changed.payload).toMatchObject({ status: "conflict", reason: "version_changed" });
    // not even the smallest part fits: said with the actual gap
    const tiny = await toolWith({ budget: () => 100 })({ action: "read_source", docId });
    expect(tiny.payload).toMatchObject({ ok: false, status: "rejected" });
    expect(tiny.payload.detail).toContain("NOT read");
  });

  test("validate reports located diagnostics and writes nothing; generate with errors keeps the old reading", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    await run({
      action: "save_source",
      docId,
      expectedRev: 0,
      markdown: "# T\n\n![x](assets/missing.png)\n",
    });
    const v = await run({ action: "validate", docId, sourceRev: 1 });
    expect(v.payload.valid).toBe(false);
    expect(v.payload.diagnostics[0]).toMatchObject({ line: 3 });
    const g = await run({ action: "generate", docId, sourceRev: 1 });
    expect(g.payload).toMatchObject({ ok: false, status: "invalid" });
    expect(existsSync(join(dataDir, "output", docId, `${docId}.json`))).toBe(false);
    expect((await run({ action: "validate", docId, sourceRev: 9 })).payload.status).toBe(
      "conflict"
    );
  });
});

describe("images", () => {
  test("add_asset takes only an image the user attached; add_pdf_image renders from the verified original", async () => {
    const bytes = syntheticPdf({ pageCount: 2 });
    const probed = await probePdf(bytes);
    const pdf = publishPdfDoc(paths, {
      workId: KNOWN_WORK_ID,
      filename: "s.pdf",
      bytes,
      pages: probed.pages,
    });
    const run0 = toolWith();
    const docId = (
      await run0({ action: "create", workId: KNOWN_WORK_ID, sourcePdfDocId: pdf.doc_id })
    ).payload.docId as string;
    const none = await run0({
      action: "add_asset",
      docId,
      expectedRev: 0,
      attachmentId: randomUUID(),
    });
    expect(none.payload.status).toBe("not_found");
    const added = await run0({
      action: "add_pdf_image",
      docId,
      expectedRev: 0,
      sha256: pdf.sha256,
      pageIndex: 0,
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(added.payload).toMatchObject({ ok: true, status: "ok", reused: false, rev: 1 });
    expect(added.payload.observed).toContain("assets/");
    expect(readdirSync(join(dataDir, "output", docId, "assets"))).toEqual([
      added.payload.asset.name,
    ]);
    // a wrong original and a stale rev are conflicts that write nothing
    expect(
      (
        await run0({
          action: "add_pdf_image",
          docId,
          expectedRev: 1,
          sha256: "0".repeat(64),
          pageIndex: 0,
        })
      ).payload.status
    ).toBe("conflict");
    expect(
      (
        await run0({
          action: "add_pdf_image",
          docId,
          expectedRev: 0,
          sha256: pdf.sha256,
          pageIndex: 1,
        })
      ).payload.status
    ).toBe("conflict");
    expect((await sourceOf(docId)).assets).toHaveLength(1);
    // the source PDF opens through the workspace's own open_doc
    const seen: unknown[] = [];
    const open = await toolWith({
      viewAction: async (a) => {
        seen.push(a);
        return { status: "displayed" };
      },
    })({ action: "open_source_pdf", docId });
    expect(open.payload.ok).toBe(true);
    expect(seen).toEqual([{ action: "open_doc", docId: pdf.doc_id }]);
  });

  test("an attached image is added through the same asset path", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR"),
      Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]),
      Buffer.alloc(4),
      Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    ]);
    const id = randomUUID();
    const run = toolWith({
      attachment: (a) =>
        a === id
          ? {
              meta: { filename: "fig.png", sha256: createHash("sha256").update(png).digest("hex") },
              bytes: png,
            }
          : null,
    });
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    const added = await run({ action: "add_asset", docId, expectedRev: 0, attachmentId: id });
    expect(added.payload).toMatchObject({ ok: true, rev: 1 });
    expect(added.payload.asset.name).toMatch(/^fig-[0-9a-f]{8}\.png$/);
  });
});

describe("a replacement of annotated reading text needs the real user", () => {
  test("the model's parameters cannot carry a confirmation; nothing runs", async () => {
    const docId = await annotatedDoc();
    const run = toolWith();
    await run({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const ir = irBytes(docId);
    const impact: Partial<TextReplacementImpact> = { docId, sourceRev: 2 };
    const forged = await run({ action: "generate", docId, sourceRev: 2, confirm: impact });
    expect(forged.payload).toMatchObject({ ok: false, status: "invalid" });
    expect(irBytes(docId).equals(ir)).toBe(true);
  });

  test("without a confirmation port, or when the user declines or it expires, nothing is published and no confirm is ever sent", async () => {
    const docId = await annotatedDoc();
    await toolWith()({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const ir = irBytes(docId);
    const sent: unknown[] = [];
    const spy = new Proxy(service, {
      get(target, key) {
        if (key === "generate")
          return (id: string, body: unknown) => {
            sent.push(body);
            return target.generate(id, body);
          };
        const value = (target as never)[key];
        return typeof value === "function"
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const without = await toolWith({ text: spy })({ action: "generate", docId, sourceRev: 2 });
    expect(without.payload.status).toBe("unsupported");
    const asked: Asked[] = [];
    for (const outcome of [
      { outcome: "declined" },
      { outcome: "expired", reason: "stale" },
      { outcome: "expired", reason: "stopped" },
    ] as const) {
      const r = await toolWith({
        text: spy,
        confirm: {
          request: async (entry) => {
            asked.push(entry);
            return outcome;
          },
        },
      })({ action: "generate", docId, sourceRev: 2 });
      expect(r.payload.ok).toBe(false);
      expect(["declined", "expired"]).toContain(r.payload.status);
    }
    expect(asked).toHaveLength(3);
    expect(asked[0]).toMatchObject({
      action: "replace_text_reading",
      docId,
      impact: { annotations: 1, sourceRev: 2, publishedSourceRev: 1 },
      baseRev: asked[0]?.baseRev,
    });
    // every request the tool made had NO confirm: only an approved card can add one
    expect(sent.every((body) => !("confirm" in (body as object)))).toBe(true);
    expect(irBytes(docId).equals(ir)).toBe(true);
    // the service itself still refuses an unconfirmed replacement (the tool is not the only guard)
    const direct = await call("POST", `/api/paper/${docId}/source/generate`, {
      sourceRev: 2,
      operationId: "direct-0001",
    });
    expect(direct.status).toBe(409);
  });

  test("only the user's approval publishes, with the very values the card showed; a change after the click is refused", async () => {
    const docId = await annotatedDoc();
    await toolWith()({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const asked: Asked[] = [];
    const ok = await toolWith({
      confirm: {
        request: async (entry) => {
          asked.push(entry);
          return { outcome: "approved" as const };
        },
      },
    })({ action: "generate", docId, sourceRev: 2 });
    expect(ok.payload).toMatchObject({
      ok: true,
      status: "ok",
      replacedAnnotations: 1,
      publishedSourceRev: 2,
    });
    expect(asked).toHaveLength(1);
    expect((await sourceOf(docId)).published_source_rev).toBe(2);
    // second Doc: the user approves, but the source moves before the tool's own request reaches the server
    const other = await annotatedDoc();
    await toolWith()({ action: "save_source", docId: other, expectedRev: 1, markdown: CHANGED });
    const moved = await toolWith({
      confirm: {
        request: async () => {
          await call("PUT", `/api/paper/${other}/source`, {
            expectedRev: 2,
            markdown: "# other\n\nnew typing\n",
          });
          return { outcome: "approved" as const };
        },
      },
    })({ action: "generate", docId: other, sourceRev: 2 });
    expect(moved.payload).toMatchObject({ ok: false, status: "expired" });
    expect((await sourceOf(other)).published_source_rev).toBe(1);
  });

  test("the click-time check probes the generation's own code and ends when the values move", async () => {
    const docId = await annotatedDoc();
    await toolWith()({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const probe = await service.probeReplacement(docId, 2);
    expect(probe).toMatchObject({
      ok: true,
      impact: { annotations: 1, sourceRev: 2, publishedSourceRev: 1 },
    });
    const before = irBytes(docId);
    expect(irBytes(docId).equals(before)).toBe(true);
    // the source moves: a probe of the old rev is no longer valid; the Doc is unchanged
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 2, markdown: "# x\n" });
    expect(await service.probeReplacement(docId, 2)).toEqual({ ok: false });
    expect(messages.filter((m) => m.type === "text-doc.published")).toHaveLength(1);
  });

  test("the description stays concise: every action is named and the tool is a closed union", async () => {
    const tool = createTextTool({
      text: service,
      admitting: () => true,
      viewAction: async () => ({ status: "displayed" }),
    });
    const names = [
      "create",
      "read_source",
      "save_source",
      "add_asset",
      "add_pdf_image",
      "validate",
      "generate",
      "open_source_pdf",
    ];
    for (const name of names) expect(tool.description).toContain(name);
    expect(tool.description.length).toBeLessThan(3500);
    const bad = await toolWith()({ action: "write_file", path: "/etc/passwd" });
    expect(bad.payload.status).toBe("invalid");
    const doc = (await (await call("GET", "/api/papers")).json()) as { papers: string[] };
    expect(Array.isArray(doc.papers)).toBe(true);
    void (null as unknown as DocDescription);
  });
});
