/**
 * Text Doc figures, image assets and tables (copilot ticket 27) through the real seam: `createApp` + temp dataDir +
 * HTTP. Assets are uploaded as raw bytes; the generated IR, the coherent Reader read and the image route are read back.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnnotationsFile,
  buildStructureTarget,
  type CoherentAnnotationsRead,
  type TextAssetAdded,
  type TextDocIr,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
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

// ---- tiny synthetic images -------------------------------------------------------------------------------------------
function png(width = 4, height = 3, extra = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
    Buffer.alloc(extra, 7),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let dataDir: string;
let app: Hono;
let messages: WsServerMessage[];
let registry: DocMutationRegistry;

beforeEach(() => {
  dataDir = makeDataDir();
  const collector = collectBroadcasts();
  messages = collector.messages;
  registry = new DocMutationRegistry();
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    docMutations: registry,
  });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function createDoc(): Promise<string> {
  const res = await call("POST", "/api/library/text-docs", {
    workId: KNOWN_WORK_ID,
    operationId: `op-fig-${Math.random().toString(16).slice(2)}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: { doc_id: string } }).description.doc_id;
}
const put = (docId: string, expectedRev: number, markdown: string) =>
  call("PUT", `/api/paper/${docId}/source`, { expectedRev, markdown });
const generate = (docId: string, sourceRev: number) =>
  call("POST", `/api/paper/${docId}/source/generate`, {
    sourceRev,
    operationId: `gen-${Math.random().toString(16).slice(2)}`,
  });
const upload = (
  docId: string,
  expectedRev: number,
  bytes: Buffer | Uint8Array,
  filename: string | null = "figure.png",
  headers: Record<string, string> = {}
) =>
  app.request(
    `/api/paper/${docId}/source/assets?expectedRev=${expectedRev}${filename === null ? "" : `&filename=${encodeURIComponent(filename)}`}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: bytes,
    }
  );
const docDir = (docId: string) => join(dataDir, "output", docId);
const irFile = (docId: string) => join(docDir(docId), `${docId}.json`);
const sourceFile = (docId: string) => join(docDir(docId), "text-source.json");
const annDir = (docId: string) => join(dataDir, "annotations", docId);
async function add(docId: string, rev: number, bytes: Buffer, filename = "figure.png") {
  const res = await upload(docId, rev, bytes, filename);
  expect(res.status).toBe(201);
  return (await res.json()) as TextAssetAdded;
}

const F = "```";
const TABLE_JSON = JSON.stringify({
  rows: [
    [
      { text: "Estimator", header: true, rowspan: 2 },
      { text: "Uncertainty $\\sigma$", header: true, colspan: 2 },
    ],
    [
      { text: "Stat", header: true },
      { text: "Syst", header: true },
    ],
    [{ text: "Full" }, { text: "0.31" }, { text: "0.12" }],
  ],
});
function markdownFor(image: string): string {
  return [
    "# Results",
    "",
    "See [ref: fig-profile | Figure 1], [ref: tab-gfm | Table 1] and [ref: tab-merged | Table 2].",
    "",
    `${F}argelander-block`,
    JSON.stringify({
      id: "fig-profile",
      number: "1",
      label: "Figure 1",
      caption: "Shear $\\gamma_t$ profile.",
      footnote: "Synthetic data.",
    }),
    F,
    `![Shear profile](assets/${image})`,
    "",
    `${F}argelander-block`,
    JSON.stringify({
      id: "tab-gfm",
      number: "1",
      label: "Table 1",
      caption: "Masses.",
      footnote: "In $10^{14} M_\\odot$.",
    }),
    F,
    "| Estimator | Mass |",
    "| --- | ---: |",
    "| Full | $4.82$ |",
    "| Point | $5.09$ |",
    "",
    `${F}argelander-block`,
    JSON.stringify({ id: "tab-merged", number: "2", label: "Table 2", caption: "Uncertainty." }),
    F,
    `${F}argelander-table`,
    TABLE_JSON,
    F,
    "",
  ].join("\n");
}

describe("uploading an image", () => {
  test("stores bytes under a controlled new name, bumps rev once, announces text-source.changed and serves it safely", async () => {
    const docId = await createDoc();
    const bytes = png(40, 30);
    const added = await add(docId, 0, bytes, "Shear Profile.png");
    expect(added.reused).toBe(false);
    expect(added.asset).toMatchObject({
      name: `Shear-Profile-${sha(bytes).slice(0, 8)}.png`,
      sha256: sha(bytes),
      byte_length: bytes.length,
      media_type: "image/png",
      width: 40,
      height: 30,
    });
    expect(added.source.rev).toBe(1);
    expect(added.source.assets).toEqual([added.asset]);
    expect(readFileSync(join(docDir(docId), "assets", added.asset.name))).toEqual(bytes);
    expect(messages.filter((m) => m.type === "text-source.changed")).toHaveLength(1);
    const served = await app.request(`/images/${docId}/${added.asset.name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes);
    // the same bytes again: nothing new
    const again = await upload(docId, 1, bytes, "another.png");
    expect(again.status).toBe(200);
    expect(((await again.json()) as TextAssetAdded).reused).toBe(true);
    expect(readdirSync(join(docDir(docId), "assets"))).toHaveLength(1);
  });

  test.each([
    [
      "an SVG that runs a script",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'
      ),
      "image.svg",
      415,
      "unsupported_type",
    ],
    [
      "HTML named .png",
      Buffer.from("<html><script>1</script></html>"),
      "x.png",
      415,
      "unsupported_type",
    ],
    ["a truncated PNG", png().subarray(0, 25), "x.png", 422, "corrupt_image"],
    ["an enormous image by header", png(50000, 50000), "x.png", 422, "too_many_pixels"],
    ["an empty body", Buffer.alloc(0), "x.png", 400, "empty"],
  ])("refuses %s and writes nothing", async (_name, bytes, filename, status, code) => {
    const docId = await createDoc();
    const before = readFileSync(sourceFile(docId));
    const res = await upload(docId, 0, bytes, filename);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(readFileSync(sourceFile(docId)).equals(before)).toBe(true);
    expect(
      existsSync(join(docDir(docId), "assets")) ? readdirSync(join(docDir(docId), "assets")) : []
    ).toEqual([]);
    expect(messages.filter((m) => m.type === "text-source.changed")).toHaveLength(0);
  });

  test("more than 20 MiB is refused (declared, and streamed without a declared length)", async () => {
    const docId = await createDoc();
    const big = png(4, 3, 20 * 1024 * 1024 + 10);
    expect((await upload(docId, 0, big)).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12 * 1024 * 1024));
        controller.enqueue(new Uint8Array(12 * 1024 * 1024));
        // never closed: only a reader that stops at the limit answers at all
      },
    });
    const res = await app.request(`/api/paper/${docId}/source/assets?expectedRev=0`, {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(existsSync(join(docDir(docId), "assets"))).toBe(false);
  });

  test.each(["../../escape.png", "a/b.png", "a\\b.png", ".hidden.png", "/etc/passwd", "..png"])(
    "a path-like file name %j is refused, nothing escapes the Doc",
    async (name) => {
      const docId = await createDoc();
      const res = await upload(docId, 0, png(), name);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_name" });
      expect(existsSync(join(dataDir, "escape.png"))).toBe(false);
    }
  );

  test("stale rev is a conflict with the stored source; a missing or bad expectedRev is 400; unknown Doc is 404; cross-site is 403", async () => {
    const docId = await createDoc();
    await put(docId, 0, "x");
    const stale = await upload(docId, 0, png());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ detail: "rev mismatch", rev: 1 });
    expect(
      (
        await app.request(`/api/paper/${docId}/source/assets`, {
          method: "POST",
          body: png(),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await app.request(`/api/paper/${docId}/source/assets?expectedRev=-1`, {
          method: "POST",
          body: png(),
        })
      ).status
    ).toBe(400);
    expect((await upload("text-00000000-0000-0000-0000-000000000000", 0, png())).status).toBe(404);
    expect((await upload(docId, 1, png(), "a.png", { Origin: "http://evil.example" })).status).toBe(
      403
    );
    expect(readdirSync(join(docDir(docId))).includes("assets")).toBe(false);
  });

  test("a symlinked assets directory is not followed", async () => {
    const docId = await createDoc();
    const { symlinkSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(docDir(docId), "assets"));
    const res = await upload(docId, 0, png());
    expect(res.status).toBe(500);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("while a delete of the Doc is running an upload is refused and writes nothing; afterwards it works again", async () => {
    const docId = await createDoc();
    const before = readFileSync(sourceFile(docId));
    expect(registry.tryBeginDelete(docId)).toBe(true);
    const refused = await upload(docId, 0, png());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ detail: "document busy" });
    expect(readFileSync(sourceFile(docId)).equals(before)).toBe(true);
    expect(existsSync(join(docDir(docId), "assets"))).toBe(false);
    registry.endDelete(docId);
    expect((await upload(docId, 0, png())).status).toBe(201);
  });

  test("a delete removes every asset with the Doc, and a later upload finds no Doc", async () => {
    const docId = await createDoc();
    await add(docId, 0, png());
    expect((await call("DELETE", `/api/paper/${docId}`)).status).toBe(200);
    expect(existsSync(docDir(docId))).toBe(false);
    expect((await upload(docId, 1, png(5, 5))).status).toBe(404);
  });

  test("L2: uploading registered bytes whose file vanished restores the file and says so; the revision does not change", async () => {
    const docId = await createDoc();
    const bytes = png(40, 30);
    const a = await add(docId, 0, bytes);
    const file = join(docDir(docId), "assets", a.asset.name);
    rmSync(file);
    const res = await upload(docId, 1, bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TextAssetAdded;
    expect(body).toMatchObject({ reused: true, restored: true });
    expect(body.source.rev).toBe(1);
    expect(readFileSync(file)).toEqual(bytes);
  });
});

describe("figures and tables to the Reader", () => {
  async function generatedDoc() {
    const docId = await createDoc();
    const a = await add(docId, 0, png(40, 30));
    expect((await put(docId, 1, markdownFor(a.asset.name))).status).toBe(200);
    const res = await generate(docId, 2);
    return { docId, asset: a.asset, res };
  }

  test("validate then generate: figure with caption/footnote/number/label, GFM and merged tables, refs and the coherent read", async () => {
    const docId = await createDoc();
    const a = await add(docId, 0, png(40, 30));
    await put(docId, 1, markdownFor(a.asset.name));
    const before = readFileSync(sourceFile(docId));
    const v = await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 2 });
    const validation = (await v.json()) as {
      valid: boolean;
      diagnostics: unknown[];
      stats: Record<string, number>;
    };
    expect(validation.valid).toBe(true);
    expect(validation.stats).toMatchObject({ figures: 1, tables: 2 });
    // the right-aligned column is the only thing that is not kept, and it is said
    expect(validation.diagnostics).toMatchObject([
      { code: "table_align_ignored", severity: "warning", line: 13 },
    ]);
    expect(readFileSync(sourceFile(docId)).equals(before)).toBe(true);
    expect(existsSync(irFile(docId))).toBe(false);
    const res = await generate(docId, 2);
    expect(res.status).toBe(200);
    const ir = JSON.parse(readFileSync(irFile(docId), "utf8")) as TextDocIr;
    const blocks = ir.sections.flatMap((s) => s.blocks);
    const fig = blocks.find((b) => b.type === "figure");
    expect(fig).toMatchObject({
      id: "fig-profile",
      number: "1",
      label: "Figure 1",
      footnote: "Synthetic data.",
      imgPath: a.asset.name,
      imgWidth: 40,
      imgHeight: 30,
    });
    const gfm = blocks.find((b) => b.id === "tab-gfm");
    expect(gfm?.type === "table" && gfm.tableBody).toBe(
      "<table><tr><th>Estimator</th><th>Mass</th></tr><tr><td>Full</td><td>$4.82$</td></tr><tr><td>Point</td><td>$5.09$</td></tr></table>"
    );
    const merged = blocks.find((b) => b.id === "tab-merged");
    expect(merged?.type === "table" && merged.tableBody).toBe(
      '<table><tr><th rowspan="2">Estimator</th><th colspan="2">Uncertainty $\\sigma$</th></tr><tr><th>Stat</th><th>Syst</th></tr><tr><td>Full</td><td>0.31</td><td>0.12</td></tr></table>'
    );
    expect(ir.refsManifest.map((r) => [r.id, r.kind, r.number])).toEqual([
      ["sec-1", "section", undefined],
      ["fig-profile", "figure", "1"],
      ["tab-gfm", "table", "1"],
      ["tab-merged", "table", "2"],
    ]);
    // the Reader's shared coherent read: the IR, the annotation epoch, and the asset manifest with the image's hash
    const coherent = (await (
      await call("GET", `/api/paper/${docId}/annotations?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    expect(coherent.assets).toEqual([{ imgPath: a.asset.name, sha256: a.asset.sha256 }]);
    const verified = await app.request(`/images/${docId}/${a.asset.name}?sha256=${a.asset.sha256}`);
    expect(verified.status).toBe(200);
    expect(verified.headers.get("x-content-type-options")).toBe("nosniff");
    expect(messages.some((m) => m.type === "text-doc.published")).toBe(true);
    expect(messages.some((m) => m.type === "annotation.changed")).toBe(false);
  });

  test("a figure naming a missing asset blocks generation with a located diagnostic and keeps the old IR", async () => {
    const { docId, asset } = await generatedDoc();
    const ir = readFileSync(irFile(docId));
    const src = readFileSync(sourceFile(docId));
    await put(docId, 2, markdownFor("nowhere-12345678.png"));
    const res = await generate(docId, 3);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { diagnostics: { code: string; line: number }[] };
    expect(body.diagnostics.find((d) => d.code === "image_asset_missing")?.line).toBeGreaterThan(0);
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(JSON.parse(readFileSync(sourceFile(docId), "utf8")).rev).toBe(3);
    expect(JSON.parse(src.toString()).markdown).toContain(asset.name); // the previous source revision text was replaced by the user's text, never lost
    expect(JSON.parse(readFileSync(sourceFile(docId), "utf8")).markdown).toContain(
      "nowhere-12345678.png"
    );
  });

  test.each([
    [
      "a bad table grid",
      `${F}argelander-table\n${JSON.stringify({ rows: [[{ text: "a", colspan: 2 }], [{ text: "b" }]] })}\n${F}\n`,
    ],
    [
      "a zero rowspan",
      `${F}argelander-table\n${JSON.stringify({ rows: [[{ text: "a", rowspan: 0 }]] })}\n${F}\n`,
    ],
    ["a GFM row with too many cells", "| a | b |\n| - | - |\n| 1 | 2 | 3 |\n"],
  ])("%s blocks generation, keeps the old IR and annotations bytes", async (_name, table) => {
    const { docId } = await generatedDoc();
    const ir = readFileSync(irFile(docId));
    await put(docId, 2, `# Results\n\n${table}`);
    const res = await generate(docId, 3);
    expect(res.status).toBe(422);
    expect(
      ((await res.json()) as { diagnostics: { line?: number }[] }).diagnostics[0]?.line
    ).toBeGreaterThan(0);
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
  });

  test("an updated image is a NEW asset name: the published IR keeps its old image bytes until regenerated; unreferenced assets are kept", async () => {
    const { docId, asset: first } = await generatedDoc();
    const firstBytes = readFileSync(join(docDir(docId), "assets", first.name));
    const second = await add(docId, 2, png(60, 40)); // rev after the asset and the text is 2
    expect(second.asset.name).not.toBe(first.name);
    // the reading text still points to the first image and its bytes are untouched
    const published = JSON.parse(readFileSync(irFile(docId), "utf8")) as TextDocIr;
    expect(JSON.stringify(published.sections)).toContain(first.name);
    expect(JSON.stringify(published.sections)).not.toContain(second.asset.name);
    expect(readFileSync(join(docDir(docId), "assets", first.name)).equals(firstBytes)).toBe(true);
    // regenerating with the new image changes the fingerprint (it covers the image bytes)
    const fp1 = published.source.source_fingerprint;
    await put(docId, second.source.rev, markdownFor(second.asset.name));
    expect((await generate(docId, second.source.rev + 1)).status).toBe(200);
    const next = JSON.parse(readFileSync(irFile(docId), "utf8")) as TextDocIr;
    expect(next.source.source_fingerprint).not.toBe(fp1);
    // the old image is still on disk (no GC) even though nothing references it now
    expect(existsSync(join(docDir(docId), "assets", first.name))).toBe(true);
    expect(readdirSync(join(docDir(docId), "assets")).sort()).toEqual(
      [first.name, second.asset.name].sort()
    );
  });

  test("a registered asset whose file was changed or removed stops the generation: nothing published", async () => {
    const docId = await createDoc();
    const a = await add(docId, 0, png(40, 30));
    await put(docId, 1, markdownFor(a.asset.name));
    const file = join(docDir(docId), "assets", a.asset.name);
    chmodSync(file, 0o644);
    writeFileSync(file, png(9, 9));
    const res = await generate(docId, 2);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "asset_unreadable" });
    expect(existsSync(irFile(docId))).toBe(false);
  });

  test("with annotations, replacing the reading text because the image changed is refused (28 adds the confirmation); bytes stay", async () => {
    const { docId, asset } = await generatedDoc();
    const url = `/api/paper/${docId}/annotations`;
    const current = (await (await call("GET", url)).json()) as AnnotationsFile;
    const put1 = await call("PUT", url, {
      ...current,
      annotations: [
        {
          id: "a_0123abc0",
          target: buildStructureTarget(
            (JSON.parse(readFileSync(irFile(docId), "utf8")) as TextDocIr).sections
              .flatMap((sec) => sec.blocks)
              .find((b) => b.id === "fig-profile") as never
          ),
          body: "check the axes",
          created_at: "2026-09-10T10:00:00.000Z",
          updated_at: "2026-09-10T10:00:00.000Z",
        },
      ],
    });
    expect(put1.status).toBe(200);
    const ir = readFileSync(irFile(docId));
    const ann = readFileSync(join(annDir(docId), "current.json"));
    const second = await add(docId, 2, png(70, 50));
    await put(docId, second.source.rev, markdownFor(second.asset.name));
    const res = await generate(docId, second.source.rev + 1);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "replacement_blocked", annotations: 1 });
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(readFileSync(join(annDir(docId), "current.json")).equals(ann)).toBe(true);
    expect(existsSync(join(annDir(docId), "archive"))).toBe(false);
    expect(asset.name).toBeTruthy();
  });
});
