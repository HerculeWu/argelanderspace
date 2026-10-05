/**
 * Text Doc regeneration, annotations and failure preservation (copilot ticket 28) on the real seam: `createApp` with a
 * temp dataDir, real HTTP routes, real locks and disk. Nothing in the text or annotation path is mocked; failures are
 * injected on disk (a directory where a file must go, a damaged file), and every refusal is checked by comparing the
 * original bytes of the reading text, the current annotations and the archive.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AnnotationsFile,
  CoherentAnnotationsRead,
  DocDescription,
  TextAssetAdded,
  TextGenerationResult,
  TextReplacementImpact,
  WsServerMessage,
} from "@argelanderspace/contracts";
import {
  docContentFingerprint,
  LibraryStore,
  libraryPaths,
  readPublishedTextIr,
} from "@argelanderspace/core";
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
let hook: (() => Promise<void> | void) | null;

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  const collector = collectBroadcasts();
  messages = collector.messages;
  docMutations = new DocMutationRegistry();
  hook = null;
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    docMutations,
    textDocHooks: { beforePublish: async () => void (await hook?.()) },
  });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function png(width: number, height: number): Buffer {
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
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}

let opCounter = 0;
async function createDoc(): Promise<string> {
  const res = await call("POST", "/api/library/text-docs", {
    workId: KNOWN_WORK_ID,
    operationId: `op-regen-${++opCounter}-${Math.random().toString(16).slice(2)}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: DocDescription }).description.doc_id;
}
const put = (docId: string, expectedRev: number, markdown: string) =>
  call("PUT", `/api/paper/${docId}/source`, { expectedRev, markdown });
const generate = (docId: string, sourceRev: number, confirm?: TextReplacementImpact) =>
  call("POST", `/api/paper/${docId}/source/generate`, {
    sourceRev,
    operationId: `gen-${Math.random().toString(16).slice(2)}`,
    ...(confirm ? { confirm } : {}),
  });
const docDir = (docId: string) => join(dataDir, "output", docId);
const irFile = (docId: string) => join(docDir(docId), `${docId}.json`);
const annDir = (docId: string) => join(dataDir, "annotations", docId);
const currentFile = (docId: string) => join(annDir(docId), "current.json");
const archiveDir = (docId: string) => join(annDir(docId), "archive");
const archive = (docId: string) =>
  existsSync(archiveDir(docId)) ? readdirSync(archiveDir(docId)) : [];
const annotationsUrl = (docId: string) => `/api/paper/${docId}/annotations`;

const SOURCE = "# Weak lensing\n\nFirst paragraph here.\n\n- alpha\n- beta\n";
const CHANGED = "# Weak lensing\n\nA rewritten paragraph.\n";

const annotationOf = (i: number) => ({
  id: `a_0123abc${i}`,
  target: {
    type: "text" as const,
    block: "p-1",
    container: { type: "content" as const },
    start: 0,
    end: 5,
    quote: "First",
  },
  body: `note ${i}`,
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
});

/** Save the Reader's annotations through the real PUT (the page's path). */
async function annotate(docId: string, count: number): Promise<AnnotationsFile> {
  const current = (await (await call("GET", annotationsUrl(docId))).json()) as AnnotationsFile;
  const res = await call("PUT", annotationsUrl(docId), {
    ...current,
    annotations: Array.from({ length: count }, (_, i) => annotationOf(i)),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AnnotationsFile;
}

/** A generated Doc (source rev 1 published) carrying `count` annotations. */
async function annotatedDoc(count = 2) {
  const docId = await createDoc();
  await put(docId, 0, SOURCE);
  expect((await generate(docId, 1)).status).toBe(200);
  const file = await annotate(docId, count);
  return { docId, file };
}

async function impactOf(res: Response): Promise<TextReplacementImpact> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { code: string; impact: TextReplacementImpact };
  expect(body.code).toBe("confirmation_required");
  return body.impact;
}

const snapshot = (docId: string) => ({
  ir: readFileSync(irFile(docId)),
  current: existsSync(currentFile(docId)) ? readFileSync(currentFile(docId)) : null,
  archive: archive(docId),
});
function expectUntouched(docId: string, before: ReturnType<typeof snapshot>) {
  const now = snapshot(docId);
  expect(now.ir.equals(before.ir)).toBe(true);
  if (before.current) expect(now.current?.equals(before.current)).toBe(true);
  else expect(now.current).toBeNull();
  expect(now.archive).toEqual(before.archive);
}
const publishedCount = () => messages.filter((m) => m.type === "text-doc.published").length;
const invalidations = () =>
  messages.filter((m) => m.type === "annotation.changed" && m.cause === "invalidate");

describe("fingerprint triage on regeneration", () => {
  test("same annotation-addressable content publishes without confirmation and keeps the annotations byte for byte", async () => {
    const { docId } = await annotatedDoc();
    const current = readFileSync(currentFile(docId));
    await put(docId, 1, `${SOURCE}\n\n`); // only blank lines change
    const res = await generate(docId, 2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as TextGenerationResult).replacedAnnotations).toBe(0);
    expect(readFileSync(currentFile(docId)).equals(current)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
    const read = (await (
      await call("GET", `${annotationsUrl(docId)}?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    expect(read.file.annotations).toHaveLength(2);
  });

  test("different content over annotations asks for confirmation and states the impact; nothing is written", async () => {
    const { docId, file } = await annotatedDoc(2);
    const before = snapshot(docId);
    const published = publishedCount();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect(impact).toMatchObject({
      sourceRev: 2,
      publishedSourceRev: 1,
      annotations: 2,
      annotationsRev: file.rev,
      oldFingerprint: file.content_fingerprint,
    });
    expect(impact.newFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(impact.newFingerprint).not.toBe(impact.oldFingerprint);
    expectUntouched(docId, before);
    expect(publishedCount()).toBe(published);
    expect(invalidations()).toHaveLength(0);
    // the Doc stays usable while the user decides: nothing is pinned, saving and reading go on
    expect(docMutations.isBusy(docId)).toBe(false);
    expect((await put(docId, 2, `${CHANGED}more\n`)).status).toBe(200);
    expect((await call("GET", annotationsUrl(docId))).status).toBe(200);
  });

  test("a confirmed replacement publishes; the generator archives nothing, the annotations GET archives once, verbatim", async () => {
    const { docId } = await annotatedDoc(2);
    const oldCurrent = readFileSync(currentFile(docId));
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(200);
    const result = (await res.json()) as TextGenerationResult;
    expect(result.publishedSourceRev).toBe(2);
    expect(result.replacedAnnotations).toBe(2);
    expect(result.fingerprint).toBe(impact.newFingerprint);
    // independent recomputation of the published fingerprint
    const ir = readPublishedTextIr(paths, docId);
    expect(ir && docContentFingerprint(ir, { docDir: docDir(docId) })).toBe(result.fingerprint);
    // the generator did not touch annotations or announce anything about them
    expect(readFileSync(currentFile(docId)).equals(oldCurrent)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
    expect(publishedCount()).toBe(2);
    // only the access path archives
    const read = (await (
      await call("GET", `${annotationsUrl(docId)}?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    expect(read.file).toMatchObject({ rev: 0, content_fingerprint: result.fingerprint });
    expect(read.file.annotations).toEqual([]);
    expect(archive(docId)).toHaveLength(1);
    expect(
      readFileSync(join(archiveDir(docId), archive(docId)[0] as string)).equals(oldCurrent)
    ).toBe(true);
    expect(invalidations()).toHaveLength(1);
  });

  test("the image route and a library refresh never archive", async () => {
    const { docId } = await annotatedDoc(1);
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect((await generate(docId, 2, impact)).status).toBe(200);
    const oldCurrent = readFileSync(currentFile(docId));
    expect((await call("POST", "/api/library/refresh?offline=1")).status).toBe(200);
    await app.request(`/images/${docId}/none.png`);
    expect(readFileSync(currentFile(docId)).equals(oldCurrent)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
  });

  test("a non-empty batch bound to an OLDER fingerprint (the earlier replacement is not archived yet) counts as 0: publishes without asking, reports 0", async () => {
    const { docId } = await annotatedDoc(2);
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect((await generate(docId, 2, impact)).status).toBe(200);
    // nothing has archived yet: current.json still holds the 2 annotations of the first text
    const staleBatch = readFileSync(currentFile(docId));
    expect((JSON.parse(staleBatch.toString()) as AnnotationsFile).annotations).toHaveLength(2);
    await put(docId, 2, `${CHANGED}\nthird text\n`);
    const res = await generate(docId, 3);
    expect(res.status).toBe(200);
    expect(((await res.json()) as TextGenerationResult).replacedAnnotations).toBe(0);
    expect(readFileSync(currentFile(docId)).equals(staleBatch)).toBe(true);
    expect(archive(docId)).toEqual([]);
  });

  test("an empty or absent batch needs no confirmation", async () => {
    const docId = await createDoc();
    await put(docId, 0, SOURCE);
    await generate(docId, 1);
    // no annotation file at all
    await put(docId, 1, CHANGED);
    expect((await generate(docId, 2)).status).toBe(200);
    // an empty current exists now
    await call("GET", annotationsUrl(docId));
    await put(docId, 2, SOURCE);
    const res = await generate(docId, 3);
    expect(res.status).toBe(200);
    expect(((await res.json()) as TextGenerationResult).replacedAnnotations).toBe(0);
  });
});

describe("the confirmation is bound and rechecked at execution", () => {
  async function pending() {
    const { docId, file } = await annotatedDoc(2);
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    return { docId, file, impact };
  }

  test("an annotation edited after the question (revision moved) invalidates the confirmation with fresh numbers", async () => {
    const { docId, impact } = await pending();
    const current = (await (await call("GET", annotationsUrl(docId))).json()) as AnnotationsFile;
    const edited = {
      ...current,
      annotations: current.annotations.map((a, i) => (i === 0 ? { ...a, body: "changed" } : a)),
    };
    expect((await call("PUT", annotationsUrl(docId), edited)).status).toBe(200);
    const before = snapshot(docId);
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; impact: TextReplacementImpact };
    expect(body.code).toBe("confirmation_changed");
    expect(body.impact.annotationsRev).toBe(impact.annotationsRev + 1);
    expect(body.impact.annotations).toBe(2);
    expectUntouched(docId, before);
    // the fresh values confirm
    expect((await generate(docId, 2, body.impact)).status).toBe(200);
  });

  test("annotations removed after the question (count moved) invalidate the confirmation", async () => {
    const { docId, impact } = await pending();
    const current = (await (await call("GET", annotationsUrl(docId))).json()) as AnnotationsFile;
    expect(
      (
        await call("PUT", annotationsUrl(docId), {
          ...current,
          annotations: current.annotations.slice(0, 1),
        })
      ).status
    ).toBe(200);
    const before = snapshot(docId);
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { impact: TextReplacementImpact }).impact.annotations).toBe(1);
    expectUntouched(docId, before);
  });

  test("all annotations removed after the question: the confirmation is still refused (confirmation_changed, no impact to show), nothing published", async () => {
    const { docId, impact } = await pending();
    const current = (await (await call("GET", annotationsUrl(docId))).json()) as AnnotationsFile;
    await call("PUT", annotationsUrl(docId), { ...current, annotations: [] });
    const before = snapshot(docId);
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; impact?: unknown };
    expect(body.code).toBe("confirmation_changed");
    expect(body.impact).toBeUndefined();
    expectUntouched(docId, before);
    // a plain request now publishes, nothing being at risk
    expect((await generate(docId, 2)).status).toBe(200);
  });

  test("a confirmation sent when nothing needed one (same content, or a first generation) is refused too", async () => {
    const { docId, impact } = await pending();
    const before = snapshot(docId);
    // the user's text goes back to what is published: the fingerprints now match
    expect((await put(docId, 2, SOURCE)).status).toBe(200);
    const res = await generate(docId, 3, { ...impact, sourceRev: 3 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("confirmation_changed");
    expectUntouched(docId, before);
    const first = await createDoc();
    await put(first, 0, SOURCE);
    expect((await generate(first, 1, { ...impact, docId: first, sourceRev: 1 })).status).toBe(409);
    expect(existsSync(irFile(first))).toBe(false);
  });

  test("a confirmation made for another Doc is refused even when everything else is identical", async () => {
    const a = await pending();
    const b = await annotatedDoc(2);
    await put(b.docId, 1, CHANGED);
    const impactB = await impactOf(await generate(b.docId, 2));
    expect({ ...impactB, docId: a.docId }).toEqual(a.impact); // identical but for the Doc: the repro
    const beforeB = snapshot(b.docId);
    const res = await generate(b.docId, 2, a.impact);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "confirmation_changed", impact: impactB });
    expectUntouched(b.docId, beforeB);
    expect((await call("GET", annotationsUrl(b.docId))).status).toBe(200);
    expect(archive(b.docId)).toEqual([]);
  });

  test("a source saved after the question makes the confirmation stale: not published", async () => {
    const { docId, impact } = await pending();
    expect((await put(docId, 2, `${CHANGED}more\n`)).status).toBe(200);
    const before = snapshot(docId);
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "stale" });
    expectUntouched(docId, before);
  });

  test("a value that is not the stated impact is refused, one by one", async () => {
    const { docId, impact } = await pending();
    const before = snapshot(docId);
    const variants: TextReplacementImpact[] = [
      { ...impact, annotations: impact.annotations + 1 },
      { ...impact, annotationsRev: impact.annotationsRev + 1 },
      { ...impact, docId: "text-00000000-0000-4000-8000-000000000000" },
      { ...impact, oldFingerprint: "0".repeat(64) },
      { ...impact, newFingerprint: "1".repeat(64) },
      { ...impact, publishedSourceRev: impact.publishedSourceRev + 1 },
      { ...impact, sourceRev: impact.sourceRev + 1 },
    ];
    for (const variant of variants) {
      const res = await generate(docId, 2, variant);
      expect(res.status).toBe(409);
      expect(["confirmation_changed", "stale"]).toContain(
        ((await res.json()) as { code: string }).code
      );
      expectUntouched(docId, before);
    }
    expect(publishedCount()).toBe(1);
  });

  test("a malformed confirmation is a 400 and writes nothing", async () => {
    const { docId, impact } = await pending();
    const before = snapshot(docId);
    const res = await call("POST", `/api/paper/${docId}/source/generate`, {
      sourceRev: 2,
      operationId: "gen-malformed-1",
      confirm: { ...impact, extra: true },
    });
    expect(res.status).toBe(400);
    expectUntouched(docId, before);
  });

  test("a change of the image bytes between the question and the click changes the new fingerprint", async () => {
    const docId = await createDoc();
    const added = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=0&filename=f.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(4, 3),
      })
    ).json()) as TextAssetAdded;
    const md = (name: string) => `# T\n\n![alt](assets/${name})\n`;
    await put(docId, added.source.rev, md(added.asset.name));
    expect((await generate(docId, added.source.rev + 1)).status).toBe(200);
    await annotate(docId, 1);
    // a second image under a new name, the text now points at it
    const second = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=2&filename=g.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(7, 5),
      })
    ).json()) as TextAssetAdded;
    await put(docId, second.source.rev, md(second.asset.name));
    const impact = await impactOf(await generate(docId, second.source.rev + 1));
    expect((await generate(docId, second.source.rev + 1, impact)).status).toBe(200);
  });
});

describe("failures keep the old reading text and the annotations byte for byte", () => {
  test("annotations (current.json) that cannot be read: 500, nothing touched, not a mismatch", async () => {
    const { docId } = await annotatedDoc();
    writeFileSync(currentFile(docId), "{ broken");
    const before = snapshot(docId);
    await put(docId, 1, CHANGED);
    const res = await generate(docId, 2);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "annotations_unreadable" });
    expectUntouched(docId, before);
    // a confirmation cannot be used to get past an unreadable store
    const forged: TextReplacementImpact = {
      docId,
      sourceRev: 2,
      publishedSourceRev: 1,
      annotations: 1,
      annotationsRev: 0,
      oldFingerprint: "a".repeat(64),
      newFingerprint: "b".repeat(64),
    };
    expect((await generate(docId, 2, forged)).status).toBe(500);
    expectUntouched(docId, before);
  });

  test("current.json of a future schema is unreadable too (never reset)", async () => {
    const { docId } = await annotatedDoc();
    const raw = JSON.parse(readFileSync(currentFile(docId), "utf8"));
    writeFileSync(currentFile(docId), JSON.stringify({ ...raw, version: 99 }));
    const before = snapshot(docId);
    await put(docId, 1, CHANGED);
    expect((await generate(docId, 2)).status).toBe(500);
    expectUntouched(docId, before);
  });

  test("the published reading text is damaged: 500, nothing replaced", async () => {
    const { docId } = await annotatedDoc();
    writeFileSync(irFile(docId), "{ broken");
    const before = snapshot(docId);
    await put(docId, 1, CHANGED);
    const res = await generate(docId, 2);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "reading_unreadable" });
    expectUntouched(docId, before);
  });

  test("an image of the published reading text that is gone makes the old fingerprint uncomputable: 500, nothing replaced", async () => {
    const docId = await createDoc();
    const added = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=0&filename=f.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(4, 3),
      })
    ).json()) as TextAssetAdded;
    await put(docId, added.source.rev, `# T\n\n![alt](assets/${added.asset.name})\n`);
    expect((await generate(docId, added.source.rev + 1)).status).toBe(200);
    await annotate(docId, 1);
    const before = snapshot(docId);
    rmSync(join(docDir(docId), "assets", added.asset.name));
    await put(docId, added.source.rev + 1, CHANGED);
    const res = await generate(docId, added.source.rev + 2);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "fingerprint_failed" });
    expectUntouched(docId, before);
  });

  test("a failed publish after a confirmation keeps the old reading text, archives nothing and leaves the confirmation valid", async () => {
    const { docId } = await annotatedDoc();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    const before = snapshot(docId);
    const published = publishedCount();
    mkdirSync(`${irFile(docId)}.tmp`);
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "publish_failed" });
    expectUntouched(docId, before);
    expect(publishedCount()).toBe(published);
    expect(invalidations()).toHaveLength(0);
    rmSync(`${irFile(docId)}.tmp`, { recursive: true });
    expect((await generate(docId, 2, impact)).status).toBe(200);
  });

  test("a source saved while the candidate is built is not overwritten by the stale result, even with a confirmation", async () => {
    const { docId } = await annotatedDoc();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    const before = snapshot(docId);
    hook = async () => {
      hook = null;
      expect((await put(docId, 2, `${CHANGED}typed meanwhile\n`)).status).toBe(200);
    };
    const res = await generate(docId, 2, impact);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "stale" });
    expectUntouched(docId, before);
    const source = (await (await call("GET", `/api/paper/${docId}/source`)).json()) as {
      markdown: string;
    };
    expect(source.markdown).toContain("typed meanwhile");
  });

  test("annotations cannot be written while a generation runs (document busy), so the confirmed numbers hold until the write", async () => {
    const { docId, file } = await annotatedDoc();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    let putStatus = 0;
    hook = async () => {
      hook = null;
      putStatus = (
        await call("PUT", annotationsUrl(docId), {
          ...file,
          annotations: file.annotations.slice(0, 1),
        })
      ).status;
    };
    const res = await generate(docId, 2, impact);
    expect(putStatus).toBe(409);
    expect(res.status).toBe(200);
    expect(readPublishedTextIr(paths, docId)?.source.source_rev).toBe(2);
    expect(
      (JSON.parse(readFileSync(currentFile(docId), "utf8")) as AnnotationsFile).annotations
    ).toHaveLength(2);
  });

  test("an invalid text (diagnostics) never reaches the confirmation and changes nothing", async () => {
    const { docId } = await annotatedDoc();
    const before = snapshot(docId);
    await put(docId, 1, "# T\n\n```\nunclosed\n");
    const res = await generate(docId, 2);
    expect(res.status).toBe(422);
    expectUntouched(docId, before);
  });

  test("replacing an image never changes the published version: the old image file and reading text stay", async () => {
    const docId = await createDoc();
    const first = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=0&filename=f.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(4, 3),
      })
    ).json()) as TextAssetAdded;
    await put(docId, first.source.rev, `# T\n\n![alt](assets/${first.asset.name})\n`);
    expect((await generate(docId, first.source.rev + 1)).status).toBe(200);
    const oldBytes = readFileSync(join(docDir(docId), "assets", first.asset.name));
    const ir = readFileSync(irFile(docId));
    const second = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=2&filename=f.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(9, 9),
      })
    ).json()) as TextAssetAdded;
    expect(second.asset.name).not.toBe(first.asset.name);
    // a failing generation of the new text (broken markup) leaves everything the Reader shows as it was
    await put(
      docId,
      second.source.rev,
      `# T\n\n![alt](assets/${second.asset.name})\n\n\`\`\`\nbroken\n`
    );
    expect((await generate(docId, second.source.rev + 1)).status).toBe(422);
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    const served = await app.request(`/images/${docId}/${first.asset.name}`);
    expect(Buffer.from(await served.arrayBuffer()).equals(oldBytes)).toBe(true);
  });
});

describe("the annotations access path after a publish reports the contract's states exactly", () => {
  async function replaced() {
    const { docId } = await annotatedDoc(2);
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect((await generate(docId, 2, impact)).status).toBe(200);
    return { docId, impact, oldCurrent: readFileSync(currentFile(docId)) };
  }
  const coherent = (docId: string) => call("GET", `${annotationsUrl(docId)}?coherent=1`);

  test("archive cannot be written: 500, the original current stays, no invalidate; the retry succeeds once it can", async () => {
    const { docId, oldCurrent } = await replaced();
    writeFileSync(archiveDir(docId), "not a directory");
    const res = await coherent(docId);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/archive/);
    expect(readFileSync(currentFile(docId)).equals(oldCurrent)).toBe(true);
    expect(invalidations()).toHaveLength(0);
    // the published reading text is not rolled back
    expect(readPublishedTextIr(paths, docId)?.source.source_rev).toBe(2);
    rmSync(archiveDir(docId));
    const retry = await coherent(docId);
    expect(retry.status).toBe(200);
    expect(archive(docId)).toHaveLength(1);
    expect(invalidations()).toHaveLength(1);
  });

  test("an archive directory that cannot be written into (write/rename of the copy fails): 500, the original current stays untouched", async () => {
    const { docId, oldCurrent } = await replaced();
    mkdirSync(archiveDir(docId));
    chmodSync(archiveDir(docId), 0o555);
    try {
      const res = await coherent(docId);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/failed to archive/);
    } finally {
      chmodSync(archiveDir(docId), 0o755);
    }
    expect(readFileSync(currentFile(docId)).equals(oldCurrent)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
    expect((await coherent(docId)).status).toBe(200);
    expect(archive(docId)).toHaveLength(1);
  });

  test("archive done but the new current cannot be created: 500 saying so, the batch is safe in the archive, no invalidate; the next access rebuilds", async () => {
    const { docId, oldCurrent } = await replaced();
    mkdirSync(`${currentFile(docId)}.tmp`); // a directory where the temp file of the new current goes
    const res = await coherent(docId);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { detail: string }).detail).toMatch(
      /archived but the new current/
    );
    expect(archive(docId)).toHaveLength(1);
    expect(
      readFileSync(join(archiveDir(docId), archive(docId)[0] as string)).equals(oldCurrent)
    ).toBe(true);
    expect(invalidations()).toHaveLength(0);
    rmSync(`${currentFile(docId)}.tmp`, { recursive: true });
    const retry = await coherent(docId);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as CoherentAnnotationsRead).file).toMatchObject({ rev: 0 });
    expect(invalidations()).toHaveLength(1);
    // every archived copy is the user's original batch
    for (const name of archive(docId))
      expect(readFileSync(join(archiveDir(docId), name)).equals(oldCurrent)).toBe(true);
  });

  test("a damaged reading text is 500; the annotations are not touched", async () => {
    const { docId, oldCurrent } = await replaced();
    const ir = readFileSync(irFile(docId));
    writeFileSync(irFile(docId), "{ broken");
    expect((await coherent(docId)).status).toBe(500);
    writeFileSync(irFile(docId), ir);
    expect(readFileSync(currentFile(docId)).equals(oldCurrent)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
  });

  test("a published image that is missing or unreadable cannot give a fingerprint: 500 for the access, nothing archived or reset", async () => {
    const docId = await createDoc();
    const added = (await (
      await app.request(`/api/paper/${docId}/source/assets?expectedRev=0&filename=f.png`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: png(4, 3),
      })
    ).json()) as TextAssetAdded;
    await put(docId, added.source.rev, `# T\n\n![alt](assets/${added.asset.name})\n`);
    expect((await generate(docId, added.source.rev + 1)).status).toBe(200);
    await annotate(docId, 1);
    const current = readFileSync(currentFile(docId));
    const file = join(docDir(docId), "assets", added.asset.name);
    const bytes = readFileSync(file);
    // missing
    rmSync(file);
    expect((await coherent(docId)).status).toBe(500);
    // unreadable: a directory where the file must be
    mkdirSync(file);
    expect((await coherent(docId)).status).toBe(500);
    rmSync(file, { recursive: true });
    // restored: the same content again, nothing to replace
    writeFileSync(file, bytes);
    expect((await coherent(docId)).status).toBe(200);
    expect(readFileSync(currentFile(docId)).equals(current)).toBe(true);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
  });

  test("current.json damaged: 500 and never silently reset", async () => {
    const { docId } = await replaced();
    writeFileSync(currentFile(docId), "{ broken");
    expect((await coherent(docId)).status).toBe(500);
    expect(readFileSync(currentFile(docId), "utf8")).toBe("{ broken");
    expect(archive(docId)).toEqual([]);
  });

  test("the annotations PUT is the other archiving path: an old-fingerprint payload gets 409 document changed after the archive", async () => {
    const { docId, oldCurrent } = await replaced();
    const old = JSON.parse(oldCurrent.toString()) as AnnotationsFile;
    const res = await call("PUT", annotationsUrl(docId), old);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("document changed");
    expect(archive(docId)).toHaveLength(1);
    expect(invalidations()).toHaveLength(1);
  });

  test("a running generation makes the access path busy: no read of half-made content, no archive, no broadcast", async () => {
    const { docId } = await annotatedDoc();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    let busyStatus = 0;
    hook = async () => {
      hook = null;
      busyStatus = (await coherent(docId)).status;
    };
    expect((await generate(docId, 2, impact)).status).toBe(200);
    expect(busyStatus).toBe(409);
    expect(archive(docId)).toEqual([]);
    expect(invalidations()).toHaveLength(0);
  });
});

describe("source, assets, generation and delete exclude one another both ways", () => {
  test("a generation is refused while the Doc is being deleted", async () => {
    const { docId } = await annotatedDoc();
    expect(docMutations.tryBeginDelete(docId)).toBe(true);
    const before = snapshot(docId);
    const res = await generate(docId, 1);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ detail: "document busy" });
    expectUntouched(docId, before);
    docMutations.endDelete(docId);
  });

  test("a delete started while the user is deciding wins; the late confirmation finds no Doc and publishes nothing", async () => {
    const { docId } = await annotatedDoc();
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect((await call("DELETE", `/api/paper/${docId}`)).status).toBe(200);
    expect(existsSync(docDir(docId))).toBe(false);
    const res = await generate(docId, 2, impact);
    expect([404, 500]).toContain(res.status);
    expect(existsSync(docDir(docId))).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);
  });

  test("global delete after a replacement removes source, reading text, current and archived annotations and every Work link; a refresh does not bring it back", async () => {
    const { docId } = await annotatedDoc(2);
    await put(docId, 1, CHANGED);
    const impact = await impactOf(await generate(docId, 2));
    expect((await generate(docId, 2, impact)).status).toBe(200);
    await call("GET", annotationsUrl(docId)); // archives
    expect(archive(docId)).toHaveLength(1);
    const res = await call("DELETE", `/api/paper/${docId}`);
    expect(res.status).toBe(200);
    expect(existsSync(docDir(docId))).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);
    for (const w of LibraryStore.load(paths).works) expect(w.doc_ids).not.toContain(docId);
    expect((await call("POST", "/api/library/refresh?offline=1")).status).toBe(200);
    for (const w of LibraryStore.load(paths).works) expect(w.doc_ids).not.toContain(docId);
  });

  test("a library refresh keeps a published text Doc, its Work link and its annotations untouched", async () => {
    const { docId } = await annotatedDoc(2);
    const before = snapshot(docId);
    expect((await call("POST", "/api/library/refresh?offline=1")).status).toBe(200);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toContain(docId);
    expectUntouched(docId, before);
  });
});
