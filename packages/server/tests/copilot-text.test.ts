/**
 * The Copilot `text` tool (copilot ticket 29) on the real seam: the real TextDocService (the very handlers of the
 * source panel's routes), a real temp dataDir and real HTTP routes of `createApp` for setting the data up and for
 * reading the outcome back. Only the human confirmation port is a test double, and it records what it was asked.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { type ConfirmationPort, digest } from "../src/copilot-plan-tool.js";
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
let docMutationsBusy: (docId: string) => boolean;
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
  docMutationsBusy = (id) => docMutations.isDeleting(id) || docMutations.isBusy(id);
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
/** A tool that has read the Doc's source (as a run that looked first): its writes may name the rev it saw. */
const knows = async (docId: string, extra: Partial<TextToolContext> = {}) => {
  const run = toolWith(extra);
  await run({ action: "read_source", docId });
  return run;
};
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

  test("save_source is the panel's PUT: a stale rev is a conflict that writes nothing and never hands out the current rev", async () => {
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
    expect(stale.payload).toMatchObject({ ok: false, status: "conflict" });
    expect(JSON.stringify(stale.payload)).not.toMatch(/"current"|"rev":2/);
    expect(stale.operation.status).toBe("conflict");
    expect((await sourceOf(docId)).markdown).toBe("# A\n\nUSER\n");
  });

  test("B2: a blind resend after a conflict is refused; only a rev this run saw (a complete read, its own result, the page) is accepted", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    await run({ action: "save_source", docId, expectedRev: 0, markdown: "# A\n\nx\n" });
    await call("PUT", `/api/paper/${docId}/source`, {
      expectedRev: 1,
      markdown: "# A\n\nUSER typed this\n",
    }); // rev 2
    expect(
      (await run({ action: "save_source", docId, expectedRev: 1, markdown: "# mine\n" })).payload
        .status
    ).toBe("conflict");
    // the model guesses the new rev (it may read it off the page or the network): it never saw that revision
    for (const guess of [2, 3, 99]) {
      const blind = await run({
        action: "save_source",
        docId,
        expectedRev: guess,
        markdown: "# blind\n",
      });
      expect(blind.payload).toMatchObject({ ok: false, status: "rejected" });
      expect(blind.payload.detail).toContain("read_source");
    }
    expect((await sourceOf(docId)).markdown).toBe("# A\n\nUSER typed this\n");
    // a PART of the source is not a reading of it; the complete read (all parts at one version) is
    const big = `# A\n\n${Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")}\n`;
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 2, markdown: big }); // rev 3
    const small = toolWith({ budget: () => 6000 });
    const first = await small({ action: "read_source", docId });
    expect(first.payload.batch.status).toBe("partial");
    expect(
      (await small({ action: "save_source", docId, expectedRev: 3, markdown: "# early\n" })).payload
        .status
    ).toBe("rejected");
    let batch = first.payload.batch;
    for (let guard = 0; batch.status === "partial" && guard < 100; guard++)
      batch = (
        await small({
          action: "read_source",
          docId,
          from: batch.to,
          version: first.payload.version,
        })
      ).payload.batch;
    const saved = await small({
      action: "save_source",
      docId,
      expectedRev: 3,
      markdown: "# after the whole read\n",
    });
    expect(saved.payload).toMatchObject({ ok: true, rev: 4 });
    // its own result is a rev it saw; append works from there
    expect(
      (
        await small({
          action: "save_source",
          docId,
          expectedRev: 4,
          markdown: "more\n",
          append: true,
        })
      ).payload
    ).toMatchObject({ ok: true, rev: 5 });
    // the page reporting a saved editor at a rev is NOT a sighting: the model never received that text (observations
    // strip it, an envelope may drop it, a long source is never inline), so it may not overwrite it
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 5, markdown: "# user again\n" }); // rev 6
    const page = { textSource: { docId, unsaved: false, rev: 6 } };
    const viaPage = toolWith({ page: () => page as never });
    for (const guess of [6, 7])
      expect(
        (
          await viaPage({
            action: "save_source",
            docId,
            expectedRev: guess,
            markdown: "# via page\n",
          })
        ).payload.status
      ).toBe("rejected");
    expect((await sourceOf(docId)).markdown).toBe("# user again\n");
    // asset additions need the same sighting
    expect(
      (
        await toolWith()({
          action: "add_pdf_image",
          docId,
          expectedRev: 7,
          sha256: "0".repeat(64),
          pageIndex: 0,
        })
      ).payload.status
    ).toBe("rejected");
  });

  test("the user's unsaved typing in the panel is reported and never touched", async () => {
    const page = { textSource: { docId: "", unsaved: true } };
    const run0 = toolWith();
    const docId = (await run0({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    page.textSource.docId = docId;
    const run = await knows(docId, { page: () => page as never });
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
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
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
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
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
    await (await knows(other))({
      action: "save_source",
      docId: other,
      expectedRev: 1,
      markdown: CHANGED,
    });
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
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const probe = await service.probeReplacement(docId, 2);
    expect(probe).toMatchObject({
      kind: "impact",
      impact: { annotations: 1, sourceRev: 2, publishedSourceRev: 1 },
    });
    const before = irBytes(docId);
    expect(irBytes(docId).equals(before)).toBe(true);
    // the source moves: a probe of the old rev is no longer valid; the Doc is unchanged
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 2, markdown: "# x\n" });
    expect(await service.probeReplacement(docId, 2)).toEqual({ kind: "changed" });
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

// ---- fix round 1 -------------------------------------------------------------------------------------------- //
import { ContextCoverageSchema, ReadingLedger } from "@argelanderspace/contracts";
import { createReaderTool } from "../src/copilot-reader-tool.js";

describe("fix round 1", () => {
  test("B1: reader set_text_view is callable with its view, and only with a valid one", async () => {
    const seen: unknown[] = [];
    const tool = createReaderTool({
      reader: {} as never,
      conversationId: "c",
      admitting: () => true,
      viewAction: async (action) => {
        seen.push(action);
        return { status: "displayed" };
      },
    });
    const exec = (params: object) =>
      tool.execute(
        "c1",
        params as never,
        undefined as never,
        undefined as never,
        undefined as never
      );
    const ok = await exec({ action: "set_text_view", docId: "text-x", view: "source" });
    expect(JSON.parse((ok.content[0] as { text: string }).text)).toMatchObject({ ok: true });
    expect(seen).toEqual([{ action: "set_text_view", docId: "text-x", view: "source" }]);
    const bad = await exec({ action: "set_text_view", docId: "text-x", view: "elsewhere" });
    expect((bad.details as { status: string }).status).not.toBe("ok");
    const missing = await exec({ action: "set_text_view", docId: "text-x" });
    expect((missing.details as { status: string }).status).not.toBe("ok");
    expect(seen).toHaveLength(1);
    expect(JSON.stringify((tool as unknown as { parameters: unknown }).parameters)).toContain(
      '"view"'
    );
  });

  test("read_source parts are recorded as coverage with a version, and the ledger knows when the whole source was given", async () => {
    const run0 = toolWith();
    const docId = (await run0({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    await run0({ action: "save_source", docId, expectedRev: 0, markdown: lines });
    const small = toolWith({ budget: () => 6000 });
    const ledger = new ReadingLedger();
    let from = 0;
    let version: string | undefined;
    let last: ReturnType<typeof ContextCoverageSchema.parse> | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const r = await small({ action: "read_source", docId, ...(from ? { from, version } : {}) });
      const coverage = ContextCoverageSchema.parse(
        (r.operation as unknown as { batch: unknown }).batch
      );
      expect(coverage).toMatchObject({
        kind: "text",
        unit: "characters",
        docId,
        from,
        total: lines.length,
      });
      expect(coverage.version).toBe(r.payload.version);
      expect(ledger.complete("text", docId, coverage.version)).toBe(false);
      ledger.add(coverage);
      version = r.payload.version;
      last = coverage;
      from = coverage.to;
      if (coverage.status === "complete") break;
    }
    expect(last?.status).toBe("complete");
    expect(ledger.complete("text", docId, last?.version as string)).toBe(true);
    // a source larger than the window that cannot give even its smallest part says so as an omitted coverage
    const tiny = await toolWith({ budget: () => 100 })({ action: "read_source", docId });
    expect(
      ContextCoverageSchema.parse((tiny.operation as unknown as { batch: unknown }).batch)
    ).toMatchObject({ status: "omitted", kind: "text", from: 0, to: 0 });
  });

  test("N4: a reused operationId reports what really happened, not a fresh publication", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    await run({ action: "save_source", docId, expectedRev: 0, markdown: SOURCE });
    const first = await run({
      action: "generate",
      docId,
      sourceRev: 1,
      operationId: "gen-op-00001",
    });
    expect(first.payload).toMatchObject({ ok: true, status: "ok" });
    const again = await run({
      action: "generate",
      docId,
      sourceRev: 1,
      operationId: "gen-op-00001",
    });
    expect(again.payload).toMatchObject({ ok: true, status: "noop" });
    expect(again.payload.detail).toContain("already published");
    expect(messages.filter((m) => m.type === "text-doc.published")).toHaveLength(1);
    // a new source revision under the same id is a new generation
    await run({ action: "save_source", docId, expectedRev: 1, markdown: `${SOURCE}\nmore\n` });
    const next = await run({
      action: "generate",
      docId,
      sourceRev: 2,
      operationId: "gen-op-00001",
    });
    expect(next.payload).toMatchObject({ ok: true, status: "ok", publishedSourceRev: 2 });
  });

  test("the card names the Doc by its title, not its id", async () => {
    const docId = await annotatedDoc();
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const asked: Asked[] = [];
    await toolWith({
      confirm: {
        request: async (entry) => {
          asked.push(entry);
          return { outcome: "declined" as const };
        },
      },
    })({ action: "generate", docId, sourceRev: 2 });
    expect(asked[0]).toMatchObject({ action: "replace_text_reading", label: "Weak lensing" });
  });

  test("PDF pictures have a neutral stem: neither the page nor the region is in the name", async () => {
    const bytes = syntheticPdf({ pageCount: 2 });
    const probed = await probePdf(bytes);
    const pdf = publishPdfDoc(paths, {
      workId: KNOWN_WORK_ID,
      filename: "s.pdf",
      bytes,
      pages: probed.pages,
    });
    const run = toolWith();
    const docId = (
      await run({ action: "create", workId: KNOWN_WORK_ID, sourcePdfDocId: pdf.doc_id })
    ).payload.docId as string;
    const whole = await run({
      action: "add_pdf_image",
      docId,
      expectedRev: 0,
      sha256: pdf.sha256,
      pageIndex: 1,
    });
    expect(whole.payload.asset.name).toMatch(/^pdf-image-[0-9a-f]{8}\.png$/);
    const region = await run({
      action: "add_pdf_image",
      docId,
      expectedRev: 1,
      sha256: pdf.sha256,
      pageIndex: 1,
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(region.payload.asset.name).toMatch(/^pdf-image-[0-9a-f]{8}\.png$/);
    expect(region.payload.asset.name).not.toBe(whole.payload.asset.name);
  });

  test("a picture over the asset limit is rendered again smaller before it is refused", async () => {
    const calls: number[] = [];
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(21 * 1024 * 1024),
    ]);
    const bytes = syntheticPdf({ pageCount: 1 });
    const probed = await probePdf(bytes);
    const pdf = publishPdfDoc(paths, {
      workId: KNOWN_WORK_ID,
      filename: "s.pdf",
      bytes,
      pages: probed.pages,
    });
    const real = readFileSync(join(dataDir, "output", pdf.doc_id, "original.pdf"));
    const svc = new TextDocService({
      paths,
      libraryLock: new AsyncLock(),
      annotationLock: new AsyncLock(),
      docMutations: new DocMutationRegistry(),
      broadcast: () => {},
      libraryChanged: () => {},
      renderPdfRegion: async (request) => {
        calls.push(request.longEdge);
        if (calls.length < 3) return { kind: "ok", png: big, width: 3000, height: 3000 };
        const image = await renderPdfRegionImage(
          real,
          request.expectedHash,
          request.pageIndex,
          request.region,
          request.longEdge
        );
        return { kind: "ok", png: image.png, width: image.width, height: image.height };
      },
    });
    const run = toolWith({ text: svc });
    const docId = (
      await run({ action: "create", workId: KNOWN_WORK_ID, sourcePdfDocId: pdf.doc_id })
    ).payload.docId as string;
    const added = await run({
      action: "add_pdf_image",
      docId,
      expectedRev: 0,
      sha256: pdf.sha256,
      pageIndex: 0,
      longEdge: 3000,
    });
    expect(added.payload).toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toBeLessThan(calls[0] as number);
    expect(calls[2]).toBeLessThan(calls[1] as number);
    // an image that stays too large at every size is refused whole
    const always = new TextDocService({
      paths,
      libraryLock: new AsyncLock(),
      annotationLock: new AsyncLock(),
      docMutations: new DocMutationRegistry(),
      broadcast: () => {},
      libraryChanged: () => {},
      renderPdfRegion: async () => ({ kind: "ok", png: big, width: 1, height: 1 }),
    });
    const refused = await toolWith({ text: always })({
      action: "add_pdf_image",
      docId,
      expectedRev: 1,
      sha256: pdf.sha256,
      pageIndex: 0,
    });
    expect(refused.payload.status).toBe("rejected");
  });

  test("M1: the confirmed generate is journaled before it runs; a repeat is answered, a restart in between is unknown, never expired", async () => {
    const docId = await annotatedDoc();
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const events: string[] = [];
    const store = new Map<
      string,
      {
        state: "done" | "begun";
        hash: string;
        payload?: Record<string, unknown>;
        operation?: never;
      }
    >();
    const journal = {
      lookup: (id: string) => (store.get(id) as never) ?? null,
      begin: (entry: { operationId: string; hash: string }) => {
        events.push("begin");
        store.set(entry.operationId, { state: "begun", hash: entry.hash });
      },
      done: (id: string, payload: Record<string, unknown>, operation: never) => {
        events.push("done");
        store.set(id, { state: "done", hash: store.get(id)?.hash ?? "", payload, operation });
      },
    };
    const spy = new Proxy(service, {
      get(target, key) {
        if (key === "generate")
          return (id: string, body: { confirm?: unknown }) => {
            events.push(body.confirm ? "generate+confirm" : "generate");
            return target.generate(id, body);
          };
        const value = (target as never)[key];
        return typeof value === "function"
          ? (value as (...a: never[]) => unknown).bind(target)
          : value;
      },
    });
    const confirm = {
      request: async () => {
        events.push("card");
        return { outcome: "approved" as const };
      },
    };
    const run = toolWith({ text: spy, confirm, journal });
    const ok = await run({
      action: "generate",
      docId,
      sourceRev: 2,
      operationId: "gen-op-journal",
    });
    expect(ok.payload).toMatchObject({ ok: true, status: "ok" });
    expect(events).toEqual(["generate", "card", "begin", "generate+confirm", "done"]);
    // asked again with the same id: answered from the record, nothing runs
    events.length = 0;
    const dup = await run({
      action: "generate",
      docId,
      sourceRev: 2,
      operationId: "gen-op-journal",
    });
    expect(dup.payload).toMatchObject({ ok: true, duplicate: true });
    expect(events).toEqual([]);
    // a begin without a result (the service restarted after the click): unknown, and nothing is repeated
    store.clear();
    store.set("gen-op-restart", { state: "begun", hash: digest({ docId, sourceRev: 2 }) });
    const restarted = await run({
      action: "generate",
      docId,
      sourceRev: 2,
      operationId: "gen-op-restart",
    });
    expect(restarted.payload.status).toBe("unknown");
    expect(events).toEqual([]);
  });
});

describe("N1/N2: the click-time probe", () => {
  test("N1: overlapping probes and a user's own Generate never meet each other as busy or stale", async () => {
    const docId = await annotatedDoc();
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const results = await Promise.all([
      service.probeReplacement(docId, 2),
      service.probeReplacement(docId, 2),
      service.probeReplacement(docId, 2),
      call("POST", `/api/paper/${docId}/source/generate`, {
        sourceRev: 2,
        operationId: "user-gen-0001",
      }),
      service.probeReplacement(docId, 2),
    ]);
    for (const probe of [results[0], results[1], results[2], results[4]])
      expect(probe).toMatchObject({ kind: "impact", impact: { annotations: 1 } });
    // the user's Generate answered as it always does (a question), never "document busy"
    const generate = results[3] as Response;
    expect(generate.status).toBe(409);
    expect(((await generate.json()) as { code: string }).code).toBe("confirmation_required");
    // and the probe takes no writer pin
    const probing = service.probeReplacement(docId, 2);
    expect(docMutationsBusy(docId)).toBe(false);
    await probing;
  });

  test("N2: a system error at the probe is an error with its real reason, never a change", async () => {
    const docId = await annotatedDoc();
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    const current = join(dataDir, "annotations", docId, "current.json");
    writeFileSync(current, "{ this is not json");
    const probe = await service.probeReplacement(docId, 2);
    expect(probe).toMatchObject({ kind: "error", code: "annotations_unreadable" });
    expect(readFileSync(current, "utf8")).toBe("{ this is not json");
  });
});

describe("fix round 2: what the model has really been given", () => {
  test("B2-1: read rev 1, the user saves rev 2 and the page reports it: the agent's save with 2 (or a guessed rev+1) is refused and the user's text is intact", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    await run({ action: "save_source", docId, expectedRev: 0, markdown: "# one\n" });
    const read = await run({ action: "read_source", docId });
    expect(read.payload.rev).toBe(1);
    await call("PUT", `/api/paper/${docId}/source`, {
      expectedRev: 1,
      markdown: "# USER saved this\n",
    }); // rev 2
    const stale = await run({
      action: "save_source",
      docId,
      expectedRev: 1,
      markdown: "# agent\n",
    });
    expect(stale.payload.status).toBe("conflict");
    for (const guess of [2, 3]) {
      const blind = await run({
        action: "save_source",
        docId,
        expectedRev: guess,
        markdown: "# agent\n",
      });
      expect(blind.payload).toMatchObject({ ok: false, status: "rejected" });
    }
    expect((await sourceOf(docId)).markdown).toBe("# USER saved this\n");
  });

  test("B2-1: a rev the run wrote is known only while nothing else was written in between", async () => {
    const run = toolWith();
    const docId = (await run({ action: "create", workId: KNOWN_WORK_ID })).payload.docId as string;
    const first = await run({ action: "save_source", docId, expectedRev: 0, markdown: "# a\n" });
    expect(first.payload.rev).toBe(1);
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 1, markdown: "# user\n" }); // 2
    // the agent's save at its OWN old rev 1 conflicts; rev 2 was never delivered to it
    expect(
      (await run({ action: "save_source", docId, expectedRev: 1, markdown: "# b\n" })).payload
        .status
    ).toBe("conflict");
    expect(
      (await run({ action: "save_source", docId, expectedRev: 2, markdown: "# b\n" })).payload
        .status
    ).toBe("rejected");
  });

  test("B2-2: a duplicate create (same operationId, even from a later run) marks nothing as seen", async () => {
    const first = toolWith();
    const made = await first({
      action: "create",
      workId: KNOWN_WORK_ID,
      operationId: "agent-op-dup-0001",
    });
    expect(made.payload.created).toBe(true);
    const docId = made.payload.docId as string;
    await first({
      action: "save_source",
      docId,
      expectedRev: 0,
      markdown: "# user typed this later\n",
    });
    // a later run asks again with the same id: it is told the Doc, but it has not been given its text
    const later = toolWith();
    const again = await later({
      action: "create",
      workId: KNOWN_WORK_ID,
      operationId: "agent-op-dup-0001",
    });
    expect(again.payload).toMatchObject({ ok: true, created: false, docId });
    const blind = await later({
      action: "save_source",
      docId,
      expectedRev: 0,
      markdown: "# overwritten\n",
    });
    expect(blind.payload).toMatchObject({ ok: false, status: "rejected" });
    const guess = await later({
      action: "save_source",
      docId,
      expectedRev: again.payload.rev,
      markdown: "# overwritten\n",
    });
    expect(guess.payload.status).toBe("rejected");
    expect((await sourceOf(docId)).markdown).toBe("# user typed this later\n");
  });

  test("N2/N1: a Doc deleted while its card waits is a change, never a system error", async () => {
    const docId = await annotatedDoc();
    await (await knows(docId))({ action: "save_source", docId, expectedRev: 1, markdown: CHANGED });
    expect((await call("DELETE", `/api/paper/${docId}`)).status).toBe(200);
    expect(await service.probeReplacement(docId, 2)).toEqual({ kind: "changed" });
  });
});
