/**
 * The document-annotations REST endpoints (Stage 8 MS2):
 * `GET /api/paper/:doc_id/annotations` (access-path invalidation trigger:
 * ensure → 404/500 mapping → `invalidate` broadcast only after the new epoch
 * exists) and `PUT` (fingerprint+rev double check → 409 "document changed"
 * with the fresh file / 409 "rev mismatch" with the current rev; 500, never
 * 409, on fingerprint/corruption failures; annotationLock-serialized;
 * `annotation.changed` broadcasts). Hermetic: tmp data dirs, Hono
 * `app.request` (no socket). CSRF coverage lives in api.test.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, AnnotationsFile, TexDocIr } from "@argelanderspace/contracts";
import { annotationsArchiveDir, annotationsCurrentPath, libraryPaths } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const DOC = "paper-a";

let dataDir: string;
let app: Hono;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

/** A minimal valid stored TexDocIr (no assets) whose addressable content is
 *  one paragraph — `paragraphText` is the knob for re-ingest simulation. */
function mkIr(paragraphText = "Hello world"): TexDocIr {
  return {
    version: 1,
    docId: DOC,
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text: paragraphText }] },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
    meta: { title: "Paper A" },
  };
}

/** Write the stored IR to `<dataDir>/output/<DOC>/<DOC>.json`. */
function writeDoc(ir: unknown): void {
  const dir = join(dataDir, "output", DOC);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${DOC}.json`), typeof ir === "string" ? ir : JSON.stringify(ir));
}

beforeEach(() => {
  dataDir = makeDataDir();
  writeDoc(mkIr());
  const runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
  });
});

const get = async (path: string): Promise<Response> => app.request(path);
const put = async (path: string, body?: unknown): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ANNOTATION: Annotation = {
  id: "a_0123abcd",
  target: {
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: 0,
    end: 5,
    quote: "Hello",
  },
  body: "一条标注",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};

/** The current file as the server sees it (via a GET — learns the fingerprint). */
async function currentFile(): Promise<AnnotationsFile> {
  const res = await get(`/api/paper/${DOC}/annotations`);
  expect(res.status).toBe(200);
  return (await res.json()) as AnnotationsFile;
}

/** A valid PUT body against the current epoch. */
function bodyFor(current: AnnotationsFile, annotations: Annotation[] = [ANNOTATION]) {
  return {
    version: 1 as const,
    rev: current.rev,
    content_fingerprint: current.content_fingerprint,
    annotations,
  };
}

const annotationEvents = () => messages.filter((m) => m.type === "annotation.changed");

describe("GET /api/paper/:doc_id/annotations", () => {
  test("missing doc → 404", async () => {
    const res = await get("/api/paper/nope/annotations");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toContain("not found");
  });

  test("traversal-ish doc id → 400", async () => {
    for (const bad of [".hidden", "a%2Fb", "a%5Cb"]) {
      const res = await get(`/api/paper/${bad}/annotations`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "bad doc id" });
    }
  });

  test("corrupt IR → 500 (never touches annotations)", async () => {
    writeDoc("{ not json");
    const res = await get(`/api/paper/${DOC}/annotations`);
    expect(res.status).toBe(500);
    expect(existsSync(annotationsCurrentPath(dataDir, DOC))).toBe(false);
  });

  test("pre-migration IR (no version marker) → 500", async () => {
    // makeDataDir's `demo` doc is a pre-Stage-5 Document JSON
    const res = await get("/api/paper/demo/annotations");
    expect(res.status).toBe(500);
  });

  test("happy path: the ephemeral empty file for a doc without annotations, NOT persisted", async () => {
    const file = await currentFile();
    expect(file.version).toBe(1);
    expect(file.rev).toBe(0);
    expect(file.content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(file.annotations).toEqual([]);
    expect(existsSync(annotationsCurrentPath(dataDir, DOC))).toBe(false);
    expect(messages).toHaveLength(0); // no invalidation, no broadcast
  });

  test("corrupt current.json → 500 (never a silent reset)", async () => {
    const cur = await currentFile();
    await put(`/api/paper/${DOC}/annotations`, bodyFor(cur)); // persist a real current
    writeFileSync(annotationsCurrentPath(dataDir, DOC), "{ broken");
    const res = await get(`/api/paper/${DOC}/annotations`);
    expect(res.status).toBe(500);
    expect(readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8")).toBe("{ broken");
  });

  test("content change → old current archived, new empty epoch returned, invalidate broadcast", async () => {
    const cur = await currentFile();
    const putRes = await put(`/api/paper/${DOC}/annotations`, bodyFor(cur));
    expect(putRes.status).toBe(200);
    const oldFp = cur.content_fingerprint;

    writeDoc(mkIr("Hello WORLD")); // re-ingest simulation: addressable content changed
    const res = await get(`/api/paper/${DOC}/annotations`);
    expect(res.status).toBe(200);
    const next = (await res.json()) as AnnotationsFile;
    expect(next.rev).toBe(0); // a new epoch restarts rev
    expect(next.annotations).toEqual([]);
    expect(next.content_fingerprint).not.toBe(oldFp);

    // the old current (with the user's annotation) sits in archive/, once
    const archives = readdirSync(annotationsArchiveDir(dataDir, DOC));
    expect(archives).toHaveLength(1);
    const archived = JSON.parse(
      readFileSync(join(annotationsArchiveDir(dataDir, DOC), archives[0] as string), "utf8")
    ) as AnnotationsFile;
    expect(archived.annotations).toEqual([ANNOTATION]);
    expect(archived.rev).toBe(1);

    const events = annotationEvents();
    expect(events).toHaveLength(2); // put, then invalidate
    expect(events[1]).toMatchObject({
      type: "annotation.changed",
      doc_id: DOC,
      cause: "invalidate",
    });
  });
});

describe("PUT /api/paper/:doc_id/annotations", () => {
  test("valid body → 200 with rev+1, persisted, annotation.changed(put) broadcast", async () => {
    const cur = await currentFile();
    const res = await put(`/api/paper/${DOC}/annotations`, bodyFor(cur));
    expect(res.status).toBe(200);
    const saved = (await res.json()) as AnnotationsFile;
    expect(saved.rev).toBe(1);
    expect(saved.annotations).toEqual([ANNOTATION]);
    // disk carries exactly the returned document
    expect(JSON.parse(readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8"))).toEqual(saved);
    const events = annotationEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "annotation.changed", doc_id: DOC, cause: "put" });
    // a follow-up GET reflects it (and does not broadcast)
    expect(await currentFile()).toEqual(saved);
    expect(annotationEvents()).toHaveLength(1);
  });

  test("missing doc → 404", async () => {
    const res = await put("/api/paper/nope/annotations", {
      version: 1,
      rev: 0,
      content_fingerprint: "f".repeat(64),
      annotations: [],
    });
    expect(res.status).toBe(404);
  });

  test("schema-invalid / non-JSON body → 400; nothing written, no broadcast", async () => {
    const res = await put(`/api/paper/${DOC}/annotations`, { version: 2, rev: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "request body is not a valid annotations document",
    });
    const res2 = await put(`/api/paper/${DOC}/annotations`, "{ not json");
    expect(res2.status).toBe(400);
    expect(existsSync(annotationsCurrentPath(dataDir, DOC))).toBe(false);
    expect(messages).toHaveLength(0);
  });

  test("rev mismatch → 409 carrying the current rev; nothing written, no broadcast", async () => {
    const cur = await currentFile();
    expect((await put(`/api/paper/${DOC}/annotations`, bodyFor(cur))).status).toBe(200);
    const stale = await put(`/api/paper/${DOC}/annotations`, {
      ...bodyFor(cur, []),
      rev: 0, // persisted rev is 1 now
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ detail: "rev mismatch", rev: 1 });
    expect(
      (JSON.parse(readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8")) as AnnotationsFile)
        .rev
    ).toBe(1);
    expect(annotationEvents()).toHaveLength(1); // only the first PUT's "put"
  });

  test("document changed → 409 'document changed' with the fresh file; old payload rejected; archived + invalidate", async () => {
    const cur = await currentFile();
    expect((await put(`/api/paper/${DOC}/annotations`, bodyFor(cur))).status).toBe(200);

    writeDoc(mkIr("Replacement text")); // the doc was re-ingested under us
    const res = await put(`/api/paper/${DOC}/annotations`, bodyFor(cur)); // stale fingerprint
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string; file: AnnotationsFile };
    expect(body.detail).toBe("document changed");
    expect(body.file.rev).toBe(0);
    expect(body.file.annotations).toEqual([]);
    expect(body.file.content_fingerprint).not.toBe(cur.content_fingerprint);

    // the stale payload did NOT land; the archive holds the old epoch
    expect(await currentFile()).toEqual(body.file);
    expect(readdirSync(annotationsArchiveDir(dataDir, DOC))).toHaveLength(1);
    const events = annotationEvents();
    expect(events.map((e) => (e as { cause?: string }).cause)).toEqual(["put", "invalidate"]);
  });

  test("fingerprint failure (referenced asset missing) → 500, NEVER 409; store untouched", async () => {
    const cur = await currentFile();
    expect((await put(`/api/paper/${DOC}/annotations`, bodyFor(cur))).status).toBe(200);
    const before = readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8");

    const ir = mkIr();
    ir.sections[0]?.blocks.push({ id: "fig-1", type: "figure", imgPath: "gone.svg" });
    writeDoc(ir);
    const res = await put(`/api/paper/${DOC}/annotations`, bodyFor(cur));
    expect(res.status).toBe(500);
    expect(readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8")).toBe(before);
    expect(existsSync(annotationsArchiveDir(dataDir, DOC))).toBe(false);
    expect(annotationEvents()).toHaveLength(1); // no invalidate on failure
  });

  test("annotationLock serializes concurrent PUTs: exactly one wins the rev race", async () => {
    const cur = await currentFile();
    const [a, b] = await Promise.all([
      put(`/api/paper/${DOC}/annotations`, bodyFor(cur)),
      put(`/api/paper/${DOC}/annotations`, bodyFor(cur)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(
      (JSON.parse(readFileSync(annotationsCurrentPath(dataDir, DOC), "utf8")) as AnnotationsFile)
        .rev
    ).toBe(1); // a single bump, never two
    expect(annotationEvents()).toHaveLength(1);
  });
});
