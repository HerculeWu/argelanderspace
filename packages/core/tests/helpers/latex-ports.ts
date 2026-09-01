/**
 * Test-local implementations of the LaTeX pipeline ports
 * (`packages/core/src/pipelines/latex/ports.ts`). Core cannot import infra
 * (dependency direction is infra -> core), so the golden/unit tests wire their
 * own adapters:
 *
 * - **pandoc** — spawns the real `pandoc` binary with the exact CLI contract of
 *   infra's `latex/pandoc.ts` adapter (`-f latex -t json`, fragment wrap,
 *   `-f bibtex -t csljson`). The adapter's own edge cases are covered by
 *   infra's pandoc.test.ts; here we only need the stable CLI surface.
 * - **acquire** — resolves an arXiv id to the archived, trimmed source tree in
 *   `tests/fixtures/latex/<id>/` (figure bytes stubbed; rasterization is
 *   M2-tested in infra and only affects asset *files*, never the JSON), or a
 *   local .tex path for the unit fixtures. No network, no untar.
 * - **raster** — writes a fixed 1x1 PNG placeholder so the emitted `img_path`
 *   basename (the only thing the Document JSON records) is exercised through
 *   the real core AssetResolver locate/out_name logic.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LatexAcquisitionPort,
  LatexPandocPort,
  LatexRasterPort,
} from "../../src/pipelines/latex/ports.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const ASTRO_BIN = "/home/wwu/miniforge3/envs/astro/bin";
// Same hard floor as infra's latex/pandoc.ts (decision #9): pandoc < 3.9
// strips display-math environment shells and silently degrades every test
// that runs through latexToAst.
const PANDOC_MIN: readonly [number, number] = [3, 9];

interface PandocProbe {
  found: boolean;
  version: [number, number] | null;
}

function probePandoc(): PandocProbe {
  const r = spawnSync("pandoc", ["--version"], { encoding: "utf-8" });
  if (r.error || r.status !== 0) return { found: false, version: null };
  const m = /^pandoc\s+(\d+)\.(\d+)/.exec((r.stdout ?? "").split("\n", 1)[0] ?? "");
  return { found: true, version: m ? [Number(m[1]), Number(m[2])] : null };
}

function belowFloor(v: readonly [number, number] | null): boolean {
  return v === null || v[0] < PANDOC_MIN[0] || (v[0] === PANDOC_MIN[0] && v[1] < PANDOC_MIN[1]);
}

function pandocFloorError(): Error {
  return new Error(
    `pandoc ${probe.version?.join(".") ?? "with unparseable version"} on PATH is below the ` +
      `${PANDOC_MIN.join(".")} floor the LaTeX pipeline requires (older pandoc strips ` +
      "display-math environments). Run against a shim dir instead (do NOT prepend the whole " +
      `astro bin — its node v20 shadows the system node): mkdir -p /tmp/ms1-bin && ` +
      `ln -sf ${ASTRO_BIN}/pandoc /tmp/ms1-bin/pandoc && PATH=/tmp/ms1-bin:$PATH …`
  );
}

// Make the astro env's pandoc discoverable BEFORE collection: `skipIf` is
// evaluated when the test module loads, so a beforeAll would run too late.
let probe = probePandoc();
if (!probe.found && existsSync(`${ASTRO_BIN}/pandoc`)) {
  process.env.PATH = `${ASTRO_BIN}${delimiter}${process.env.PATH ?? ""}`;
  probe = probePandoc();
}
if (probe.found && belowFloor(probe.version)) {
  // A found-but-ancient pandoc (e.g. a system 3.1.3) used to be used
  // silently; that produced garbage ASTs. Fail loudly instead.
  throw pandocFloorError();
}
export const HAVE_PANDOC = probe.found;

// --------------------------------------------------------------------------- //
// pandoc (CLI contract mirrors infra's latex/pandoc.ts)
// --------------------------------------------------------------------------- //

function runPandoc(args: readonly string[], opts: { cwd?: string; stdin?: string } = {}): string {
  const proc = spawnSync("pandoc", [...args], {
    cwd: opts.cwd,
    input: opts.stdin,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (proc.error) throw new Error(`pandoc invocation failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    const tail = proc.stderr.trim().split("\n").slice(-3);
    throw new Error(tail.join("; ") || `pandoc rc=${proc.status}`);
  }
  return proc.stdout;
}

export const testPandoc: LatexPandocPort = {
  havePandoc: () => HAVE_PANDOC,
  assertPandocVersion() {
    if (!probe.found) throw new Error("pandoc is not on PATH");
    if (belowFloor(probe.version)) throw pandocFloorError();
  },
  latexToAst(mainTex) {
    const name = mainTex.split("/").pop() ?? mainTex;
    const arg = name.startsWith("-") ? `./${name}` : name;
    return JSON.parse(runPandoc(["-f", "latex", "-t", "json", arg], { cwd: dirname(mainTex) }));
  },
  fragmentToBlocks(latex, srcDir) {
    const doc = `\\documentclass{article}\\usepackage{amsmath}\\begin{document}\n${latex}\n\\end{document}\n`;
    try {
      const out = runPandoc(["-f", "latex", "-t", "json"], { cwd: srcDir, stdin: doc });
      const ast = JSON.parse(out) as { blocks?: unknown[] };
      return ast.blocks ?? [];
    } catch {
      return [];
    }
  },
  bibtexToCsl(bibFiles, srcDir) {
    const files = bibFiles.filter((f) => existsSync(f)).map((f) => resolve(f));
    if (files.length === 0) return [];
    try {
      const out = runPandoc(["-f", "bibtex", "-t", "csljson", ...files], { cwd: srcDir });
      const parsed: unknown = JSON.parse(out);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  },
};

// --------------------------------------------------------------------------- //
// acquisition (fixture-backed, offline)
// --------------------------------------------------------------------------- //

const ARXIV_ID_RE = /(\d{4}\.\d{4,5})(?:v\d+)?/;

interface FixtureManifest {
  arxiv_id: string;
  doc_id: string;
  origin: string;
  main_tex: string;
}

/** Acquire from the archived fixture tree (`fixtures/latex/<id>/`). */
function acquireArxiv(id: string, outRoot: string) {
  const fixtureDir = join(FIXTURES, "latex", id);
  const manifest = JSON.parse(
    readFileSync(join(fixtureDir, "source.json"), "utf-8")
  ) as FixtureManifest;
  const dest = join(outRoot, manifest.doc_id, "src");
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) {
    // The manifest is test scaffolding, not part of the arXiv source tree.
    cpSync(fixtureDir, dest, { recursive: true, filter: (src) => !src.endsWith("source.json") });
  }
  return {
    srcDir: dest,
    mainTex: join(dest, manifest.main_tex),
    docId: manifest.doc_id,
    arxivId: manifest.arxiv_id,
    origin: manifest.origin,
  };
}

function basenameOf(p: string): string {
  return p.split("/").pop() ?? p;
}

function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Minimal test-double for infra's findMainTex (unit fixtures are flat dirs). */
function findMainTex(dir: string): string {
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".tex")) continue;
    const text = readFileSync(join(dir, f), "utf-8");
    if (text.includes("\\documentclass") && text.includes("\\begin{document}")) {
      return join(dir, f);
    }
  }
  throw new Error(`no main .tex under ${dir}`);
}

/** Local .tex file / directory (the unit-test fixtures). */
function acquireLocal(p: string) {
  const abs = isAbsolute(p) ? p : resolve(p);
  if (statSync(abs).isDirectory()) {
    return {
      srcDir: abs,
      mainTex: findMainTex(abs),
      docId: `latex-${basenameOf(abs)}`,
      arxivId: null,
      origin: abs,
    };
  }
  return {
    srcDir: dirname(abs),
    mainTex: abs,
    docId: `latex-${stemOf(basenameOf(abs))}`,
    arxivId: null,
    origin: abs,
  };
}

export const testAcquire: LatexAcquisitionPort = (source, outRoot) => {
  const m = ARXIV_ID_RE.exec(source);
  if (m?.[1] !== undefined && existsSync(join(FIXTURES, "latex", m[1]))) {
    return Promise.resolve(acquireArxiv(m[1], outRoot));
  }
  if (existsSync(source)) {
    return Promise.resolve(acquireLocal(source));
  }
  return Promise.reject(
    new Error(`'${source}' is neither a fixture arXiv id nor an existing path`)
  );
};

// --------------------------------------------------------------------------- //
// rasterization (placeholder PNG; naming logic under test is in core's resolver)
// --------------------------------------------------------------------------- //

/** 1x1 transparent PNG, 68 bytes. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

function writeTinyPng(_src: string, dest: string): boolean {
  writeFileSync(dest, TINY_PNG);
  return true;
}

export const testRaster: LatexRasterPort = {
  pdfToPng: writeTinyPng,
  epsToPng: writeTinyPng,
};
