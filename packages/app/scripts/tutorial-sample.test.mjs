// The tutorial sample's generation script (in-app-tutorial ticket 16), driven through its ports: fake arXiv fetches
// and a fake ingest. No network, no TeX. Needs core/infra/contracts built (the
// app package's tests run after `pnpm -r build`).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { docContentFingerprint } from "../../core/dist/index.js";
import { extractZip } from "../../infra/dist/index.js";
import {
  EVANS_OH_ZIP,
  EXIT,
  eprintUrl,
  JERABKOVA_DOC_ID,
  listFiles,
  MARKER_FILE,
  runSampleCommand,
  SAMPLE_BUDGET_BYTES,
  treeDigest,
} from "./tutorial-sample-lib.mjs";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const IR_TITLE = "The 800pc long tidal tails — Possible discovery of overdensities";
const PARA = "Hello tidal tails of the Hyades.";

function fakeIr() {
  return {
    version: 1,
    docId: JERABKOVA_DOC_ID,
    title: IR_TITLE,
    source: {
      type: "latex",
      origin: eprintUrl("2103.12080v1"),
      main_tex: "m.tex",
      arxiv_id: "2103.12080v1",
    },
    meta: { title: IR_TITLE },
    sections: [
      {
        id: "sec-1",
        level: 1,
        heading: "Intro",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text: PARA }] },
          {
            id: "fig-1",
            type: "figure",
            number: "1",
            captionSegments: [{ type: "text", text: "The tails." }],
            imgPath: "f1.svg",
          },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
  };
}

const work = (over) => ({
  title: "",
  authors: [],
  type: "article",
  origin: "manual",
  ...over,
});

const ISO = "2026-10-21T00:00:00.000Z";
const annotation = (id, target) => ({ id, target, body: "note", created_at: ISO, updated_at: ISO });
const GOOD_ANNOTATIONS = [
  annotation("a_00000001", { type: "document" }),
  annotation("a_00000002", {
    type: "structure",
    id: "fig-1",
    kind: "figure",
    snapshot: { number: "1" },
  }),
  annotation("a_00000003", {
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: 6,
    end: 17,
    quote: "tidal tails",
  }),
];

/** A sample directory in its frozen shape, with a stale fingerprint on the preset annotations. */
function makeSample({ annotations = GOOD_ANNOTATIONS, anchor = "sec-1", jerabkova = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tutorial-sample-test-"));
  roots.push(root);
  const dir = join(root, "tutorial-sample");
  const lit = join(dir, "literatures");
  mkdirSync(join(lit, "library"), { recursive: true });
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ version: 1, sample: 4 }));
  writeFileSync(join(dir, "NOTICE.md"), "notice\n");
  writeFileSync(
    join(lit, "library", "library.json"),
    JSON.stringify({
      version: 1,
      project: { name: "Tutorial" },
      works: [
        work({
          id: "doi:10.1/roser",
          title: "Röser",
          bibcode: "2019A&A...621L...2R",
          doi: "10.1/roser",
        }),
        work({ id: "doi:10.1/mein", title: "Meingast", bibcode: "2019A&A...621L...3M" }),
        work({
          id: "doi:10.1/jer",
          title: "The 800 pc long tidal tails: possible discovery of overdensities",
          arxiv_id: "2103.12080",
          bibcode: "2021A&A...647A.137J",
          doc_ids: [JERABKOVA_DOC_ID],
          ...jerabkova,
        }),
      ],
    })
  );
  mkdirSync(join(lit, "annotations", JERABKOVA_DOC_ID), { recursive: true });
  writeFileSync(
    join(lit, "annotations", JERABKOVA_DOC_ID, "current.json"),
    JSON.stringify({ version: 1, rev: 0, content_fingerprint: "stale", annotations })
  );
  mkdirSync(join(lit, "argument-graphs"), { recursive: true });
  writeFileSync(
    join(lit, "argument-graphs", "jer.json"),
    JSON.stringify({
      version: 1,
      work_id: "doi:10.1/jer",
      rev: 0,
      arguments: [
        {
          id: "arg-1",
          title: "End",
          sources: [{ text: "Section 1", target: { doc_id: JERABKOVA_DOC_ID, anchor } }],
        },
        // a source on another Doc is not this Doc's business
        {
          id: "arg-2",
          title: "Other",
          sources: [{ text: "x", target: { doc_id: "other", anchor: "nope" } }],
        },
      ],
      edges: [],
    })
  );
  // an old ingest product that the regeneration must replace, and leftovers it must not keep
  mkdirSync(join(lit, "output", JERABKOVA_DOC_ID, "assets"), { recursive: true });
  writeFileSync(join(lit, "output", JERABKOVA_DOC_ID, "assets", "old.svg"), "<svg/>");
  mkdirSync(join(dir, "status"), { recursive: true });
  writeFileSync(join(dir, "status", "plans.json"), '{"version":1,"rev":0,"plans":[]}\n');
  return dir;
}

/** A gzipped tar of `files` ({name: content}). */
function tarGz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A fetch that answers the given URLs and records every request. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    const route = routes(u);
    if (route === undefined) throw new Error(`no route for ${u}`);
    return route;
  };
  return { impl, calls };
}

const fakeIngest = (log, irOverride) => async (source, opts) => {
  const res = await opts.fetchImpl(eprintUrl(source));
  log.push({ source, docId: opts.docId, bytes: Buffer.from(await res.arrayBuffer()).toString() });
  const dir = join(opts.outRoot, opts.docId);
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "src", "m.tex"), "\\documentclass{article}");
  writeFileSync(join(dir, "build", "m.log"), "log");
  writeFileSync(join(dir, "assets", "f1.svg"), "<svg>fig</svg>");
  writeFileSync(join(dir, `${opts.docId}.json`), JSON.stringify(irOverride ?? fakeIr()));
};

const quiet = () => {
  const lines = [];
  return { log: (l) => lines.push(l), lines };
};

const marker = (dir) => JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8"));

// ---- regenerate --------------------------------------------------------------------------------------------------

test("regenerate downloads the pinned v1 e-print, keeps only the IR and assets, and recomputes the fingerprint", async () => {
  const dir = makeSample();
  const ingested = [];
  const { impl, calls } = fakeFetch((u) =>
    u === eprintUrl("2103.12080v1") ? new Response("TARBALL") : undefined
  );
  const out = quiet();
  const r = await runSampleCommand(
    "regenerate",
    dir,
    { fetchImpl: impl, ingest: fakeIngest(ingested) },
    out.log
  );
  assert.equal(r.code, EXIT.ok, out.lines.join("\n"));
  assert.deepEqual(calls, ["https://arxiv.org/e-print/2103.12080v1"]);
  // the ingest got the pinned version, the pinned Doc id and the downloaded bytes
  assert.deepEqual(ingested, [
    { source: "2103.12080v1", docId: JERABKOVA_DOC_ID, bytes: "TARBALL" },
  ]);
  const docDir = join(dir, "literatures", "output", JERABKOVA_DOC_ID);
  assert.deepEqual(listFiles(docDir), [`${JERABKOVA_DOC_ID}.json`, "assets/f1.svg"]);
  const ann = JSON.parse(
    readFileSync(join(dir, "literatures", "annotations", JERABKOVA_DOC_ID, "current.json"), "utf8")
  );
  assert.equal(ann.content_fingerprint, docContentFingerprint(fakeIr(), { docDir }));
  assert.deepEqual(ann.annotations, GOOD_ANNOTATIONS);
  assert.equal(ann.rev, 0);
  assert.equal(marker(dir).sample, 5);
  // no staging directory is left beside the sample
  assert.deepEqual(readdirSync(join(dir, "..")), ["tutorial-sample"]);
});

test("regenerate with no preset annotations or argument graphs still checks the library Work", async () => {
  const dir = makeSample();
  rmSync(join(dir, "literatures", "annotations"), { recursive: true });
  rmSync(join(dir, "literatures", "argument-graphs"), { recursive: true });
  const { impl } = fakeFetch(() => new Response("T"));
  const out = quiet();
  const r = await runSampleCommand(
    "regenerate",
    dir,
    { fetchImpl: impl, ingest: fakeIngest([]) },
    out.log
  );
  assert.equal(r.code, EXIT.ok, out.lines.join("\n"));
  assert.equal(existsSync(join(dir, "literatures", "annotations")), false);
});

for (const [what, sampleOpts, expected] of [
  [
    "a structure target whose block id is gone",
    {
      annotations: [
        annotation("a_00000002", { type: "structure", id: "fig-9", kind: "figure", snapshot: {} }),
      ],
    },
    /a_00000002: target fig-9 is not in the IR/,
  ],
  [
    "a text target whose block id is gone",
    {
      annotations: [
        annotation("a_00000003", {
          type: "text",
          block: "p-9",
          container: { type: "content" },
          start: 0,
          end: 5,
          quote: "Hello",
        }),
      ],
    },
    /a_00000003: block p-9 is not in the IR/,
  ],
  [
    "a text target whose quote no longer matches",
    {
      annotations: [
        annotation("a_00000003", {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: 0,
          end: 5,
          quote: "Howdy",
        }),
      ],
    },
    /a_00000003: quote "Howdy" is now "Hello"/,
  ],
  [
    "a text target on a container the block does not have",
    {
      annotations: [
        annotation("a_00000003", {
          type: "text",
          block: "p-1",
          container: { type: "caption" },
          start: 0,
          end: 5,
          quote: "Hello",
        }),
      ],
    },
    /a_00000003: .*no caption container/,
  ],
  ["an argument source anchor that is gone", { anchor: "sec-7" }, /arg-1: source anchor sec-7/],
  [
    "a Jerabkova Work without the Doc",
    { jerabkova: { doc_ids: [] } },
    /does not hold the Doc arxiv-2103.12080/,
  ],
  [
    "a Jerabkova Work whose title differs from the IR",
    { jerabkova: { title: "Something else" } },
    /title "Something else" differs from the IR title/,
  ],
]) {
  test(`regenerate refuses ${what}: nothing is written, every problem is printed`, async () => {
    const dir = makeSample(sampleOpts);
    const before = treeDigest(dir);
    const { impl } = fakeFetch(() => new Response("T"));
    const out = quiet();
    const r = await runSampleCommand(
      "regenerate",
      dir,
      { fetchImpl: impl, ingest: fakeIngest([]) },
      out.log
    );
    assert.equal(r.code, EXIT.failed);
    assert.ok(
      out.lines.some((l) => l.startsWith("FAILED: ") && expected.test(l)),
      out.lines.join("\n")
    );
    assert.equal(treeDigest(dir), before, "the sample must not change");
    assert.deepEqual(readdirSync(join(dir, "..")), ["tutorial-sample"]);
  });
}

test("regenerate prints every failing check, not only the first", async () => {
  const dir = makeSample({
    annotations: [
      annotation("a_00000002", { type: "structure", id: "fig-9", kind: "figure", snapshot: {} }),
      annotation("a_00000004", { type: "structure", id: "sec-8", kind: "section", snapshot: {} }),
    ],
    anchor: "eq-3",
  });
  const { impl } = fakeFetch(() => new Response("T"));
  const out = quiet();
  const r = await runSampleCommand(
    "regenerate",
    dir,
    { fetchImpl: impl, ingest: fakeIngest([]) },
    out.log
  );
  assert.equal(r.code, EXIT.failed);
  assert.equal(r.problems.length, 3, r.problems.join("\n"));
});

test("a failed ingest or download writes nothing", async () => {
  const dir = makeSample();
  const before = treeDigest(dir);
  const out = quiet();
  const down = await runSampleCommand(
    "regenerate",
    dir,
    { fetchImpl: async () => new Response("gone", { status: 404 }), ingest: fakeIngest([]) },
    out.log
  );
  assert.equal(down.code, EXIT.failed);
  const broken = await runSampleCommand(
    "regenerate",
    dir,
    {
      fetchImpl: async () => new Response("T"),
      ingest: async () => {
        throw new Error("TeX compilation failed");
      },
    },
    out.log
  );
  assert.equal(broken.code, EXIT.failed);
  assert.ok(out.lines.includes("FAILED: TeX compilation failed"), out.lines.join("\n"));
  assert.equal(treeDigest(dir), before);
});

// ---- assets ------------------------------------------------------------------------------------------------------

test("assets repacks the pinned v1 e-print as a zip with every file unchanged", async () => {
  const dir = makeSample();
  const files = {
    "ms.tex": "\\documentclass{mnras}\n",
    "figs/f1.pdf": "%PDF-1.5 bytes",
    "ms.bbl": "bib",
  };
  const { impl, calls } = fakeFetch((u) =>
    u === eprintUrl("2202.06973v1") ? new Response(tarGz(files)) : undefined
  );
  const out = quiet();
  const r = await runSampleCommand("assets", dir, { fetchImpl: impl }, out.log);
  assert.equal(r.code, EXIT.ok, out.lines.join("\n"));
  assert.deepEqual(calls, ["https://arxiv.org/e-print/2202.06973v1"]);
  const zip = readFileSync(join(dir, EVANS_OH_ZIP));
  const back = mkdtempSync(join(tmpdir(), "zip-back-"));
  roots.push(back);
  extractZip(new Uint8Array(zip), back);
  assert.deepEqual(listFiles(back), Object.keys(files).sort());
  for (const [name, content] of Object.entries(files))
    assert.equal(readFileSync(join(back, name), "utf8"), content);
  // the listing is printed for the manual review of the tarball
  assert.ok(out.lines.some((l) => l.includes("figs/f1.pdf")));
  assert.equal(marker(dir).sample, 5);
  // the same e-print gives the same bytes
  const again = await runSampleCommand("assets", dir, { fetchImpl: impl }, quiet().log);
  assert.equal(again.code, EXIT.ok);
  assert.ok(readFileSync(join(dir, EVANS_OH_ZIP)).equals(zip));
  assert.equal(marker(dir).sample, 6);
});

test("assets refuses an e-print that is not a tar: nothing written", async () => {
  const dir = makeSample();
  const before = treeDigest(dir);
  const out = quiet();
  const r = await runSampleCommand(
    "assets",
    dir,
    { fetchImpl: async () => new Response(gzipSync("\\documentclass{article}")) },
    out.log
  );
  assert.equal(r.code, EXIT.failed);
  assert.equal(treeDigest(dir), before);
});

// ---- the run -----------------------------------------------------------------------------------------------------

test("over the size budget: the size is printed, the exit code is 3 and nothing is written", async () => {
  const dir = makeSample();
  const before = treeDigest(dir);
  const files = { "big.tex": "x".repeat(5000) };
  const out = quiet();
  const r = await runSampleCommand(
    "assets",
    dir,
    { fetchImpl: async () => new Response(tarGz(files)), budgetBytes: 1000 },
    out.log
  );
  assert.equal(r.code, EXIT.overBudget);
  assert.ok(r.bytes > 1000);
  assert.ok(
    out.lines.some((l) => l.startsWith("sample directory: ")),
    out.lines.join("\n")
  );
  assert.ok(out.lines.some((l) => l.includes("OVER BUDGET")));
  assert.equal(treeDigest(dir), before);
  assert.equal(SAMPLE_BUDGET_BYTES, 100_000_000);
});

test("the marker must be exactly {version: 1, sample: n}", async () => {
  for (const bad of [
    { version: 1 },
    { version: 2, sample: 1 },
    { version: 1, sample: 1, app: "0.1" },
    { version: 1, sample: -1 },
  ]) {
    const dir = makeSample();
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify(bad));
    const before = treeDigest(dir);
    const out = quiet();
    const r = await runSampleCommand(
      "assets",
      dir,
      { fetchImpl: async () => new Response(tarGz({ a: "b" })) },
      out.log
    );
    assert.equal(r.code, EXIT.failed, JSON.stringify(bad));
    assert.equal(treeDigest(dir), before);
  }
});

test("an unknown sub-command is a usage error that touches nothing", async () => {
  // `cache` is gone (2026-10-21): the sample carries no ADS discovery cache (ADS API terms: no redistribution).
  for (const command of ["rebuild", "cache"]) {
    const dir = makeSample();
    const before = treeDigest(dir);
    const out = quiet();
    const r = await runSampleCommand(command, dir, {}, out.log);
    assert.equal(r.code, EXIT.usage, command);
    assert.equal(
      out.lines[0],
      "usage: tutorial-sample.mjs <regenerate|assets> [--sample-dir <dir>]"
    );
    assert.equal(treeDigest(dir), before);
  }
});
