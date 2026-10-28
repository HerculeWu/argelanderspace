/**
 * Batch bibcode import (project intake ticket 03, contracts "项目迁入" / "批量 bibcode 导入"): `import_works` bibcode
 * mode with several bibcodes, on the real seam (`applyLibraryImport` over `runManualImport` over the real store and
 * the real `AdsClient`) and through the real HTTP route. ADS is an offline `fetch` stub; the data folder is a temporary
 * directory; no network, no credential store.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LibraryImportWorks,
  LibraryImportWorksSchema,
  LibraryReadAdsLibrarySchema,
  libraryBibcodeTokens,
  libraryImportRequest,
  libraryToolImportRequest,
  MANUAL_BIBCODES_MAX,
} from "@argelanderspace/contracts";
import type { MetadataSources } from "@argelanderspace/core";
import { libraryPaths } from "@argelanderspace/core";
import { AdsClient } from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { JobRunner } from "../src/jobs.js";
import {
  applyLibraryImport,
  type BibcodeBatchEntry,
  type LibraryOpDeps,
  runManualImport,
} from "../src/library-actions.js";
import { AsyncLock } from "../src/lock.js";
import { stubPipelines, stubSources } from "./helpers.js";

const TOKEN = "SYNTHETIC-ADS-TOKEN";

interface Rec {
  bibcode: string;
  title: string;
  doi?: string;
  eprint?: string;
  year?: number;
}
const entry = (r: Rec) =>
  `@ARTICLE{${r.bibcode},\n  author = {{Doe}, J.},\n  title = {${r.title}},\n  journal = {\\mnras},\n  year = {${r.year ?? 2020}},\n${
    r.doi ? `  doi = {${r.doi}},\n` : ""
  }${r.eprint ? `  eprint = {${r.eprint}},\n  archivePrefix = {arXiv},\n` : ""}  volume = {1}\n}`;

const A: Rec = {
  bibcode: "2020MNRAS.499.1234A",
  title: "Paper A on dust",
  doi: "10.1093/mnras/a1",
};
const B: Rec = { bibcode: "2021ApJ...900....1B", title: "Paper B on gas", eprint: "2101.00001" };
// the same paper as B under its arXiv bibcode
const B2: Rec = { bibcode: "2021arXiv210100001B", title: "Paper B on gas", eprint: "2101.00001" };
const C: Rec = {
  bibcode: "2022A&A...650A...3C",
  title: "Paper C on stars",
  doi: "10.1093/mnras/c3",
};
// a record that carries the DOI of the stored Work X and the arXiv id of the stored Work Y
const M: Rec = {
  bibcode: "2023MNRAS.520.9999M",
  title: "Paper M that bridges",
  doi: "10.1000/x",
  eprint: "2102.00002",
};

let root: string;
let paths: ReturnType<typeof libraryPaths>;
let known: Rec[];
let exportCalls: string[][];
let offline: boolean;
/** fail the Nth export request (1-based), others answer */
let failRequest: number | null;

const seedWork = (id: string, extra: object) => ({
  id,
  title: `Stored ${id}`,
  authors: ["Stored"],
  year: 2019,
  venue: "MNRAS",
  type: "article",
  cite_key: `stored${id.replace(/\W/g, "")}`,
  doc_ids: [],
  ...extra,
});
const writeLibrary = (extraWorks: object[] = []) =>
  writeFileSync(
    paths.libraryJson,
    JSON.stringify(
      {
        version: 1,
        project: { name: "Synthetic", short: "S", field: "" },
        works: [
          seedWork("doi:10.1000/x", { doi: "10.1000/x", x_keep: 1 }),
          seedWork("arxiv:2102.00002", { arxiv_id: "2102.00002" }),
          ...extraWorks,
        ],
      },
      null,
      2
    )
  );
const bytes = () => readFileSync(paths.libraryJson, "utf8");
const disk = () => JSON.parse(bytes()) as { works: { id: string; bibcode?: string }[] };

function adsSources(): MetadataSources {
  const fetchImpl = (async (url: unknown, init?: { body?: string }) => {
    // the single-bibcode mode's resolution chain also asks ADS's search; this ADS knows no citation data
    if (String(url).includes("/search/query"))
      return new Response(JSON.stringify({ response: { docs: [] } }), { status: 200 });
    const codes = (JSON.parse(String(init?.body)) as { bibcode: string[] }).bibcode;
    exportCalls.push(codes);
    if (offline || failRequest === exportCalls.length) throw new Error("network down");
    const text = known
      .filter((r) => codes.includes(r.bibcode))
      .map(entry)
      .join("\n\n");
    return new Response(JSON.stringify({ export: text }), { status: 200 });
  }) as never;
  return {
    ...stubSources(),
    ads: new AdsClient({
      token: TOKEN,
      delay: 0,
      cacheDir: join(root, "ads-cache"),
      fetchImpl,
    }),
  };
}

let sources: MetadataSources;
let deps: LibraryOpDeps;
const importOp = (text: string): LibraryImportWorks =>
  LibraryImportWorksSchema.parse({ action: "import_works", mode: "bibcode", text });
/** The batch outcome as the tests read it (either the ok or the failed shape of a batch). */
type Batch = Record<string, unknown> & {
  ok: boolean;
  status: string;
  entries: BibcodeBatchEntry[];
  updated?: string[];
  reasons?: Record<string, string>;
  object?: unknown;
  detail?: string;
};
const batch = async (...codes: string[]) =>
  (await applyLibraryImport(deps, importOp(codes.join("\n")))) as unknown as Batch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bibcode-batch-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  known = [A, B, B2, C, M];
  exportCalls = [];
  offline = false;
  failRequest = null;
  sources = adsSources();
  const libraryLock = new AsyncLock();
  deps = {
    paths,
    libraryLock,
    onChanged: () => {},
    readPayload: async () => {
      throw new Error("unused");
    },
    importWorks: (req, options) =>
      runManualImport({ paths, libraryLock, makeSources: () => sources }, req, options),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("every bibcode is created, in order, from one ADS export request", async () => {
  const out = await batch(A.bibcode, B.bibcode, C.bibcode);
  expect(out).toMatchObject({
    ok: true,
    status: "ok",
    batch: true,
    requested: 3,
    created: 3,
    existing: 0,
    refused: 0,
    failed: 0,
  });
  expect(out.entries.map((e) => [e.bibcode, e.status])).toEqual([
    [A.bibcode, "created"],
    [B.bibcode, "created"],
    [C.bibcode, "created"],
  ]);
  expect(out.entries[0]).toMatchObject({ id: "doi:10.1093/mnras/a1", title: "Paper A on dust" });
  expect(out.object).toMatchObject({ kind: "work" });
  expect(exportCalls).toHaveLength(1);
  expect(exportCalls[0]).toEqual([A.bibcode, B.bibcode, C.bibcode]);
  const works = disk().works;
  expect(works.map((w) => w.bibcode).filter(Boolean)).toEqual([A.bibcode, B.bibcode, C.bibcode]);
  // the stored Works are untouched, unknown keys kept
  expect(works.find((w) => w.id === "doi:10.1000/x")).toMatchObject({ x_keep: 1 });
});

test("a failed or unknown bibcode fails alone; the others are saved and the failure is reported", async () => {
  const out = await batch(A.bibcode, "2099NOPE..1....Z", C.bibcode);
  expect(out).toMatchObject({
    ok: true,
    status: "ok",
    created: 2,
    failed: 1,
    refused: 0,
    warnings: ["import_partial"],
  });
  expect(out.entries[1]).toMatchObject({
    bibcode: "2099NOPE..1....Z",
    status: "error",
    reason: "not_found",
  });
  expect(
    disk()
      .works.map((w) => w.bibcode)
      .filter(Boolean)
  ).toEqual([A.bibcode, C.bibcode]);
});

test("an entry that would merge stored Works is refused alone with nothing of it written", async () => {
  const before = disk();
  const out = await batch(A.bibcode, M.bibcode, C.bibcode);
  expect(out).toMatchObject({ ok: true, created: 2, refused: 1, failed: 0 });
  expect(out.entries[1]).toMatchObject({
    bibcode: M.bibcode,
    status: "error",
    reason: "merge_refused",
  });
  expect([...(out.entries[1]?.works ?? [])].sort()).toEqual(["arxiv:2102.00002", "doi:10.1000/x"]);
  const after = disk();
  // both stored Works are still there, unchanged; M created nothing and recorded no bibcode
  expect(after.works.slice(0, 2)).toEqual(before.works);
  expect(after.works.some((w) => w.bibcode === M.bibcode)).toBe(false);
  expect(after.works.map((w) => w.bibcode).filter(Boolean)).toEqual([A.bibcode, C.bibcode]);
});

test("when every entry would merge, the call is rejected and the file is byte-identical", async () => {
  const before = bytes();
  const out = await batch(M.bibcode);
  // a single bibcode is the single mode: its old whole-call rejection
  expect(out).toMatchObject({ ok: false, status: "rejected" });
  expect(bytes()).toBe(before);
  const two = await applyLibraryImport(deps, importOp(`${M.bibcode} ${M.bibcode}`));
  expect(two).toMatchObject({ ok: false, status: "rejected", batch: true, refused: 2 });
  expect(bytes()).toBe(before);
});

test("an entry that would merge a Work created earlier in the same batch is refused", async () => {
  // N: DOI of B... build a record that carries A's DOI and B's arXiv id, after A and B were created
  const N: Rec = {
    bibcode: "2024MNRAS.530..777N",
    title: "Paper N that bridges two new works",
    doi: A.doi,
    eprint: B.eprint,
  };
  known.push(N);
  const out = await batch(A.bibcode, B.bibcode, N.bibcode);
  expect(out).toMatchObject({ ok: true, created: 2, refused: 1 });
  expect(out.entries[2]).toMatchObject({ reason: "merge_refused" });
  expect(out.entries[2]).not.toHaveProperty("error");
  expect(disk().works).toHaveLength(4);
});

test("updated lists a Work once, and only for an entry that itself filled a field of a stored Work", async () => {
  writeLibrary();
  const stored = JSON.parse(bytes()) as { works: Record<string, unknown>[] };
  (stored.works[0] as Record<string, unknown>).note = "my note";
  writeFileSync(paths.libraryJson, JSON.stringify(stored, null, 2));
  // P1 and P2: two bibcodes of the stored DOI Work (the first fills its blank bibcode, the second finds nothing to fill);
  // B and B2: a new paper and its second bibcode (a hit on a Work created in this call is not an update)
  const P1: Rec = { bibcode: "2025MNRAS.540....1P", title: "Different title P1", doi: "10.1000/x" };
  const P2: Rec = { bibcode: "2025MNRAS.540....2P", title: "Different title P2", doi: "10.1000/x" };
  known.push(P1, P2);
  const out = await batch(P1.bibcode, P2.bibcode, B.bibcode, B2.bibcode);
  expect(out).toMatchObject({ ok: true, created: 1, existing: 3 });
  expect(out.updated).toEqual(["doi:10.1000/x"]);
  const x = disk().works.find((w) => w.id === "doi:10.1000/x") as Record<string, unknown>;
  expect(x).toMatchObject({
    title: "Stored doi:10.1000/x",
    note: "my note",
    x_keep: 1,
    bibcode: P1.bibcode,
  });
  // an entry that fills nothing: importing the same two again changes nothing
  const again = await batch(P1.bibcode, P2.bibcode);
  expect(again).toMatchObject({ ok: true, status: "noop", existing: 2 });
  expect(again.updated).toEqual([]);
});

test("nothing created leaves the graph cache alone: no cache file is made when every entry fails", async () => {
  expect(existsSync(paths.graphJson)).toBe(false);
  offline = true;
  const out = await batch(A.bibcode, B.bibcode);
  expect(out).toMatchObject({ ok: false, failed: 2 });
  expect(existsSync(paths.graphJson)).toBe(false);
  offline = false;
  sources = adsSources(); // the failed client stays failed by design
  const ok = await batch(A.bibcode);
  expect(ok).toMatchObject({ ok: true, created: 1 });
  expect(existsSync(paths.graphJson)).toBe(true);
});

test("a batch result gives each reason's explanation once, not per entry", async () => {
  const out = await batch(A.bibcode, M.bibcode, "2099NOPE..1....Z", "2099NOPE..2....Z");
  expect(out.reasons).toEqual({
    merge_refused: expect.any(String),
    not_found: expect.any(String),
  });
  for (const e of out.entries) expect(e).not.toHaveProperty("error");
  expect(JSON.stringify(out.entries).length).toBeLessThan(900);
});

test("batch:true makes one bibcode a batch; the parsed token, not the raw text, is the bibcode; no token is a schema error", () => {
  const parse = (extra: object, text: string) =>
    LibraryImportWorksSchema.safeParse({ action: "import_works", mode: "bibcode", text, ...extra });
  expect(libraryToolImportRequest({ mode: "bibcode", text: "X,", batch: true })).toEqual({
    mode: "bibcodes",
    bibcodes: ["X"],
  });
  expect(libraryToolImportRequest({ mode: "bibcode", text: "X," })).toEqual({
    mode: "bibcode",
    bibcode: "X",
  });
  expect(parse({ batch: true }, "X").success).toBe(true);
  expect(parse({}, ", ;").success).toBe(false);
  expect(parse({ batch: true }, "  ;  ").success).toBe(false);
  expect(
    LibraryImportWorksSchema.safeParse({
      action: "import_works",
      mode: "bib",
      text: "@article{k,}",
      batch: true,
    }).success
  ).toBe(false);
});

test("the same bibcode twice mirrors its first entry; two bibcodes of one paper resolve to one Work", async () => {
  const out = await batch(
    A.bibcode,
    A.bibcode,
    B.bibcode,
    B2.bibcode,
    "2099NOPE..1....Z",
    "2099NOPE..1....Z"
  );
  expect(out.entries.map((e) => [e.bibcode, e.status, e.reason ?? null])).toEqual([
    [A.bibcode, "created", null],
    [A.bibcode, "exists", "repeated"],
    [B.bibcode, "created", null],
    [B2.bibcode, "exists", "same_paper_as_earlier"],
    ["2099NOPE..1....Z", "error", "not_found"],
    ["2099NOPE..1....Z", "error", "not_found"],
  ]);
  expect(out.entries[1]?.id).toBe(out.entries[0]?.id);
  expect(out.entries[3]?.id).toBe(out.entries[2]?.id);
  expect(out).toMatchObject({ created: 2, existing: 2, failed: 2 });
  // one Work per paper, the first bibcode is the one it keeps
  const stored = disk().works.filter((w) => w.bibcode);
  expect(stored.map((w) => w.bibcode)).toEqual([A.bibcode, B.bibcode]);
  expect(exportCalls[0]).toEqual([A.bibcode, B.bibcode, B2.bibcode, "2099NOPE..1....Z"]);
});

test("a held bibcode is exists without asking ADS, so a held entry survives ADS being down", async () => {
  await batch(A.bibcode);
  exportCalls.length = 0;
  offline = true;
  const out = await batch(A.bibcode, C.bibcode);
  expect(out).toMatchObject({ ok: true, status: "noop", existing: 1, failed: 1 });
  expect(out.entries.map((e) => [e.status, e.reason ?? null])).toEqual([
    ["exists", null],
    ["error", "ads_unavailable"],
  ]);
  expect(exportCalls).toEqual([[C.bibcode]]);
});

test("ADS unreachable fails every entry, keeps no stub and leaves the file byte-identical", async () => {
  offline = true;
  const before = bytes();
  const out = await batch(A.bibcode, B.bibcode);
  expect(out).toMatchObject({ ok: false, status: "error", batch: true, failed: 2, refused: 0 });
  expect(out.entries?.map((e) => e.reason)).toEqual(["ads_unavailable", "ads_unavailable"]);
  expect(bytes()).toBe(before);
  expect(JSON.stringify(out)).not.toContain(TOKEN);
});

test("each export request carries at most 100 bibcodes and a failed request fails only its own entries", async () => {
  known = Array.from({ length: 150 }, (_, i) => ({
    bibcode: `2020MNRAS.${String(i).padStart(4, "0")}....Q`,
    title: `Synthetic paper number ${i}`,
    year: 2000 + (i % 20),
    doi: `10.2000/q${i}`,
  }));
  failRequest = 2;
  const out = await batch(...known.map((r) => r.bibcode));
  expect(exportCalls.map((c) => c.length)).toEqual([100, 50]);
  expect(out).toMatchObject({ ok: true, requested: 150, created: 100, failed: 50 });
  expect(out.entries.slice(0, 100).every((e) => e.status === "created")).toBe(true);
  expect(out.entries.slice(100).every((e) => e.reason === "ads_unavailable")).toBe(true);
  expect(disk().works.filter((w) => w.bibcode)).toHaveLength(100);
});

test("exactly 200 are accepted; 201 are rejected whole, with the limit, before ADS is asked or anything is written", async () => {
  known = Array.from({ length: 201 }, (_, i) => ({
    bibcode: `2020MNRAS.${String(i).padStart(4, "0")}....Q`,
    title: `Synthetic paper number ${i}`,
    doi: `10.2000/q${i}`,
  }));
  const all = known.map((r) => r.bibcode);
  const before = bytes();
  const over = await batch(...all);
  expect(over).toMatchObject({ ok: false, status: "rejected", batch: true, requested: 201 });
  expect((over as { detail: string }).detail).toContain(String(MANUAL_BIBCODES_MAX));
  expect(exportCalls).toHaveLength(0);
  expect(bytes()).toBe(before);
  const ok = await batch(...all.slice(0, 200));
  expect(ok).toMatchObject({ ok: true, requested: 200, created: 200 });
  expect(exportCalls.map((c) => c.length)).toEqual([100, 100]);
});

test("the tool schema accepts a long bibcode text (the limit is answered, not a schema error) and rejects a bad token", () => {
  const long = Array.from({ length: 450 }, (_, i) => `2020X.${i}`).join(" ");
  expect(
    LibraryImportWorksSchema.safeParse({ action: "import_works", mode: "bibcode", text: long })
      .success
  ).toBe(true);
  expect(
    LibraryImportWorksSchema.safeParse({
      action: "import_works",
      mode: "bibcode",
      text: `${"x".repeat(65)} 2020A..1`,
    }).success
  ).toBe(false);
  expect(libraryBibcodeTokens(" a,b;\n c\td ")).toEqual(["a", "b", "c", "d"]);
});

test("one bibcode is still the single import, and the import dialog's request is unchanged", () => {
  expect(libraryToolImportRequest({ mode: "bibcode", text: " 2020A&A...1..1Z " })).toEqual({
    mode: "bibcode",
    bibcode: "2020A&A...1..1Z",
  });
  expect(libraryToolImportRequest({ mode: "bibcode", text: "a b" })).toEqual({
    mode: "bibcodes",
    bibcodes: ["a", "b"],
  });
  // the page's dialog never batches
  expect(libraryImportRequest({ mode: "bibcode", text: "a b" })).toEqual({
    mode: "bibcode",
    bibcode: "a b",
  });
});

// ---- the HTTP route and the default arXiv PDF job -------------------------------------------------------- //
test("the route takes mode bibcodes, reports per entry, queues no arXiv PDF job and answers 400 over the limit; a single bibcode still queues one", async () => {
  const runner = new JobRunner({ dir: join(root, "jobs") });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  const app = createApp({
    paths,
    statusDir,
    makeSources: () => sources,
    pipelines: stubPipelines(),
    fetchArxivPdf: async () =>
      readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    autoIngestArxiv: () => true,
    runner,
    broadcast: () => {},
  });
  const post = (body: unknown) =>
    app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const pdfJobs = () =>
    runner
      .list()
      .filter((j) => (j.payload as { format?: unknown } | undefined)?.format === "arxiv-pdf");

  const res = await post({
    mode: "bibcodes",
    bibcodes: [A.bibcode, B.bibcode, M.bibcode, "2099NOPE..1....Z"],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    results: { status: string; bibcode?: string; reason?: string }[];
  };
  expect(body.results.map((r) => [r.bibcode, r.status, r.reason ?? null])).toEqual([
    [A.bibcode, "created", null],
    [B.bibcode, "created", null],
    [M.bibcode, "error", "merge_refused"],
    ["2099NOPE..1....Z", "error", "not_found"],
  ]);
  // B has an arXiv id; a single import would have queued its PDF, the batch queues nothing
  expect(pdfJobs()).toHaveLength(0);

  const over = await post({
    mode: "bibcodes",
    bibcodes: Array.from({ length: MANUAL_BIBCODES_MAX + 1 }, (_, i) => `2020X.${i}`),
  });
  expect(over.status).toBe(400);

  known.push({ bibcode: "2022arXiv220100003D", title: "Paper D on discs", eprint: "2201.00003" });
  const single = await post({ mode: "bibcode", bibcode: "2022arXiv220100003D" });
  expect(single.status).toBe(200);
  const one = (await single.json()) as { results: { status: string; ref?: { id: string } }[] };
  expect(one.results).toHaveLength(1);
  expect(one.results[0]?.status).toBe("created");
  expect(one.results[0]).not.toHaveProperty("bibcode");
  expect(pdfJobs()).toHaveLength(1);
  await Promise.all(pdfJobs().map((j) => runner.waitFor(j.id)));
});

test("the per-call cap written as 200 in the tool texts is MANUAL_BIBCODES_MAX, and read_ads_library's page limit is that constant", () => {
  const literal = String(MANUAL_BIBCODES_MAX);
  const tool = createLibraryTool({
    library: {},
    viewAction: async () => ({ ok: true }),
    admitting: () => true,
  } as never);
  const text = JSON.stringify({ description: tool.description, parameters: tool.parameters });
  for (const phrase of [
    `up to ${literal} in one text`,
    `More than ${literal} is rejected whole`,
    `offset, limit up to ${literal}`,
    `at most ${literal}, default ${literal}`,
    `up to ${literal} separated by whitespace`,
  ])
    expect(text, phrase).toContain(phrase);
  const system = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/copilot.ts"),
    "utf8"
  );
  expect(system).toContain(`up to ${literal} as a batch`);
  const ok = { action: "read_ads_library", libraryId: "lib_1" };
  expect(LibraryReadAdsLibrarySchema.safeParse({ ...ok, limit: MANUAL_BIBCODES_MAX }).success).toBe(
    true
  );
  expect(
    LibraryReadAdsLibrarySchema.safeParse({ ...ok, limit: MANUAL_BIBCODES_MAX + 1 }).success
  ).toBe(false);
});
