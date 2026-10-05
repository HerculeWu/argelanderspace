/**
 * Text Doc: save to first reading (copilot ticket 25) on the real seam: `createApp` with a temp dataDir, real HTTP
 * routes, real library/annotation/Doc-mutation locks and disk. Nothing in the text path is mocked.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AnnotationsFile,
  CoherentAnnotationsRead,
  DocDescription,
  TextGenerationResult,
  TextSourceDto,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { LibraryStore, libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";

let dataDir: string;
let paths: ReturnType<typeof libraryPaths>;
let app: Hono;
let messages: WsServerMessage[];
let docMutations: DocMutationRegistry;
let pause: {
  hold: Promise<void>;
  release: () => void;
  reached: Promise<void>;
  hit: () => void;
} | null;
let afterCandidate: (() => Promise<void> | void) | null;

function build() {
  paths = libraryPaths(dataDir);
  const collector = collectBroadcasts();
  messages = collector.messages;
  docMutations = new DocMutationRegistry();
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    docMutations,
    textDocHooks: {
      beforePublish: async () => {
        pause?.hit();
        await pause?.hold;
        await afterCandidate?.();
      },
    },
  });
}

beforeEach(() => {
  dataDir = makeDataDir();
  pause = null;
  afterCandidate = null;
  build();
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let opCounter = 0;
async function createDoc(workId = KNOWN_WORK_ID): Promise<string> {
  const res = await call("POST", "/api/library/text-docs", {
    workId,
    operationId: `op-test-${++opCounter}-${Math.random().toString(16).slice(2)}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: DocDescription }).description.doc_id;
}
async function put(docId: string, expectedRev: number, markdown: string) {
  return call("PUT", `/api/paper/${docId}/source`, { expectedRev, markdown });
}
async function generate(
  docId: string,
  sourceRev: number,
  operationId = `gen-${Math.random()}-xxxx`
) {
  return call("POST", `/api/paper/${docId}/source/generate`, { sourceRev, operationId });
}
const docDir = (docId: string) => join(dataDir, "output", docId);
const irFile = (docId: string) => join(docDir(docId), `${docId}.json`);
const annDir = (docId: string) => join(dataDir, "annotations", docId);
const SOURCE = "# Weak lensing\n\nFirst paragraph here.\n\n- alpha\n- beta\n";

describe("creation under a Work", () => {
  test("appends a text-UUID Doc to the existing Work, the main Doc unchanged, and is idempotent per operation", async () => {
    const before = LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids ?? [];
    const operationId = "op-idempotent-0001";
    const first = await call("POST", "/api/library/text-docs", {
      workId: KNOWN_WORK_ID,
      operationId,
    });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { description: DocDescription; source: TextSourceDto };
    const docId = body.description.doc_id;
    expect(docId).toMatch(/^text-[0-9a-f-]{36}$/);
    expect(body.description).toMatchObject({
      format: "text",
      generated: false,
      source_rev: 0,
      published_source_rev: null,
    });
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toEqual([...before, docId]);
    expect(messages.some((m) => m.type === "library.changed")).toBe(true);

    const again = await call("POST", "/api/library/text-docs", {
      workId: KNOWN_WORK_ID,
      operationId,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { description: DocDescription }).description.doc_id).toBe(
      docId
    );
    expect(readdirSync(join(dataDir, "output")).filter((n) => n.startsWith("text-"))).toEqual([
      docId,
    ]);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toEqual([...before, docId]);
  });

  test("unknown Work 404, bad body 400, foreign Origin 403, and nothing visible is left behind", async () => {
    expect(
      (
        await call("POST", "/api/library/text-docs", {
          workId: "nope:1",
          operationId: "op-unknown-01",
        })
      ).status
    ).toBe(404);
    expect((await call("POST", "/api/library/text-docs", { workId: "x" })).status).toBe(400);
    expect(
      (
        await call(
          "POST",
          "/api/library/text-docs",
          { workId: KNOWN_WORK_ID, operationId: "op-origin-001" },
          { Origin: "https://evil.example" }
        )
      ).status
    ).toBe(403);
    expect(
      readdirSync(join(dataDir, "output")).filter((n) => n.startsWith("text-") || n.startsWith("."))
    ).toEqual([]);
  });

  test("a source PDF must be a PDF Doc of the same Work (file relation only)", async () => {
    const res = await call("POST", "/api/library/text-docs", {
      workId: KNOWN_WORK_ID,
      sourcePdfDocId: "not-a-doc",
      operationId: "op-badpdf-0001",
    });
    expect(res.status).toBe(400);
    expect(readdirSync(join(dataDir, "output")).filter((n) => n.startsWith("text-"))).toEqual([]);
  });
});

describe("source editing and saving", () => {
  test("a first draft is legitimate: description, list and source exist, the reading text does not", async () => {
    const docId = await createDoc();
    const description = (await (
      await call("GET", `/api/paper/${docId}/description`)
    ).json()) as DocDescription;
    expect(description).toMatchObject({
      format: "text",
      generated: false,
      published_source_rev: null,
    });
    expect(
      ((await (await call("GET", "/api/papers")).json()) as { papers: string[] }).papers
    ).toContain(docId);
    expect((await call("GET", `/api/paper/${docId}/ir`)).status).toBe(404);
    expect(existsSync(irFile(docId))).toBe(false);
    const source = (await (
      await call("GET", `/api/paper/${docId}/source`)
    ).json()) as TextSourceDto;
    expect(source).toMatchObject({ rev: 0, markdown: "", generated: false });
  });

  test("round-trips bytes (unclosed syntax too), bumps rev, never generates", async () => {
    const docId = await createDoc();
    const text = "﻿# T\r\n\r\n```\nunclosed $x\t中文😀\n";
    const res = await put(docId, 0, text);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as TextSourceDto;
    expect(saved.rev).toBe(1);
    const got = (await (await call("GET", `/api/paper/${docId}/source`)).json()) as TextSourceDto;
    expect(got.markdown).toBe(text);
    // saving, opening and reading never generate (A17)
    await call("GET", `/api/paper/${docId}/description`);
    await call("GET", `/api/paper/${docId}/source`);
    expect(existsSync(irFile(docId))).toBe(false);
    expect(messages.filter((m) => m.type === "text-source.changed")).toHaveLength(1);
    expect(messages.some((m) => m.type === "text-doc.published")).toBe(false);
  });

  test("a stale expectedRev is 409 with the stored source and writes nothing", async () => {
    const docId = await createDoc();
    await put(docId, 0, "mine one");
    const file = join(docDir(docId), "text-source.json");
    const before = readFileSync(file);
    const res = await put(docId, 0, "another writer");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string; rev: number; source: TextSourceDto };
    expect(body).toMatchObject({ detail: "rev mismatch", rev: 1 });
    expect(body.source.markdown).toBe("mine one");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("bad bodies, bad ids, foreign Origin and unknown Docs are refused", async () => {
    const docId = await createDoc();
    expect((await call("PUT", `/api/paper/${docId}/source`, { expectedRev: "x" })).status).toBe(
      400
    );
    expect(
      (
        await call(
          "PUT",
          `/api/paper/${docId}/source`,
          { expectedRev: 0, markdown: "x" },
          { Origin: "https://evil.example" }
        )
      ).status
    ).toBe(403);
    expect((await put("text-00000000-0000-4000-8000-000000000000", 0, "x")).status).toBe(404);
    expect((await call("GET", "/api/paper/.hidden/source")).status).toBe(400);
    expect((await call("GET", "/api/paper/arxiv-2501.17225/source")).status).toBe(404);
  });

  test("a save during a delete is refused (document busy) and writes nothing", async () => {
    const docId = await createDoc();
    expect(docMutations.tryBeginDelete(docId)).toBe(true);
    const file = join(docDir(docId), "text-source.json");
    const before = readFileSync(file);
    const res = await put(docId, 0, "late write");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("document busy");
    expect(readFileSync(file).equals(before)).toBe(true);
    docMutations.endDelete(docId);
  });
});

describe("validation", () => {
  test("has no side effect: no reading text, no annotations, source bytes untouched", async () => {
    const docId = await createDoc();
    await put(docId, 0, "# T\n\n> quoted\n");
    const file = join(docDir(docId), "text-source.json");
    const before = readFileSync(file);
    const res = await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 1 });
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      valid: boolean;
      diagnostics: { line?: number; code: string }[];
    };
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "quote_unsupported", line: 3 });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(irFile(docId))).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);
    const valid = await put(docId, 1, SOURCE);
    expect(valid.status).toBe(200);
    expect(
      (
        (await (
          await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 2 })
        ).json()) as { valid: boolean }
      ).valid
    ).toBe(true);
    // a stale revision is refused rather than validated against other text
    expect(
      (await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 1 })).status
    ).toBe(409);
  });
});

describe("explicit generation to the shared Reader", () => {
  test("publishes the reading text; the coherent read, description and event see it; nothing is archived", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    const res = await generate(docId, 1);
    expect(res.status).toBe(200);
    const result = (await res.json()) as TextGenerationResult;
    expect(result).toMatchObject({ publishedSourceRev: 1 });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "text-doc.published",
        doc_id: docId,
        published_source_rev: 1,
      })
    );
    // never an annotation notification, never an archive or a current file before the Reader's own access
    expect(messages.some((m) => m.type === "annotation.changed")).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);

    const description = (await (
      await call("GET", `/api/paper/${docId}/description`)
    ).json()) as DocDescription;
    expect(description).toMatchObject({
      format: "text",
      generated: true,
      source_rev: 1,
      published_source_rev: 1,
      title: "Weak lensing",
    });

    const coherent = (await (
      await call("GET", `/api/paper/${docId}/annotations?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    expect(coherent.ir.docId).toBe(docId);
    expect(coherent.ir.source).toMatchObject({ type: "text", source_rev: 1 });
    expect(coherent.ir.sections[0]?.heading).toBe("Weak lensing");
    expect(coherent.assets).toEqual([]);
    expect(coherent.file.content_fingerprint).toBe(result.fingerprint);
    // the IR route serves the same stored text
    const ir = (await (await call("GET", `/api/paper/${docId}/ir`)).json()) as {
      source: { type: string };
    };
    expect(ir.source.type).toBe("text");
  });

  test("diagnostics refuse generation (422) and keep source and the last reading text byte for byte", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    const ir = readFileSync(irFile(docId));
    await put(docId, 1, "# T\n\n```\nunclosed\n");
    const source = readFileSync(join(docDir(docId), "text-source.json"));
    const res = await generate(docId, 2);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { diagnostics: { line: number }[] };
    expect(body.diagnostics[0]?.line).toBe(3);
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(readFileSync(join(docDir(docId), "text-source.json")).equals(source)).toBe(true);
    expect(messages.filter((m) => m.type === "text-doc.published")).toHaveLength(1);
  });

  test("a revision the caller did not save is refused, and a repeated operation id returns the same result", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    expect((await generate(docId, 0)).status).toBe(409);
    const first = await generate(docId, 1, "gen-operation-1");
    const again = await generate(docId, 1, "gen-operation-1");
    expect(await again.json()).toEqual(await first.json());
    expect(messages.filter((m) => m.type === "text-doc.published")).toHaveLength(1);
  });

  test("a source saved while generating makes the in-flight candidate stale: not published", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    afterCandidate = async () => {
      // the user keeps typing while the candidate waits to publish
      expect((await put(docId, 1, `${SOURCE}\nA late paragraph.\n`)).status).toBe(200);
    };
    const res = await generate(docId, 1);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("stale");
    expect(existsSync(irFile(docId))).toBe(false);
    // the late save is kept (the older source is never restored over it)
    expect(
      ((await (await call("GET", `/api/paper/${docId}/source`)).json()) as TextSourceDto).rev
    ).toBe(2);
    afterCandidate = null;
    expect((await generate(docId, 2)).status).toBe(200);
  });

  test("a failed publish (write error) keeps the previous reading text and reports it", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    const ir = readFileSync(irFile(docId));
    await put(docId, 1, "# Other\n\nbody\n");
    mkdirSync(`${irFile(docId)}.tmp`); // a directory where the temp file must go
    const res = await generate(docId, 2);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("publish_failed");
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    rmSync(`${irFile(docId)}.tmp`, { recursive: true });
  });

  test("an unreadable existing reading text is a system error: nothing is replaced", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    writeFileSync(irFile(docId), "{ broken");
    const res = await generate(docId, 1);
    expect(res.status).toBe(500);
    expect(readFileSync(irFile(docId), "utf8")).toBe("{ broken");
  });

  test("delete is busy while a generation runs, and a second generation of the same Doc is refused", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    let release = () => {};
    let reached = () => {};
    pause = {
      hold: new Promise<void>((r) => {
        release = r;
      }),
      reached: Promise.resolve(),
      release,
      hit: () => reached(),
    };
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    const running = generate(docId, 1);
    await waiting;
    expect((await call("DELETE", `/api/paper/${docId}`)).status).toBe(409);
    expect((await generate(docId, 1)).status).toBe(409);
    expect(existsSync(docDir(docId))).toBe(true);
    release();
    expect((await running).status).toBe(200);
  });
});

describe("annotations are protected (replacement needs a confirmation)", () => {
  async function annotate(docId: string, count = 1) {
    const url = `/api/paper/${docId}/annotations`;
    const current = (await (await call("GET", url)).json()) as AnnotationsFile;
    const res = await call("PUT", url, {
      ...current,
      annotations: Array.from({ length: count }, (_, i) => ({
        id: `a_0123abc${i}`,
        target: {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: 0,
          end: 5,
          quote: "First",
        },
        body: `note ${i}`,
        created_at: "2026-09-10T10:00:00.000Z",
        updated_at: "2026-09-10T10:00:00.000Z",
      })),
    });
    expect(res.status).toBe(200);
  }
  const archive = (docId: string) =>
    existsSync(join(annDir(docId), "archive")) ? readdirSync(join(annDir(docId), "archive")) : [];

  async function annotatedDoc() {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    await annotate(docId);
    return docId;
  }

  test("same content keeps the annotations and publishes the new revision (full IR accepted)", async () => {
    const docId = await annotatedDoc();
    const current = readFileSync(join(annDir(docId), "current.json"));
    // only whitespace between blocks changes: the annotation-addressable content is identical
    await put(docId, 1, `${SOURCE}\n\n`);
    const res = await generate(docId, 2);
    expect(res.status).toBe(200);
    expect(readFileSync(join(annDir(docId), "current.json")).equals(current)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(JSON.parse(readFileSync(irFile(docId), "utf8")).source.source_rev).toBe(2);
  });

  test("different content with annotations asks for confirmation; IR, annotations and archive are untouched", async () => {
    const docId = await annotatedDoc();
    const ir = readFileSync(irFile(docId));
    const current = readFileSync(join(annDir(docId), "current.json"));
    await put(docId, 1, "# Weak lensing\n\nA rewritten paragraph.\n");
    const res = await generate(docId, 2);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "confirmation_required",
      impact: { annotations: 1 },
    });
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(readFileSync(join(annDir(docId), "current.json")).equals(current)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(messages.filter((m) => m.type === "text-doc.published")).toHaveLength(1);
    expect(messages.some((m) => m.type === "annotation.changed" && m.cause === "invalidate")).toBe(
      false
    );
  });

  test("an annotation file that cannot be read is a system error, never a mismatch: nothing is touched", async () => {
    const docId = await annotatedDoc();
    const ir = readFileSync(irFile(docId));
    writeFileSync(join(annDir(docId), "current.json"), "{ broken");
    await put(docId, 1, "# Weak lensing\n\nA rewritten paragraph.\n");
    const res = await generate(docId, 2);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("annotations_unreadable");
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(readFileSync(join(annDir(docId), "current.json"), "utf8")).toBe("{ broken");
    expect(archive(docId)).toEqual([]);
  });

  test("different content without annotations publishes; only the annotations GET archives afterwards", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    // an empty current exists (the Reader opened the Doc and saved nothing)
    await call("GET", `/api/paper/${docId}/annotations`);
    await annotate(docId, 0);
    await put(docId, 1, "# Weak lensing\n\nA rewritten paragraph.\n");
    expect((await generate(docId, 2)).status).toBe(200);
    expect(archive(docId)).toEqual([]); // the generator never archives
    expect(messages.some((m) => m.type === "annotation.changed" && m.cause === "invalidate")).toBe(
      false
    );
    await call("GET", `/api/paper/${docId}/annotations`);
    expect(archive(docId)).toHaveLength(1); // the access path does
  });
});

describe("deletion, Work links and the source PDF", () => {
  test("global delete removes source, reading text, annotations and every Work link", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    await call("GET", `/api/paper/${docId}/annotations`);
    const store = LibraryStore.load(paths);
    const other = store.works.find((w) => w.id !== KNOWN_WORK_ID);
    if (other) other.doc_ids = [...other.doc_ids, docId];
    store.save(paths);
    const res = await call("DELETE", `/api/paper/${docId}`);
    expect(res.status).toBe(200);
    expect(existsSync(docDir(docId))).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);
    for (const w of LibraryStore.load(paths).works) expect(w.doc_ids).not.toContain(docId);
  });

  test("deleting the source PDF does not cascade; the text Doc stays usable and keeps its relation", async () => {
    const pdf = publishPdfDoc(paths, {
      docId: "pdf-12345678-1234-4234-8234-123456789abc",
      workId: KNOWN_WORK_ID,
      filename: "paper.pdf",
      bytes: Buffer.from("%PDF-1.4 synthetic"),
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    const res = await call("POST", "/api/library/text-docs", {
      workId: KNOWN_WORK_ID,
      sourcePdfDocId: pdf.doc_id,
      operationId: "op-withpdf-0001",
    });
    expect(res.status).toBe(201);
    const docId = ((await res.json()) as { description: DocDescription }).description.doc_id;
    const description = (await (
      await call("GET", `/api/paper/${docId}/description`)
    ).json()) as Extract<DocDescription, { format: "text" }>;
    expect(description.source_pdf).toEqual({ doc_id: pdf.doc_id, sha256: pdf.sha256 });
    await put(docId, 0, SOURCE);
    expect((await call("DELETE", `/api/paper/${pdf.doc_id}`)).status).toBe(200);
    expect(existsSync(join(docDir(docId), "text-source.json"))).toBe(true);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toContain(docId);
    expect((await generate(docId, 1)).status).toBe(200);
    // the relation is still readable; the PDF it names is gone (the page shows it as missing)
    expect((await call("GET", `/api/paper/${pdf.doc_id}/description`)).status).toBe(404);
  });
});

describe("mixed library keeps the old paths", () => {
  test("LaTeX Docs still describe and list beside text Docs", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    const papers = ((await (await call("GET", "/api/papers")).json()) as { papers: string[] })
      .papers;
    expect(papers).toEqual(expect.arrayContaining([docId, "arxiv-2501.17225"]));
    const latex = (await (
      await call("GET", "/api/paper/arxiv-2501.17225/description")
    ).json()) as DocDescription;
    expect(latex.format).toBe("latex");
  });
});
