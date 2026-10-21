// The tutorial sample's generation script (in-app-tutorial ticket 16): the rules behind `tutorial-sample.mjs`, kept
// here with their ports injected so tutorial-sample.test.mjs can drive them without the network, TeX or a keychain.
//
// The sample (`tutorial-sample/` at the repository root) is a FROZEN product committed to git. This script makes only
// its REGENERABLE parts, one sub-command per run:
//   regenerate  the pinned e-print 2103.12080v1 → ingest in a temp dir → only the IR and assets/ are copied back; the
//               preset annotation files get their `content_fingerprint` recomputed and every target is checked (block
//               id in the IR, a text target's quote equal to the canonical text), every argument source anchor on that
//               Doc must exist, and library.json's Jerabkova Work must hold the Doc and carry the IR's title.
//   cache       the three ADS discovery cache entries of the Röser seed, written by a `pin: true` client with the
//               ADS token from the credential store, then every doc's `abstract` key is removed.
//   assets      the pinned e-print 2202.06973v1, repacked as a zip with every file unchanged.
// Every run works on a staged copy of the sample: when anything fails (a check, the size budget) the sample is not
// touched at all; when everything passes the marker's `sample` goes up by one and the staged copy replaces the sample.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { AnnotationsFileSchema, canonicalContainerText } from "../../contracts/dist/index.js";
import {
  discoverLiterature,
  docContentFingerprint,
  LibraryStore,
  libraryPaths,
  normArxiv,
} from "../../core/dist/index.js";
import {
  AdsDiscoveryClient,
  extractTar,
  extractZip,
  fetchStreamedBytes,
  zipEntries,
} from "../../infra/dist/index.js";

export const MARKER_FILE = "argelanderspace-tutorial.json";
/** The one Doc of the sample (CC BY 4.0) and its pinned arXiv version. */
export const JERABKOVA_EPRINT = "2103.12080v1";
export const JERABKOVA_DOC_ID = "arxiv-2103.12080";
/** The source uploaded live in chapter 2 (CC BY-NC-ND 4.0: copied unchanged, never adapted). */
export const EVANS_OH_EPRINT = "2202.06973v1";
export const EVANS_OH_ZIP = join("tutorial-assets", "evans-oh-2022-source.zip");
export const ROSER_BIBCODE = "2019A&A...621L...2R";
export const MEINGAST_BIBCODE = "2019A&A...621L...3M";
export const JERABKOVA_BIBCODE = "2021A&A...647A.137J";
/** The size budget of the sample directory: 100 MB (decimal) of file content (spec §1). */
export const SAMPLE_BUDGET_BYTES = 100 * 1000 * 1000;
export const SUBCOMMANDS = ["regenerate", "cache", "assets"];
/** 0 done; 1 a check or a step failed; 2 usage; 3 over the size budget. Nothing is written unless 0. */
export const EXIT = { ok: 0, failed: 1, usage: 2, overBudget: 3 };
/** The zip's member timestamps: fixed, so the same e-print always gives the same bytes. */
const ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0);
const USER_AGENT = "bibgraph/0.1 (https://arxiv.org)";
/** arXiv answers a large e-print slowly (32.7 MB took ~40 s): the download gets ten minutes. */
const DOWNLOAD_TIMEOUT_S = 600;

export const eprintUrl = (id) => `https://arxiv.org/e-print/${id}`;

/** A failure the run reports line by line (never with a stack trace). */
export class SampleCheckError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

// ---- small file helpers -------------------------------------------------------------------------------------------

/** Every regular file under `dir`, as forward-slash paths relative to it, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(relative(dir, p).split(sep).join("/"));
      else throw new SampleCheckError([`not a regular file or directory: ${relative(dir, p)}`]);
    }
  };
  walk(dir);
  return out.sort();
}

/** The sum of the sizes of the files under `dir` (what the budget measures). */
export function directoryBytes(dir) {
  return listFiles(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
}

export const formatMB = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// ---- the marker ---------------------------------------------------------------------------------------------------

/** The marker file: exactly `{version: 1, sample: <integer ≥ 0>}`; anything else is refused. */
export function readMarker(sampleDir) {
  const path = join(sampleDir, MARKER_FILE);
  if (!existsSync(path)) throw new SampleCheckError([`${MARKER_FILE} is missing in ${sampleDir}`]);
  let marker;
  try {
    marker = readJson(path);
  } catch {
    throw new SampleCheckError([`${MARKER_FILE} is not valid JSON`]);
  }
  const keys =
    marker && typeof marker === "object" && !Array.isArray(marker) ? Object.keys(marker) : [];
  if (
    keys.length !== 2 ||
    marker.version !== 1 ||
    !Number.isInteger(marker.sample) ||
    marker.sample < 0
  ) {
    throw new SampleCheckError([
      `${MARKER_FILE} must be exactly {"version": 1, "sample": <integer ≥ 0>}`,
    ]);
  }
  return marker;
}

function writeMarker(dir, sample) {
  writeFileSync(join(dir, MARKER_FILE), `${JSON.stringify({ version: 1, sample }, null, 2)}\n`);
}

// ---- downloads ----------------------------------------------------------------------------------------------------

/** One pinned e-print's bytes (redirects followed, a short body refused). */
export async function downloadEprint(fetchImpl, id) {
  const bytes = await fetchStreamedBytes(fetchImpl, eprintUrl(id), {
    headers: { "User-Agent": USER_AGENT },
    timeout: DOWNLOAD_TIMEOUT_S,
  });
  if (bytes.length === 0) throw new SampleCheckError([`the e-print ${id} came back empty`]);
  return bytes;
}

/** A fetch that answers the one e-print URL with bytes already downloaded and refuses anything else. */
function servedFetch(id, bytes) {
  return async (url) => {
    if (String(url) !== eprintUrl(id)) throw new Error(`unexpected request during ingest: ${url}`);
    return new Response(bytes, { status: 200, headers: { "content-type": "application/gzip" } });
  };
}

// ---- regenerate ---------------------------------------------------------------------------------------------------

/** Every addressable id of an IR: section ids and block ids (the targets annotations and sources may name). */
export function irIds(ir) {
  const sections = new Set();
  const blocks = new Map();
  const walk = (list) => {
    for (const s of list) {
      sections.add(s.id);
      for (const b of s.blocks) blocks.set(b.id, b);
      walk(s.children ?? []);
    }
  };
  walk(ir.sections);
  return { sections, blocks };
}

/** Titles compare by their letters and digits only ("800pc" vs "800 pc", "—" vs ":", case). */
export const compactTitle = (t) => (t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The checks of the preset annotations of one Doc against its new IR: each target's block id is in the IR, each text
 * target's quote is the canonical text at its offsets. Returns the problems found (empty = all hold).
 */
export function checkAnnotations(file, ir, where) {
  const problems = [];
  const { sections, blocks } = irIds(ir);
  for (const a of file.annotations) {
    const t = a.target;
    if (t.type === "document") continue;
    if (t.type === "structure") {
      if (!sections.has(t.id) && !blocks.has(t.id))
        problems.push(`${where}: annotation ${a.id}: target ${t.id} is not in the IR`);
      continue;
    }
    const block = blocks.get(t.block);
    if (!block) {
      problems.push(`${where}: annotation ${a.id}: block ${t.block} is not in the IR`);
      continue;
    }
    let canonical;
    try {
      canonical = canonicalContainerText(block, t.container);
    } catch (err) {
      problems.push(`${where}: annotation ${a.id}: ${err.message}`);
      continue;
    }
    const now = canonical.slice(t.start, t.end);
    if (t.end > canonical.length || now !== t.quote)
      problems.push(
        `${where}: annotation ${a.id}: quote ${JSON.stringify(t.quote)} is now ${JSON.stringify(now)} at ${t.start}–${t.end} of ${t.block}`
      );
  }
  return problems;
}

/** Every argument source that points into `docId` must name an anchor (section or block id) the IR has. */
export function checkArgumentAnchors(dataDir, docId, ir) {
  const dir = join(dataDir, "argument-graphs");
  if (!existsSync(dir)) return [];
  const { sections, blocks } = irIds(ir);
  const problems = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    let graph;
    try {
      graph = readJson(join(dir, name));
    } catch {
      problems.push(`argument-graphs/${name}: not valid JSON`);
      continue;
    }
    if (!Array.isArray(graph?.arguments)) {
      problems.push(`argument-graphs/${name}: no arguments list`);
      continue;
    }
    for (const arg of graph.arguments) {
      for (const source of arg.sources ?? []) {
        const t = source.target;
        if (!t || t.doc_id !== docId || t.anchor === undefined) continue;
        if (!sections.has(t.anchor) && !blocks.has(t.anchor))
          problems.push(
            `argument-graphs/${name}: argument ${arg.id}: source anchor ${t.anchor} is not in the IR`
          );
      }
    }
  }
  return problems;
}

/** library.json's Work for the regenerated Doc must hold it and carry the IR's title. */
export function checkLibraryWork(dataDir, ir, arxiv, docId) {
  const store = LibraryStore.load(libraryPaths(dataDir));
  const work = store.works.find((w) => normArxiv(w.arxiv_id) === normArxiv(arxiv));
  if (!work) return [`library.json: no Work with arXiv id ${normArxiv(arxiv)}`];
  const problems = [];
  if (!work.doc_ids.includes(docId))
    problems.push(`library.json: Work ${work.id} does not hold the Doc ${docId}`);
  if (compactTitle(work.title) !== compactTitle(ir.title))
    problems.push(
      `library.json: Work ${work.id} title ${JSON.stringify(work.title)} differs from the IR title ${JSON.stringify(ir.title)}`
    );
  return problems;
}

async function regenerate(stage, ports, log) {
  const dataDir = join(stage, "literatures");
  const work = mkdtempSync(join(ports.tmpRoot ?? tmpdir(), "tutorial-ingest-"));
  try {
    log(`downloading ${eprintUrl(JERABKOVA_EPRINT)}`);
    const bytes = await downloadEprint(ports.fetchImpl, JERABKOVA_EPRINT);
    log(`ingesting ${JERABKOVA_EPRINT} (${formatMB(bytes.length)}) in a temp dir`);
    const outRoot = join(work, "output");
    mkdirSync(outRoot, { recursive: true });
    await ports.ingest(JERABKOVA_EPRINT, {
      outRoot,
      docId: JERABKOVA_DOC_ID,
      fetchImpl: servedFetch(JERABKOVA_EPRINT, bytes),
    });
    const built = join(outRoot, JERABKOVA_DOC_ID);
    const irName = `${JERABKOVA_DOC_ID}.json`;
    const ir = readJson(join(built, irName));
    if (ir.docId !== JERABKOVA_DOC_ID)
      throw new SampleCheckError([`the ingest produced Doc ${ir.docId}, not ${JERABKOVA_DOC_ID}`]);

    // Only the IR and its assets go into the sample (no src/, no build/).
    const docDir = join(dataDir, "output", JERABKOVA_DOC_ID);
    rmSync(docDir, { recursive: true, force: true });
    mkdirSync(docDir, { recursive: true });
    cpSync(join(built, irName), join(docDir, irName));
    if (existsSync(join(built, "assets")))
      cpSync(join(built, "assets"), join(docDir, "assets"), { recursive: true });

    const problems = [];
    const fingerprint = docContentFingerprint(ir, { docDir });
    const annPath = join(dataDir, "annotations", JERABKOVA_DOC_ID, "current.json");
    if (existsSync(annPath)) {
      const parsed = AnnotationsFileSchema.safeParse(readJson(annPath));
      if (!parsed.success) {
        problems.push(`annotations/${JERABKOVA_DOC_ID}/current.json: not a valid annotations file`);
      } else {
        problems.push(
          ...checkAnnotations(parsed.data, ir, `annotations/${JERABKOVA_DOC_ID}/current.json`)
        );
        const raw = readJson(annPath);
        raw.content_fingerprint = fingerprint;
        writeFileSync(annPath, `${JSON.stringify(raw, null, 2)}\n`);
      }
    }
    problems.push(...checkArgumentAnchors(dataDir, JERABKOVA_DOC_ID, ir));
    problems.push(...checkLibraryWork(dataDir, ir, JERABKOVA_EPRINT, JERABKOVA_DOC_ID));
    if (problems.length > 0) throw new SampleCheckError(problems);
    log(`IR "${ir.title}", content fingerprint ${fingerprint.slice(0, 12)}…`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- cache --------------------------------------------------------------------------------------------------------

/** Remove the `abstract` key of every doc in every cache entry of `dir`; entries must be pinned arrays. */
export function stripAbstracts(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const name of files) {
    const path = join(dir, name);
    const entry = readJson(path);
    if (entry?.pinned !== true || !Array.isArray(entry.data))
      throw new SampleCheckError([`ads-discovery/${name}: not a pinned cache entry`]);
    for (const doc of entry.data) if (doc && typeof doc === "object") delete doc.abstract;
    writeFileSync(path, JSON.stringify(entry));
  }
  return files;
}

/** Problems of a discovery graph the tutorial relies on (chapter 4: Meingast and Jerabkova appear and are saved). */
export function checkDiscovery(graph) {
  if (graph === null) return [`ADS has no record for the seed ${ROSER_BIBCODE}`];
  const problems = [];
  if (graph.warnings.length > 0)
    problems.push(`discovery warnings: ${graph.warnings.map((w) => w.code).join(", ")}`);
  const related = graph.nodes.filter((n) => n.roles.includes("related"));
  const useful = graph.nodes.filter((n) => n.roles.includes("useful"));
  if (related.length === 0) problems.push("no related papers");
  if (useful.length === 0) problems.push("no useful papers");
  for (const bibcode of [MEINGAST_BIBCODE, JERABKOVA_BIBCODE]) {
    const node = [...related, ...useful].find((n) => n.bibcode === bibcode);
    if (!node) problems.push(`${bibcode} is not among the related or useful papers`);
    else if (node.libraryId === null) problems.push(`${bibcode} is not matched to a library Work`);
  }
  return problems;
}

async function cache(stage, ports, log) {
  const dataDir = join(stage, "literatures");
  const token = await ports.readToken();
  if (!token)
    throw new SampleCheckError([
      "no ADS token in the credential store (purpose ads): save one in the workbench settings, then run again",
    ]);
  const cacheDir = join(dataDir, "library", "cache", "ads-discovery");
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const store = LibraryStore.load(libraryPaths(dataDir));
  const online = new AdsDiscoveryClient({ cacheDir, token, pin: true, fetchImpl: ports.fetchImpl });
  log(`discovering from ${ROSER_BIBCODE} with a pinning client`);
  const graph = await discoverLiterature(ROSER_BIBCODE, { ads: online, store });
  const problems = checkDiscovery(graph);
  if (problems.length > 0) throw new SampleCheckError(problems);
  const files = stripAbstracts(cacheDir);
  if (files.length !== 3)
    throw new SampleCheckError([
      `expected 3 cache entries (seed, similar, useful), got ${files.length}`,
    ]);
  // The stripped entries must answer the same discovery offline: no token, a fetch that refuses.
  const offline = new AdsDiscoveryClient({
    cacheDir,
    token: null,
    fetchImpl: () => {
      throw new Error("the sample cache missed");
    },
  });
  const again = await discoverLiterature(ROSER_BIBCODE, { ads: offline, store });
  const offlineProblems = checkDiscovery(again).map((p) => `offline replay: ${p}`);
  if (offlineProblems.length > 0) throw new SampleCheckError(offlineProblems);
  log(
    `${graph.nodes.length} nodes (${graph.nodes.filter((n) => n.libraryId !== null).length} in the library), ${files.length} pinned entries without abstracts`
  );
}

// ---- assets -------------------------------------------------------------------------------------------------------

/** The members of a tar(.gz) as zip entries, unchanged, in name order. */
export function tarToZip(bytes, workDir) {
  const unpacked = join(workDir, "unpacked");
  extractTar(bytes, unpacked);
  const names = listFiles(unpacked);
  if (names.length === 0) throw new SampleCheckError(["the e-print holds no files"]);
  const zip = zipEntries(
    names.map((name) => ({ name, data: readFileSync(join(unpacked, ...name.split("/"))) })),
    ZIP_DATE
  );
  // Read back the way an upload reads it: the same names, byte for byte.
  const back = join(workDir, "readback");
  extractZip(new Uint8Array(zip), back);
  const backNames = listFiles(back);
  const problems = [];
  if (backNames.join("\n") !== names.join("\n"))
    problems.push("the zip lists other files than the e-print");
  for (const name of names) {
    const a = readFileSync(join(unpacked, ...name.split("/")));
    const p = join(back, ...name.split("/"));
    if (!existsSync(p) || !a.equals(readFileSync(p))) problems.push(`${name} changed in the zip`);
  }
  if (problems.length > 0) throw new SampleCheckError(problems);
  return {
    zip,
    members: names.map((name) => ({
      name,
      bytes: statSync(join(unpacked, ...name.split("/"))).size,
    })),
  };
}

async function assets(stage, ports, log) {
  const work = mkdtempSync(join(ports.tmpRoot ?? tmpdir(), "tutorial-assets-"));
  try {
    log(`downloading ${eprintUrl(EVANS_OH_EPRINT)}`);
    const bytes = await downloadEprint(ports.fetchImpl, EVANS_OH_EPRINT);
    let packed;
    try {
      packed = tarToZip(bytes, work);
    } catch (err) {
      if (err instanceof SampleCheckError) throw err;
      throw new SampleCheckError([
        `the e-print ${EVANS_OH_EPRINT} is not a usable tar: ${err.message}`,
      ]);
    }
    const target = join(stage, EVANS_OH_ZIP);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, packed.zip);
    log(
      `${packed.members.length} files, unchanged, in ${EVANS_OH_ZIP} (${formatMB(packed.zip.length)}):`
    );
    for (const m of packed.members) log(`  ${m.name}  ${m.bytes}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- the run ------------------------------------------------------------------------------------------------------

const STEPS = { regenerate, cache, assets };

/**
 * One sub-command over `sampleDir`, all or nothing. `ports`: `fetchImpl` (arXiv and ADS), `ingest(source, {outRoot,
 * docId, fetchImpl})`, `readToken()`, optional `tmpRoot` and `budgetBytes`. Returns `{code, sample, bytes}`; prints
 * through `log` (never a token).
 */
export async function runSampleCommand(command, sampleDir, ports, log = console.log) {
  if (!SUBCOMMANDS.includes(command)) {
    log(`usage: tutorial-sample.mjs <${SUBCOMMANDS.join("|")}> [--sample-dir <dir>]`);
    return { code: EXIT.usage };
  }
  const budget = ports.budgetBytes ?? SAMPLE_BUDGET_BYTES;
  const holder = mkdtempSync(join(dirname(sampleDir), `.${basename(sampleDir)}-staging-`));
  const stage = join(holder, "sample");
  try {
    const marker = readMarker(sampleDir);
    cpSync(sampleDir, stage, { recursive: true });
    await STEPS[command](stage, ports, log);
    const sample = marker.sample + 1;
    writeMarker(stage, sample);
    const bytes = directoryBytes(stage);
    log(`sample directory: ${formatMB(bytes)} (${bytes} bytes; budget ${formatMB(budget)})`);
    if (bytes > budget) {
      log(`OVER BUDGET: nothing was written`);
      return { code: EXIT.overBudget, bytes };
    }
    // Swap: the old sample moves into the holder, the staged one takes its place.
    const old = join(holder, "old");
    renameSync(sampleDir, old);
    try {
      renameSync(stage, sampleDir);
    } catch (err) {
      renameSync(old, sampleDir);
      throw err;
    }
    log(`${command}: done, sample ${marker.sample} → ${sample}`);
    return { code: EXIT.ok, sample, bytes };
  } catch (err) {
    const problems = err instanceof SampleCheckError ? err.problems : [String(err?.message ?? err)];
    for (const p of problems) log(`FAILED: ${p}`);
    log(`${command}: nothing was written`);
    return { code: EXIT.failed, problems };
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
}

/** sha256 of every file under `dir` (tests: "nothing was written"). */
export function treeDigest(dir) {
  const h = createHash("sha256");
  for (const f of listFiles(dir))
    h.update(f)
      .update("\0")
      .update(readFileSync(join(dir, f)));
  return h.digest("hex");
}
