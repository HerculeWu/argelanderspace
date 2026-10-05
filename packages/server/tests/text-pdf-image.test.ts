/**
 * Adding an image from the source PDF (copilot ticket 29) on the real seam: `createApp`, a temp dataDir, real HTTP, a
 * real PDF rendered by the real PDFium in Node (the synthetic PDF has text, a raw bitmap, a rotated and an odd-sized
 * page). The PDF is never changed, the picture goes through the ticket 27 asset path, and nothing about the page or
 * the region is stored.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocDescription, TextAssetAdded } from "@argelanderspace/contracts";
import { libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { cropRgba } from "../src/pdf-material.js";
import { probePdf } from "../src/pdfium-probe.js";
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
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collectBroadcasts().broadcast,
    docMutations: new DocMutationRegistry(),
  });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function publish(workId = KNOWN_WORK_ID) {
  const bytes = syntheticPdf({ pageCount: 3 });
  const probed = await probePdf(bytes);
  const meta = publishPdfDoc(paths, { workId, filename: "s.pdf", bytes, pages: probed.pages });
  return { docId: meta.doc_id, sha: meta.sha256, bytes };
}
let n = 0;
async function textDoc(sourcePdfDocId?: string): Promise<string> {
  const res = await call("POST", "/api/library/text-docs", {
    workId: KNOWN_WORK_ID,
    ...(sourcePdfDocId ? { sourcePdfDocId } : {}),
    operationId: `op-pdfimg-${++n}-${Math.random().toString(16).slice(2)}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: DocDescription }).description.doc_id;
}
const add = (docId: string, body: object) =>
  call("POST", `/api/paper/${docId}/source/assets/from-pdf`, body);
const png = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const assetBytes = (docId: string, name: string) =>
  readFileSync(join(dataDir, "output", docId, "assets", name));

describe("add image from the source PDF", () => {
  test("a whole page and a region become independent assets; the PDF and its metadata are byte-identical", async () => {
    const pdf = await publish();
    const docId = await textDoc(pdf.docId);
    const pdfDir = join(dataDir, "output", pdf.docId);
    const before = Object.fromEntries(
      readdirSync(pdfDir).map((f) => [f, readFileSync(join(pdfDir, f)).toString("base64")])
    );
    const whole = await add(docId, {
      expectedRev: 0,
      sha256: pdf.sha,
      pageIndex: 0,
      longEdge: 800,
    });
    expect(whole.status).toBe(201);
    const a = (await whole.json()) as TextAssetAdded;
    expect(a.asset.media_type).toBe("image/png");
    expect(a.asset.name).toMatch(/^p1-[0-9a-f]{8}\.png$/);
    expect(a.source.rev).toBe(1);
    const wholePng = png(assetBytes(docId, a.asset.name));
    expect(Math.max(wholePng.w, wholePng.h)).toBeLessThanOrEqual(801);
    expect(wholePng).toEqual({ w: a.asset.width, h: a.asset.height });
    const region = await add(docId, {
      expectedRev: 1,
      sha256: pdf.sha,
      pageIndex: 0,
      region: { x: 0.1, y: 0.5, width: 0.5, height: 0.25 },
      longEdge: 800,
    });
    expect(region.status).toBe(201);
    const r = (await region.json()) as TextAssetAdded;
    expect(r.asset.name).toMatch(/^p1-region-[0-9a-f]{8}\.png$/);
    // the region's longer edge is the asked size, and its shape is the region's (0.5 x 360 : 0.25 x 480 = 180 : 120)
    const dims = png(assetBytes(docId, r.asset.name));
    expect(Math.max(dims.w, dims.h)).toBeGreaterThanOrEqual(790);
    expect(dims.w / dims.h).toBeCloseTo(180 / 120, 1);
    // the stored hash is the file's, and the file is a real image the Reader's asset checks accept
    expect(r.asset.sha256).toBe(sha(assetBytes(docId, r.asset.name)));
    // nothing about page or region is stored; the PDF files are untouched
    const stored = readFileSync(join(dataDir, "output", docId, "text-source.json"), "utf8");
    expect(stored).not.toContain("pageIndex");
    expect(stored).not.toContain('"region"');
    for (const [file, b64] of Object.entries(before))
      expect(readFileSync(join(pdfDir, file)).toString("base64")).toBe(b64);
  });

  test("a rotated page and an odd-sized page render; the region is of the VISIBLE page", async () => {
    const pdf = await publish();
    const docId = await textDoc(pdf.docId);
    // page 1 is 400x240 rotated by 90: visible 240 wide, 400 high
    const res = await add(docId, { expectedRev: 0, sha256: pdf.sha, pageIndex: 1, longEdge: 400 });
    expect(res.status).toBe(201);
    const a = (await res.json()) as TextAssetAdded;
    expect((a.asset.height ?? 0) > (a.asset.width ?? 0)).toBe(true);
    const odd = await add(docId, { expectedRev: 1, sha256: pdf.sha, pageIndex: 2, longEdge: 300 });
    expect(odd.status).toBe(201);
  });

  test("refusals write nothing: stale rev, wrong original, bad page, bad region, foreign or non-PDF Doc, no source PDF", async () => {
    const pdf = await publish();
    const docId = await textDoc(pdf.docId);
    const state = () => readFileSync(join(dataDir, "output", docId, "text-source.json"), "utf8");
    const before = state();
    const ok = { expectedRev: 0, sha256: pdf.sha, pageIndex: 0, longEdge: 300 };
    const stale = await add(docId, { ...ok, expectedRev: 5 });
    expect(stale.status).toBe(409);
    expect((await add(docId, { ...ok, sha256: "0".repeat(64) })).status).toBe(409);
    expect((await add(docId, { ...ok, pageIndex: 99 })).status).toBe(400);
    expect(
      (await add(docId, { ...ok, region: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } })).status
    ).toBe(400);
    expect(
      (await add(docId, { ...ok, region: { x: 0, y: 0, width: 0.001, height: 0.5 } })).status
    ).toBe(400);
    expect((await add(docId, { ...ok, longEdge: 99999 })).status).toBe(400);
    expect((await add(docId, { ...ok, extra: 1 })).status).toBe(400);
    // a text Doc without a source PDF must name one; a PDF that is not in this Work is refused
    const bare = await textDoc();
    expect((await add(bare, ok)).status).toBe(400);
    const library = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
    const first = library.works[0];
    library.works.push({
      ...first,
      id: "doi:10.1000/other-work",
      doi: "10.1000/other-work",
      cite_key: "otherwork",
      doc_ids: [],
    });
    writeFileSync(paths.libraryJson, JSON.stringify(library));
    const other = await publish("doi:10.1000/other-work");
    const foreign = await add(bare, { ...ok, pdfDocId: other.docId, sha256: other.sha });
    expect(foreign.status).toBe(400);
    expect((await add(bare, { ...ok, pdfDocId: bare })).status).toBe(400);
    expect(state()).toBe(before);
    expect(readdirSync(join(dataDir, "output", docId)).includes("assets")).toBe(false);
    // a PDF of the same Work other than the source one may be named
    const second = await publish();
    const named = await add(bare, { ...ok, pdfDocId: second.docId, sha256: second.sha });
    expect(named.status).toBe(201);
  });

  test("the same page twice gives the same asset (reused), never a second file", async () => {
    const pdf = await publish();
    const docId = await textDoc(pdf.docId);
    const body = { expectedRev: 0, sha256: pdf.sha, pageIndex: 0, longEdge: 300 };
    const first = (await (await add(docId, body)).json()) as TextAssetAdded;
    const again = await add(docId, { ...body, expectedRev: 1 });
    expect(again.status).toBe(200);
    const second = (await again.json()) as TextAssetAdded;
    expect(second.reused).toBe(true);
    expect(second.asset.name).toBe(first.asset.name);
    expect(second.source.rev).toBe(1);
  });
});

describe("cropRgba", () => {
  test("cuts the asked pixels, never empty and never outside", () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set([i, 0, 0, 255], i * 4);
    const out = cropRgba(
      { width: 4, height: 4, data },
      { x: 0.25, y: 0.5, width: 0.5, height: 0.5 }
    );
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect([...out.data].filter((_, i) => i % 4 === 0)).toEqual([9, 10, 13, 14]);
    const tiny = cropRgba(
      { width: 4, height: 4, data },
      { x: 0.99, y: 0.99, width: 0.006, height: 0.006 }
    );
    expect([tiny.width, tiny.height]).toEqual([1, 1]);
  });
});
