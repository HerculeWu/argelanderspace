/**
 * Stage 5 (MS1) compile-execution ports for the TeX pipeline
 * (`.kimi-code/memory/2026-09-04-stage5-roadmap.md`, Q4/Q9/Q10/Q11).
 *
 * The new `pipelines/tex` namespace compiles a LaTeX source tree with
 * latexmk inside an isolated workspace and consumes only engine-agnostic
 * artifacts (.aux/.bbl/.toc/.lof/.lot/.fls + the instrumentation event
 * stream `.argelander.jsonl`). Pure parsing of those artifacts lives in
 * `./facts/`; the side-effecting capabilities are injected through the
 * ports below, implemented by `@argelanderspace/infra` `tex/`:
 *
 * - {@link TexCompilePort} — the latexmk run itself (engine-flexible:
 *   pdflatex first, xelatex retry on compile failure; instrumentation
 *   failure degrades to a clean compile, never to a hard failure).
 * - {@link TexFigurePort} — figure materialization: raster/SVG byte
 *   passthrough, PDF/EPS vector conversion to SVG via pdftocairo (+ gs for
 *   EPS). Missing tools or a failed conversion degrade the figure (block +
 *   caption kept, no image), they never fail the ingest.
 *
 * Shapes here are structural twins of the infra adapters, so core never
 * imports infra (same convention as `pipelines/latex/ports.ts`).
 */

/** Compilation engines the white-listed toolchain supports (Q4). */
export type TexEngine = "pdflatex" | "xelatex";

/** Default per-attempt compile timeout (SIGKILL after expiry). */
export const TEX_COMPILE_DEFAULT_TIMEOUT_MS = 120_000;

export interface TexCompileInput {
  /** Directory holding the LaTeX source tree (never compiled in place). */
  srcDir: string;
  /** Absolute path of the driver .tex file inside `srcDir`. */
  mainTex: string;
  /**
   * Directory the engine-agnostic artifacts are collected into (the future
   * `<doc_id>/build/`). Created if missing.
   */
  outDir: string;
  /** Per-attempt timeout in ms; default {@link TEX_COMPILE_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** First engine to try; the other is retried on compile failure. Default pdflatex. */
  engine?: TexEngine;
}

/**
 * Artifacts collected into `outDir`, keyed by kind; values are absolute
 * paths. Absent key = the artifact was not produced (e.g. no .bbl without
 * a bibliography, no .toc without \tableofcontents) or, for `events`, the
 * instrumentation was unavailable and the run fell back to a clean compile.
 */
export interface TexArtifacts {
  aux?: string;
  bbl?: string;
  toc?: string;
  lof?: string;
  lot?: string;
  fls?: string;
  /** The `<jobname>.argelander.jsonl` instrumentation event stream. */
  events?: string;
  /**
   * The engine .log. Deleted on success (Q5); kept only when a degraded
   * success warrants later debugging. On failure the log's `!`-line excerpt
   * travels inside the failure outcome instead.
   */
  log?: string;
}

export type TexCompileFailureKind = "compile-error" | "compile-timeout" | "unsupported-build";

export type TexCompileOutcome =
  | {
      ok: true;
      /** The engine that actually produced the artifacts. */
      engine: TexEngine;
      artifacts: TexArtifacts;
      /**
       * Non-fatal degradations (engine retry succeeded, instrumentation
       * fell back to a clean compile, event stream missing, ...).
       */
      warnings: string[];
    }
  | {
      ok: false;
      kind: TexCompileFailureKind;
      message: string;
      /**
       * Relevant .log tail for the job error surface: `!` error lines with
       * their `l.<n>` context (falling back to the raw log tail).
       */
      excerpt: string;
    };

export interface TexCompilePort {
  compile(input: TexCompileInput): Promise<TexCompileOutcome>;
}

// --------------------------------------------------------------------------- //
// Figure materialization (Q9)
// --------------------------------------------------------------------------- //

export interface TexFigureRequest {
  /** Absolute path of the figure source file. */
  src: string;
  /** Source tree root; `src` must stay inside it (path containment). */
  srcDir: string;
  /** The assets directory the materialized file is written into. */
  destDir: string;
}

/**
 * Outcome of materializing one figure. `file` is the basename written under
 * `destDir`, named `<stem>__<srcext>.svg|.<ext>` following the Stage 3.1
 * convention (`pipelines/latex/assets.ts`): raster and .svg sources are
 * byte-passthrough copies, .pdf/.eps become pdftocairo/gs-converted SVG.
 */
export type TexFigureOutcome = { ok: true; file: string } | { ok: false; reason: string };

export interface TexFigurePort {
  /** Never throws: any failure degrades to `{ ok: false }`. */
  materialize(req: TexFigureRequest): Promise<TexFigureOutcome>;
}
