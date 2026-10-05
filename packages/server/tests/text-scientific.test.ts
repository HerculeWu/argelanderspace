/**
 * Text Doc scientific content (copilot ticket 26) through the real seam: `createApp` + temp dataDir + HTTP. The full
 * fixture goes PUT -> validate -> generate -> coherent read; errors keep the source and the old reading text; the
 * annotation machinery (structure targets on the new block kinds, text targets across math/cite/xref atoms) works on
 * the generated IR and is never touched by a refused generation.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnnotationsFile,
  buildStructureTarget,
  type CoherentAnnotationsRead,
  canonicalContainerText,
  resolveTextTarget,
  type TextDocIr,
  type TextGenerationResult,
  type TextSourceDto,
  type TextValidationResult,
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

let dataDir: string;
let app: Hono;
let messages: WsServerMessage[];

beforeEach(() => {
  dataDir = makeDataDir();
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    docMutations: new DocMutationRegistry(),
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
    operationId: `op-sci-${Math.random().toString(16).slice(2)}`,
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
const docDir = (docId: string) => join(dataDir, "output", docId);
const irFile = (docId: string) => join(docDir(docId), `${docId}.json`);
const annDir = (docId: string) => join(dataDir, "annotations", docId);

const F = "```";
const MARKDOWN = [
  `${F}argelander-document`,
  JSON.stringify({ version: 1, title: "Galactic Halos", authors: ["A. Author"] }),
  F,
  "",
  `${F}argelander-block`,
  JSON.stringify({ id: "sec-intro", number: "1" }),
  F,
  "# Introduction",
  "",
  "Mass follows [ref: eq-m | Eq. (1)] and costs $5 to $9; the radius is $r_s = 2GM/c^2$ (see [cite: bok1934]).",
  "",
  `${F}argelander-block`,
  JSON.stringify({ id: "eq-m", number: "1", label: "mass" }),
  F,
  "$$",
  "M = \\int \\rho \\, dV",
  "$$",
  "",
  `${F}argelander-block`,
  JSON.stringify({
    id: "alg-1",
    kind: "algorithm",
    number: "1",
    label: "Algorithm 1",
    caption: "Halo finder, [cite: bok1934].",
  }),
  F,
  `${F}`,
  "for p in particles:\n\tlink(p)  ",
  F,
  "",
  "- first $a$",
  "- see [ref: sec-intro]",
  "",
  `${F}argelander-references`,
  JSON.stringify([
    { id: "bok1934", raw: "Bok, B. J. 1934, The Milky Way", authors: ["Bok"], year: 1934 },
  ]),
  F,
  "",
].join("\n");

async function generated(markdown = MARKDOWN) {
  const docId = await createDoc();
  expect((await put(docId, 0, markdown)).status).toBe(200);
  const res = await generate(docId, 1);
  return { docId, res };
}

describe("validate and generate the complete fixture", () => {
  test("validate reports no error and counts the content; it writes nothing", async () => {
    const docId = await createDoc();
    await put(docId, 0, MARKDOWN);
    const before = readFileSync(join(docDir(docId), "text-source.json"));
    const res = await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 1 });
    const result = (await res.json()) as TextValidationResult;
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.stats).toMatchObject({
      equations: 1,
      codeBlocks: 1,
      references: 1,
      citations: 2,
    });
    expect(readFileSync(join(docDir(docId), "text-source.json")).equals(before)).toBe(true);
    expect(existsSync(irFile(docId))).toBe(false);
    expect(existsSync(annDir(docId))).toBe(false);
  });

  test("generation publishes the IR to the shared Reader read: equations, caption, cite/xref, manifests, references", async () => {
    const { docId, res } = await generated();
    expect(res.status).toBe(200);
    const result = (await res.json()) as TextGenerationResult;
    expect(result.stats).toMatchObject({ equations: 1, references: 1 });
    const read = (await (
      await call("GET", `/api/paper/${docId}/annotations?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    const ir = read.ir as TextDocIr;
    expect(read.file.content_fingerprint).toBe(result.fingerprint);
    expect(ir.source.type).toBe("text");
    expect(ir.title).toBe("Galactic Halos");
    expect(ir.meta.authors).toEqual(["A. Author"]);
    const intro = ir.sections[0];
    expect(intro).toMatchObject({ id: "sec-intro", number: "1", heading: "Introduction" });
    const [para, eq, alg, list] = intro?.blocks ?? [];
    expect(para?.type === "paragraph" && para.segments.map((s) => s.type)).toEqual([
      "text",
      "xref",
      "text",
      "math",
      "text",
      "cite",
      "text",
    ]);
    expect(eq).toEqual({
      id: "eq-m",
      type: "equation",
      number: "1",
      label: "mass",
      latex: "M = \\int \\rho \\, dV",
    });
    expect(alg).toMatchObject({
      id: "alg-1",
      type: "algorithm",
      number: "1",
      label: "Algorithm 1",
      body: "for p in particles:\n\tlink(p)  ",
    });
    expect(list?.type).toBe("list");
    expect(ir.references?.map((r) => r.id)).toEqual(["bok1934"]);
    expect(ir.bib[0]).toMatchObject({ id: "bok1934", short: "Bok 1934" });
    expect(ir.citationsByBlock).toEqual({
      [para?.id as string]: ["bok1934"],
      "alg-1": ["bok1934"],
    });
    expect(ir.refsManifest.find((r) => r.id === "eq-m")).toMatchObject({
      kind: "equation",
      number: "1",
      section: "1:Introduction",
    });
    // the stored file is exactly the IR the Reader read
    expect(JSON.parse(readFileSync(irFile(docId), "utf8"))).toEqual(ir);
    expect(messages.some((m) => m.type === "annotation.changed")).toBe(false);
  });

  test("warnings (unresolved cite and ref, a formula KaTeX rejects) do not stop generation and are returned", async () => {
    const md = "# T\n\nSee [cite: nobody], [ref: nowhere | Fig. 3] and $\\frobnicate{x}$.\n";
    const docId = await createDoc();
    await put(docId, 0, md);
    const validated = (await (
      await call("POST", `/api/paper/${docId}/source/validate`, { sourceRev: 1 })
    ).json()) as TextValidationResult;
    expect(validated.valid).toBe(true);
    expect(validated.diagnostics.map((d) => [d.code, d.severity, d.line, d.column])).toEqual([
      ["cite_unresolved", "warning", 3, 5],
      ["ref_unresolved", "warning", 3, 21],
      ["math_katex", "warning", 3, 49],
    ]);
    const res = await generate(docId, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TextGenerationResult;
    expect(body.diagnostics).toHaveLength(3);
    const ir = JSON.parse(readFileSync(irFile(docId), "utf8")) as TextDocIr;
    const para = ir.sections[0]?.blocks[0];
    expect(para?.type === "paragraph" && para.segments).toMatchObject([
      { type: "text" },
      { type: "cite", refs: [{ id: "nobody", resolved: false }] },
      { type: "text" },
      { type: "xref", target: { id: "nowhere", resolved: false }, raw: "Fig. 3" },
      { type: "text" },
      { type: "math", latex: "\\frobnicate{x}" },
      { type: "text", text: "." },
    ]);
    expect(ir.references).toBeUndefined();
  });
});

describe("errors keep everything", () => {
  const BROKEN: [string, string, number][] = [
    ["unclosed display math", "# T\n\nText\n\n$$\nx\n", 5],
    [
      "duplicate explicit id",
      `${F}argelander-block\n{"id":"a"}\n${F}\n# One\n\n${F}argelander-block\n{"id":"a"}\n${F}\n$$x$$\n`,
      7,
    ],
    ["missing required field", `x\n\n${F}argelander-references\n[{"id":"a"}]\n${F}\n`, 4],
    ["metadata JSON error", `${F}argelander-block\n{"id": }\n${F}\npara\n`, 2],
    ["references not last", `${F}argelander-references\n[]\n${F}\n\nafter\n`, 1],
  ];
  for (const [name, bad, line] of BROKEN) {
    test(`${name}: the source is saved, generation is refused with a located diagnostic, the old IR and annotations are byte-identical`, async () => {
      const { docId, res } = await generated();
      expect(res.status).toBe(200);
      const ir = readFileSync(irFile(docId));
      // an annotation exists, so any touch of the annotation files would show
      const url = `/api/paper/${docId}/annotations`;
      const current = (await (await call("GET", url)).json()) as AnnotationsFile;
      const read = (await (
        await call("GET", `${url}?coherent=1`)
      ).json()) as CoherentAnnotationsRead;
      const target = resolveTextTarget(read.ir, {
        block: "eq-m",
        container: { type: "content" },
        start: 0,
        end: 1,
      });
      expect(target.ok).toBe(false); // equations are structure-only, text targets are refused by the contract
      const eqBlock = read.ir.sections[0]?.blocks.find((b) => b.id === "eq-m");
      expect(eqBlock).toBeDefined();
      const put1 = await call("PUT", url, {
        ...current,
        annotations: [
          {
            id: "a_0123abc0",
            target: buildStructureTarget(eqBlock as never),
            body: "check this",
            created_at: "2026-10-05T10:00:00.000Z",
            updated_at: "2026-10-05T10:00:00.000Z",
          },
        ],
      });
      expect(put1.status).toBe(200);
      const currentBytes = existsSync(join(annDir(docId), "current.json"))
        ? readFileSync(join(annDir(docId), "current.json"))
        : null;
      expect((await put(docId, 1, bad)).status).toBe(200);
      const source = readFileSync(join(docDir(docId), "text-source.json"));
      const notified = messages.length; // the saves above are announced; the refused generation must add nothing
      const res2 = await generate(docId, 2);
      expect(res2.status).toBe(422);
      const body = (await res2.json()) as { diagnostics: { line?: number; severity: string }[] };
      expect(body.diagnostics.some((d) => d.severity === "error" && d.line === line)).toBe(true);
      expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
      expect(readFileSync(join(docDir(docId), "text-source.json")).equals(source)).toBe(true);
      const after = existsSync(join(annDir(docId), "current.json"))
        ? readFileSync(join(annDir(docId), "current.json"))
        : null;
      expect(after === null ? null : after.toString()).toBe(
        currentBytes === null ? null : currentBytes.toString()
      );
      expect(
        existsSync(join(annDir(docId), "archive"))
          ? readdirSync(join(annDir(docId), "archive"))
          : []
      ).toEqual([]);
      expect(messages.slice(notified)).toEqual([]);
    });
  }
});

describe("the shared annotation machinery works on the new content", () => {
  test("text targets span math/cite/xref atoms (expanded to whole atoms) and list/caption containers", async () => {
    const { docId } = await generated();
    const read = (await (
      await call("GET", `/api/paper/${docId}/annotations?coherent=1`)
    ).json()) as CoherentAnnotationsRead;
    const ir = read.ir;
    const para = ir.sections[0]?.blocks[0];
    expect(para?.type).toBe("paragraph");
    if (!para) return;
    const canonical = canonicalContainerText(para, { type: "content" });
    // "Mass follows Eq. (1) and costs ..." the xref's canonical text is its display text
    expect(
      canonical.startsWith("Mass follows Eq. (1) and costs $5 to $9; the radius is $r_s = 2GM/c^2$")
    ).toBe(true);
    const start = canonical.indexOf("(1)") + 1; // inside the xref atom
    const target = resolveTextTarget(ir, {
      block: para.id,
      container: { type: "content" },
      start,
      end: start + 2,
    });
    expect(target.ok && target.expanded).toBe(true);
    expect(target.ok && target.target.quote).toBe("Eq. (1)");
    const caption = resolveTextTarget(ir, {
      block: "alg-1",
      container: { type: "caption" },
      start: 0,
      end: 5,
    });
    expect(caption).toMatchObject({ ok: true, target: { quote: "Halo " } });
    const item = resolveTextTarget(ir, {
      block: "l-1",
      container: { type: "list_item", index: 1 },
      start: 0,
      end: 3,
    });
    expect(item).toMatchObject({ ok: true });
  });

  test("regenerating different content over annotations asks for confirmation first (nothing archived or published)", async () => {
    const { docId } = await generated();
    const url = `/api/paper/${docId}/annotations`;
    const read = (await (await call("GET", `${url}?coherent=1`)).json()) as CoherentAnnotationsRead;
    const para = read.ir.sections[0]?.blocks[0];
    const resolved = resolveTextTarget(read.ir, {
      block: para?.id as string,
      container: { type: "content" },
      start: 0,
      end: 4,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const current = (await (await call("GET", url)).json()) as AnnotationsFile;
    const saved = await call("PUT", url, {
      ...current,
      annotations: [
        {
          id: "a_0123abc1",
          target: resolved.target,
          body: "note",
          created_at: "2026-10-05T10:00:00.000Z",
          updated_at: "2026-10-05T10:00:00.000Z",
        },
      ],
    });
    expect(saved.status).toBe(200);
    const ir = readFileSync(irFile(docId));
    const currentBytes = readFileSync(join(annDir(docId), "current.json"));
    await put(docId, 1, MARKDOWN.replace("Halo finder", "Halo detector"));
    const res = await generate(docId, 2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("confirmation_required");
    expect(readFileSync(irFile(docId)).equals(ir)).toBe(true);
    expect(readFileSync(join(annDir(docId), "current.json")).equals(currentBytes)).toBe(true);
    expect(existsSync(join(annDir(docId), "archive"))).toBe(false);
  });
});

describe("the source file", () => {
  test("the markdown, including the marker blocks, round-trips byte for byte", async () => {
    const docId = await createDoc();
    await put(docId, 0, MARKDOWN);
    const dto = (await (await call("GET", `/api/paper/${docId}/source`)).json()) as TextSourceDto;
    expect(dto.markdown).toBe(MARKDOWN);
  });
});
