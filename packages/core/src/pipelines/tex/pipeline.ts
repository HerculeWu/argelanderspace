/**
 * Stage 5 tex pipeline composition (roadmap MS2):
 *
 *     source tree (source/tree.ts: parse + \input merge + bounded macros)
 *      ├─ compile (TexCompilePort → <doc_id>/build artifacts)   [pipeline]
 *      ├─ facts   (facts/: .aux/.bbl/.toc/.fls/.argelander.jsonl)
 *      └─ fuse    (fuse/: structure + numbering + cite/xref) →
 *     buildTexDocIr → TexDocIr (validated) — writing <doc_id>.json stays
 *     caller-side.
 *
 * `ingestTex` runs the full compile-driven flow; `fuseTexDoc` skips the
 * compiler and consumes GIVEN artifact files (the frozen-fixture path for
 * unit tests and the golden freeze's deterministic re-run gate).
 */
import { basename } from "node:path";
import type { TexDocIr, TexIrSource } from "@argelanderspace/contracts";
import type { TexFactFiles, TexFacts } from "./facts/index.js";
import { parseTexFacts } from "./facts/index.js";
import { buildTexDocIr } from "./ir.js";
import type { TexCompilePort, TexFigurePort } from "./ports.js";
import { loadTexSourceTree } from "./source/tree.js";

export interface TexPipelinePorts {
  compile: TexCompilePort;
  figures?: TexFigurePort;
}

export interface IngestTexInput {
  srcDir: string;
  mainTex: string;
  docId: string;
  /** The URL or local path we resolved (identity). */
  origin: string;
  arxivId?: string | null;
  doi?: string;
  publisher?: string;
  /** Artifact dir (the future `<doc_id>/build/`). */
  buildDir: string;
  /** Figure asset dir (the future `<doc_id>/assets/`); absent = no images. */
  assetsDir?: string;
  timeoutMs?: number;
}

export interface IngestTexResult {
  ir: TexDocIr;
  warnings: string[];
  engine: string;
}

/** Full compile-driven ingest. Throws on hard compile failure. */
export async function ingestTex(
  input: IngestTexInput,
  ports: TexPipelinePorts
): Promise<IngestTexResult> {
  const outcome = await ports.compile.compile({
    srcDir: input.srcDir,
    mainTex: input.mainTex,
    outDir: input.buildDir,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!outcome.ok) {
    throw new Error(
      `${input.docId}: TeX compile failed (${outcome.kind}): ${outcome.message}\n${outcome.excerpt}`
    );
  }
  const facts = parseTexFacts(outcome.artifacts);
  const tree = loadTexSourceTree({
    srcDir: input.srcDir,
    mainTex: input.mainTex,
    flsInputs: facts.inputs,
  });
  const source = texIrSource(input);
  const { ir, warnings } = await buildTexDocIr({
    tree,
    facts,
    docId: input.docId,
    source,
    engine: outcome.engine,
    eventsAvailable: outcome.artifacts.events !== undefined,
    figures: ports.figures,
    assetsDir: input.assetsDir,
    srcDir: input.srcDir,
  });
  return {
    ir,
    warnings: [...outcome.warnings, ...warnings],
    engine: outcome.engine,
  };
}

// --------------------------------------------------------------------------- //
// fuseTexDoc — the compiler-free path (frozen artifacts / tests)
// --------------------------------------------------------------------------- //

export interface FuseTexDocInput {
  srcDir: string;
  mainTex: string;
  docId: string;
  origin: string;
  arxivId?: string | null;
  doi?: string;
  publisher?: string;
  engine?: string;
  /** Frozen artifact paths (parseTexFacts input). */
  factFiles: TexFactFiles;
  /** Figure port + asset dir for materialization; absent = no images. */
  figures?: TexFigurePort;
  assetsDir?: string;
}

export interface FuseTexDocResult {
  ir: TexDocIr;
  warnings: string[];
  facts: TexFacts;
}

export async function fuseTexDoc(input: FuseTexDocInput): Promise<FuseTexDocResult> {
  const facts = parseTexFacts(input.factFiles);
  const tree = loadTexSourceTree({
    srcDir: input.srcDir,
    mainTex: input.mainTex,
    flsInputs: facts.inputs,
  });
  const { ir, warnings } = await buildTexDocIr({
    tree,
    facts,
    docId: input.docId,
    source: texIrSource(input),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    eventsAvailable: input.factFiles.events !== undefined,
    figures: input.figures,
    assetsDir: input.assetsDir,
    srcDir: input.srcDir,
  });
  return { ir, warnings, facts };
}

function texIrSource(input: {
  mainTex: string;
  origin: string;
  arxivId?: string | null;
  doi?: string;
  publisher?: string;
}): TexIrSource {
  const source: TexIrSource = {
    type: "latex",
    origin: input.origin,
    main_tex: basename(input.mainTex),
  };
  if (input.arxivId !== undefined && input.arxivId !== null && input.arxivId !== "") {
    source.arxiv_id = input.arxivId;
  }
  if (input.doi !== undefined) source.doi = input.doi;
  if (input.publisher !== undefined) source.publisher = input.publisher;
  return source;
}
