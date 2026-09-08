/**
 * The Stage 5 (MS3a) wiring layer for the new tex pipeline — the
 * `latex/pipeline.ts` counterpart: compose core's `ingestTex` with the infra
 * adapters (latexmk compile, dvisvgm figures, the arXiv e-print
 * fetcher/extractor, the zip unpacker), and write the stored IR to
 * `<outRoot>/<docId>/<docId>.json`.
 *
 * On-disk layout per doc (roadmap Q12): `<doc_id>.json` (the stored IR),
 * `src/` (source tree, from acquisition), `build/` (engine-agnostic compile
 * artifacts), `assets/` (materialized figures).
 *
 * Progress stages surface through `onProgress` (the upload job's reporter /
 * the CLI's stderr): compile → fuse → figures; compile and fuse warnings are
 * reported back as `warning: …` progress lines so they reach the job log
 * (MS3 hazard #1).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TexDocIr } from "@argelanderspace/contracts";
import { ingestTex } from "@argelanderspace/core";
import { ArxivFetcher, acquireSource } from "../latex/arxiv-source.js";
import type { FetchImpl } from "../lib/http.js";
import { extractZip } from "../lib/unzip.js";
import { compileTex } from "./compile.js";
import { materializeTexFigure } from "./figures.js";

export interface TexIngestOptions {
  /** Pipeline output root (`<dataDir>/output`). */
  outRoot: string;
  /** Pinned doc id (upload); default: derived like the old pipeline. */
  docId?: string;
  /** Materialize figures into `assets/` (default true; false = --no-assets). */
  assets?: boolean;
  /** Ignore the on-disk arXiv fetch cache. */
  noCache?: boolean;
  /** Per-attempt compile timeout (default 120 s). */
  timeoutMs?: number;
  /** HTTP implementation for the arXiv fetcher (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Stage sink: compile/fuse/figures progress + warnings. */
  onProgress?: (message: string) => void;
}

export interface TexIngestResult {
  ir: TexDocIr;
  warnings: string[];
  engine: string;
  /** Absolute path of the written `<docId>.json`. */
  jsonPath: string;
  docId: string;
}

const ports = {
  compile: { compile: compileTex },
  figures: { materialize: materializeTexFigure },
} as const;

function reportWarnings(onProgress: ((m: string) => void) | undefined, warnings: string[]): void {
  if (onProgress === undefined) return;
  for (const w of warnings) onProgress(`warning: ${w}`);
}

/** arXiv id / URL / local .tex/dir/tarball → stored IR (writes the doc JSON). */
export async function ingestTexSource(
  source: string,
  opts: TexIngestOptions
): Promise<TexIngestResult> {
  const outRoot = opts.outRoot;
  const src = await acquireSource(source, outRoot, {
    fetcher: new ArxivFetcher(join(outRoot, ".latexcache"), {
      // same UA the pandoc-era config used (polite-pool etiquette)
      userAgent: "bibgraph/0.1 (https://arxiv.org; mailto:wuwenjiegogo@gmail.com)",
      useCache: !(opts.noCache ?? false),
    }),
    ...(opts.docId !== undefined ? { docId: opts.docId } : {}),
  });
  const buildDir = join(outRoot, src.docId, "build");
  const assetsDir = join(outRoot, src.docId, "assets");
  mkdirSync(buildDir, { recursive: true });
  const doAssets = opts.assets !== false;
  if (doAssets) mkdirSync(assetsDir, { recursive: true });
  opts.onProgress?.("Compiling LaTeX (latexmk)");
  const r = await ingestTex(
    {
      srcDir: src.srcDir,
      mainTex: src.mainTex,
      docId: src.docId,
      origin: src.origin,
      arxivId: src.arxivId,
      buildDir,
      ...(doAssets ? { assetsDir } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
    doAssets ? ports : { compile: ports.compile }
  );
  opts.onProgress?.("Fusing source tree + compiler facts into IR");
  if (doAssets) opts.onProgress?.("Materializing figures");
  const jsonPath = join(outRoot, src.docId, `${src.docId}.json`);
  writeFileSync(jsonPath, JSON.stringify(r.ir, null, 2), "utf-8");
  reportWarnings(opts.onProgress, r.warnings);
  return { ir: r.ir, warnings: r.warnings, engine: r.engine, jsonPath, docId: src.docId };
}

export interface TexIngestZipOptions extends Omit<TexIngestOptions, "docId"> {
  /** Pinned doc id (idempotent upload: the same work always maps to it). */
  docId: string;
}

/**
 * Unpack a user-supplied LaTeX source zip and ingest it in directory mode —
 * the web-upload path (`IngestPipelines.ingestLatexZip`). A re-upload clears
 * `<outRoot>/<docId>/src` before unpacking, so the doc is overwritten in
 * place, exactly like a re-fetched arXiv tarball.
 */
export async function ingestTexZip(
  zipPath: string,
  opts: TexIngestZipOptions
): Promise<TexIngestResult> {
  const srcDir = join(opts.outRoot, opts.docId, "src");
  rmSync(srcDir, { recursive: true, force: true });
  extractZip(new Uint8Array(readFileSync(zipPath)), srcDir);
  return ingestTexSource(srcDir, opts);
}
