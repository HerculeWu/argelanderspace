/**
 * The Stage 5 (MS3a) wiring layer for the new tex pipeline — the
 * `latex/pipeline.ts` counterpart: compose core's `ingestTex` with the infra
 * adapters (latexmk compile, pdftocairo/gs figures, the arXiv e-print
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
import { type ExternalObserver, observedFetch } from "../lib/observe.js";
import { extractZip } from "../lib/unzip.js";
import { compileTex } from "./compile.js";
import type { TexFailureLogHook } from "./failure-log.js";
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
  /**
   * Told of the arXiv request and of every latexmk / pdftocairo / gs run (lib/observe.ts). The server hands in the
   * one that writes its user-level log; the CLI hands in none.
   */
  observer?: ExternalObserver;
  /**
   * Where the complete latexmk log is kept when the compile fails, and who is told (failure-log.ts). The server
   * hands one in per job; the CLI hands in none and keeps none.
   */
  failureLog?: TexFailureLogHook;
}

export interface TexIngestResult {
  ir: TexDocIr;
  warnings: string[];
  engine: string;
  /** Absolute path of the written `<docId>.json`. */
  jsonPath: string;
  docId: string;
}

const portsFor = (observer: ExternalObserver | undefined, failureLog?: TexFailureLogHook) =>
  ({
    compile: {
      compile: (input: Parameters<typeof compileTex>[0]) =>
        compileTex(input, failureLog === undefined ? { observer } : { observer, failureLog }),
    },
    figures: {
      materialize: (req: Parameters<typeof materializeTexFigure>[0]) =>
        materializeTexFigure(req, { observer }),
    },
  }) as const;

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
      ...(opts.fetchImpl !== undefined || opts.observer !== undefined
        ? { fetchImpl: observedFetch(opts.fetchImpl ?? fetch, "arxiv", opts.observer) }
        : {}),
    }),
    ...(opts.docId !== undefined ? { docId: opts.docId } : {}),
  });
  const buildDir = join(outRoot, src.docId, "build");
  const assetsDir = join(outRoot, src.docId, "assets");
  mkdirSync(buildDir, { recursive: true });
  const doAssets = opts.assets !== false;
  if (doAssets) mkdirSync(assetsDir, { recursive: true });
  const ports = portsFor(opts.observer, opts.failureLog);
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
 * Stage 15: fetch the LATEST arXiv e-print for `arxivId` and ingest it with
 * the doc id pinned — the attach/refresh primitive behind the server's
 * arXiv auto-ingest job (core `attachArxivDoc`). A refresh must really pick
 * up the latest version, so this never reads the on-disk e-print cache (a
 * successful download overwrites it) and wipes any previous
 * `<outRoot>/<docId>/src` tree before unpacking.
 */
export async function ingestArxivEprint(
  arxivId: string,
  opts: TexIngestZipOptions
): Promise<TexIngestResult> {
  rmSync(join(opts.outRoot, opts.docId, "src"), { recursive: true, force: true });
  return ingestTexSource(arxivId, { ...opts, noCache: true });
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
