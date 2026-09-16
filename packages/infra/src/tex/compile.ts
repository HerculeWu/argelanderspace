/**
 * latexmk compile runner (Stage 5 MS1, roadmap Q4): the {@link TexCompilePort}
 * implementation.
 *
 * Flow (never compiles in the user's source tree):
 *   1. validate input (srcDir/mainTex exist, mainTex contained in srcDir,
 *      latexmk + at least one engine on PATH);
 *   2. pre-scan the source for shell-escape requirements (minted, raw
 *      \write18) → `unsupported-build` BEFORE compiling;
 *   3. instrumented attempts (generated wrapper + argelander.sty,
 *      `-jobname=<main base>` so artifact names are unchanged): pdflatex
 *      first (`latexmk -pdf`), xelatex retry (`latexmk -pdfxe`) on compile
 *      failure — always `-interaction=nonstopmode -recorder`, bibtex/biber
 *      via latexmk auto;
 *   4. instrumentation failure (wrapper compile broke for every engine, or
 *      the .sty asset is missing) → clean-compile fallback in a fresh
 *      workspace: success without the event stream plus a warning, NOT a
 *      hard failure;
 *   5. on success the engine-agnostic artifacts (.aux/.bbl/.toc/.lof/.lot/
 *      .fls/.argelander.jsonl) are collected into outDir (the future
 *      `<doc_id>/build/`); the .log is dropped on a clean success and kept
 *      only for degraded successes. Exit 0 with .aux/.fls missing counts as
 *      `compile-error`.
 *
 * A timeout SIGKILLs the latexmk process group → `compile-timeout` (no
 * engine retry: timeouts are document-intrinsic). Error excerpts are the
 * .log's `!` lines with `l.<n>` context, falling back to the raw tail.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  TexArtifacts,
  TexCompileInput,
  TexCompileOutcome,
  TexEngine,
} from "@argelanderspace/core";
import { TEX_COMPILE_DEFAULT_TIMEOUT_MS } from "@argelanderspace/core";
import { findOnPath } from "../lib/proc.js";
import { createCachedTexWorkspace } from "./cache.js";
import { prepareTexInstrumentation, texStyPath } from "./instrument.js";
import { runTexProcess } from "./proc.js";
import {
  createTexWorkspace,
  guardTexWorkspaceSize,
  type TexWorkspace,
  TexWorkspaceError,
} from "./workspace.js";

// --------------------------------------------------------------------------- //
// Toolchain discovery
// --------------------------------------------------------------------------- //

export function latexmkPath(): string | null {
  return findOnPath("latexmk");
}

export function haveLatexmk(): boolean {
  return latexmkPath() !== null;
}

export function haveTexEngine(engine: TexEngine): boolean {
  return findOnPath(engine) !== null;
}

// --------------------------------------------------------------------------- //
// Pre-scan: shell-escape requirements we do not support (Q4)
// --------------------------------------------------------------------------- //

/** Packages requiring unrestricted shell escape (minted pulls in pygmentize). */
const MINTED_RE = /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*\bminted\b[^}]*\}/;
/** Direct shell escape in user code. */
const WRITE18_RE = /\\write18\b/;

export interface UnsupportedHit {
  file: string;
  /** Matched source fragment (may span lines), comment-stripped, trimmed. */
  line: string;
  reason: string;
}

/**
 * Strip a TeX `%`-comment from one line. A `%` preceded by an even-length
 * run of backslashes (including none) starts the comment; `\%` is a literal
 * percent. Pairwise backslash scanning implements the even/odd rule
 * (`\\%` = newline command followed by a real comment).
 */
export function stripTexComment(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      const next = line[i + 1];
      if (next === undefined) {
        out += ch;
        i += 1;
      } else {
        out += ch + next;
        i += 2;
      }
      continue;
    }
    if (ch === "%") break;
    out += ch;
    i += 1;
  }
  return out;
}

/** The excerpt for a prescan hit: the matched fragment collapsed to one line. */
function hitExcerpt(content: string, match: RegExpExecArray): string {
  const start = content.lastIndexOf("\n", match.index) + 1;
  let end = content.indexOf("\n", match.index + match[0].length);
  if (end === -1) end = content.length;
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

async function prescanUnsupported(srcDir: string): Promise<UnsupportedHit | null> {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue; // the workspace copy refuses these anyway
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.(?:tex|sty|cls)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(srcDir);
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    // Comments are stripped per line first (a commented-out
    // `% \usepackage{minted}` must not reject a compilable doc), then the
    // regexes run over the WHOLE file so a multi-line
    // `\usepackage{%\n minted}` still matches.
    const content = raw.split("\n").map(stripTexComment).join("\n");
    const rel = path.relative(srcDir, file);
    const minted = MINTED_RE.exec(content);
    if (minted !== null) {
      return {
        file: rel,
        line: hitExcerpt(content, minted),
        reason: "the project requires the minted package (unrestricted shell escape)",
      };
    }
    const write18 = WRITE18_RE.exec(content);
    if (write18 !== null) {
      return {
        file: rel,
        line: hitExcerpt(content, write18),
        reason: "the project uses \\write18 (shell escape), which is not supported",
      };
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Error taxonomy helpers (log → excerpt)
// --------------------------------------------------------------------------- //

/**
 * The relevant tail of a TeX .log for error reporting: error lines (starting
 * with `!`) with the line after each (`l.<n> ...` context), plus standalone
 * `l.<n>` lines; the raw trailing ~`maxLines` lines when nothing matched.
 */
export function extractRelevantLogLines(log: string, maxLines = 30): string[] {
  const lines = log.split("\n");
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("!") || /^l\.\d+/.test(line)) {
      picked.push(line.trimEnd());
      const next = lines[i + 1];
      if (line.startsWith("!") && next !== undefined && !next.startsWith("!")) {
        picked.push(next.trimEnd());
        i += 1;
      }
    }
  }
  if (picked.length === 0) {
    return lines.slice(-maxLines).map((l) => l.trimEnd());
  }
  return picked.slice(-maxLines);
}

function missingFileFromLog(log: string): string | null {
  const m = /! LaTeX Error: File `([^']+)' not found/.exec(log);
  return m?.[1] ?? null;
}

function logHintsUnsupported(log: string): boolean {
  return /shell escape|\\write18|runsystem/.test(log) && /minted|restricted mode/.test(log);
}

// --------------------------------------------------------------------------- //
// Single compile attempt
// --------------------------------------------------------------------------- //

type AttemptStatus = "ok" | "compile-error" | "compile-timeout" | "unsupported-build";

interface AttemptResult {
  status: AttemptStatus;
  engine: TexEngine;
  message: string;
  excerpt: string;
  artifacts?: TexArtifacts;
  warnings: string[];
}

const ARTIFACT_EXTS = ["aux", "bbl", "toc", "lof", "lot", "fls"] as const;

/**
 * After a failed run, latexmk's recorded state can deadlock later compiles of
 * a STABLE cache dir: it reports "Nothing to do" while remembering "gave an
 * error in previous invocation", and a stale empty .bbl (e.g. from a citation
 * key typo) keeps failing pdflatex before bibtex ever reruns (Stage 12 field
 * evidence). Drop the run-state files so the next compile starts fresh.
 * Inputs (main.tex, .bib, assets) are never touched.
 */
async function clearLatexmkRunState(dir: string, jobname: string): Promise<void> {
  for (const ext of ["aux", "bbl", "blg", "fdb_latexmk", "log"]) {
    await fs.rm(path.join(dir, `${jobname}.${ext}`), { force: true });
  }
}

async function attemptCompile(opts: {
  srcDir: string;
  mainRel: string;
  jobname: string;
  outDir: string;
  engine: TexEngine;
  timeoutMs: number;
  instrumented: boolean;
  styPath: string | null;
  /** Degraded successes keep the engine .log in outDir for debugging. */
  keepLog?: boolean;
  cacheDir?: string;
  renderProfile?: "writer";
  signal?: AbortSignal;
}): Promise<AttemptResult> {
  opts.signal?.throwIfAborted();
  const fail = (
    status: Exclude<AttemptStatus, "ok">,
    message: string,
    excerpt = ""
  ): AttemptResult => ({ status, engine: opts.engine, message, excerpt, warnings: [] });

  let ws: TexWorkspace;
  try {
    ws = opts.cacheDir
      ? await createCachedTexWorkspace(
          opts.srcDir,
          path.join(opts.cacheDir, `${opts.engine}-${opts.instrumented ? "instrumented" : "clean"}`)
        )
      : await createTexWorkspace(opts.srcDir);
  } catch (err) {
    if (err instanceof TexWorkspaceError) {
      return fail("unsupported-build", `refusing to compile: ${err.message}`);
    }
    throw err;
  }

  try {
    const mainInWs = path.join(ws.dir, opts.mainRel);
    let target = mainInWs;
    if (opts.instrumented) {
      try {
        target = await prepareTexInstrumentation(
          mainInWs,
          opts.styPath ?? undefined,
          opts.renderProfile
        );
      } catch (err) {
        return fail(
          "compile-error",
          `instrumentation setup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const runDir = path.dirname(target);
    const args = [
      ...(opts.renderProfile === "writer" ? ["-norc"] : []),
      opts.engine === "xelatex" ? "-pdfxe" : "-pdf",
      "-interaction=nonstopmode",
      "-recorder",
      `-jobname=${opts.jobname}`,
      path.basename(target),
    ];
    const result = await runTexProcess("latexmk", args, {
      cwd: runDir,
      timeoutMs: opts.timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.signal?.throwIfAborted();

    const logPath = path.join(runDir, `${opts.jobname}.log`);
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    const mainBase = path.basename(opts.mainRel);

    if (result.timedOut) {
      await clearLatexmkRunState(runDir, opts.jobname);
      return fail(
        "compile-timeout",
        `TeX compilation timed out after ${opts.timeoutMs}ms (engine: ${opts.engine}, main: ${mainBase})`
      );
    }

    if (result.code !== 0) {
      await clearLatexmkRunState(runDir, opts.jobname);
      if (log && logHintsUnsupported(log)) {
        return fail(
          "unsupported-build",
          "the project appears to require shell escape, which is not supported"
        );
      }
      const logLines = extractRelevantLogLines(log || `${result.stdout}\n${result.stderr}`);
      const missingFile = log ? missingFileFromLog(log) : null;
      const summary = [
        `TeX compilation failed (engine: ${opts.engine}, main: ${mainBase}, exit code: ${
          result.code ?? result.signal ?? "?"
        })`,
        missingFile !== null ? `missing file/package: ${missingFile}` : null,
        logLines.length > 0 ? `relevant log lines:\n${logLines.join("\n")}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join("\n");
      return fail("compile-error", summary, logLines.join("\n"));
    }

    // Exit 0: the recorder + .aux must exist, otherwise the run was a no-op
    // (latexmk "nothing to do" on a stale workspace cannot happen here — the
    // workspace is fresh — so missing artifacts mean a real failure).
    const artifactPath = (ext: string): string => path.join(runDir, `${opts.jobname}.${ext}`);
    for (const required of ["aux", "fls"]) {
      const stat = await fs.stat(artifactPath(required)).catch(() => null);
      if (!stat?.isFile()) {
        return fail(
          "compile-error",
          `latexmk exited 0 but the expected artifact is missing: ${opts.jobname}.${required} ` +
            `(engine: ${opts.engine}, main: ${mainBase})`,
          extractRelevantLogLines(log).join("\n")
        );
      }
    }

    try {
      await guardTexWorkspaceSize(ws.dir);
    } catch (err) {
      if (err instanceof TexWorkspaceError) {
        return fail("unsupported-build", err.message);
      }
      throw err;
    }

    // Collect the engine-agnostic artifacts into outDir. The .log travels
    // only for degraded successes (instrumentation fallback); a clean
    // success deletes it (roadmap Q5).
    await fs.mkdir(opts.outDir, { recursive: true });
    const artifacts: TexArtifacts = {};
    for (const ext of ARTIFACT_EXTS) {
      const src = artifactPath(ext);
      const stat = await fs.stat(src).catch(() => null);
      if (!stat?.isFile()) continue;
      const dest = path.join(opts.outDir, `${opts.jobname}.${ext}`);
      await fs.copyFile(src, dest);
      artifacts[ext] = dest;
    }
    const eventsSrc = path.join(runDir, `${opts.jobname}.argelander.jsonl`);
    const eventsStat = await fs.stat(eventsSrc).catch(() => null);
    const warnings: string[] = [];
    let degraded = opts.keepLog === true;
    if (eventsStat?.isFile()) {
      const dest = path.join(opts.outDir, `${opts.jobname}.argelander.jsonl`);
      await fs.copyFile(eventsSrc, dest);
      artifacts.events = dest;
    } else if (opts.instrumented) {
      degraded = true;
      warnings.push(
        "instrumentation produced no event stream; cite/label/section/mathnum events " +
          "unavailable, numbering degrades to .aux + source counting"
      );
    }
    if (opts.renderProfile === "writer") {
      const src = artifactPath("argelander-citation.tex");
      if (
        await fs
          .stat(src)
          .then((s) => s.isFile())
          .catch(() => false)
      ) {
        const dest = path.join(opts.outDir, `${opts.jobname}.argelander-citation.tex`);
        await fs.copyFile(src, dest);
        artifacts.citationStyle = dest;
      }
    }
    // Reader's clean-success behavior is unchanged. Writer also inspects
    // undefined references and dependency warnings, so keeps its derived log.
    if ((degraded || opts.renderProfile === "writer") && log !== "") {
      const dest = path.join(opts.outDir, `${opts.jobname}.log`);
      await fs.writeFile(dest, log, "utf8");
      artifacts.log = dest;
    }
    return { status: "ok", engine: opts.engine, message: "", excerpt: "", artifacts, warnings };
  } finally {
    await ws.cleanup();
  }
}

// --------------------------------------------------------------------------- //
// Port implementation
// ---------------------------------------------------------------------------

export type TexCompileOptions = TexCompileInput & {
  /**
   * Override the shipped argelander.sty (tests force the instrumentation
   * fallback with a broken file here). `null` simulates a missing .sty
   * asset (the app-bundling hazard) — instrumentation is skipped entirely.
   */
  styPath?: string | null;
};

export async function compileTex(input: TexCompileOptions): Promise<TexCompileOutcome> {
  const timeoutMs = input.timeoutMs ?? TEX_COMPILE_DEFAULT_TIMEOUT_MS;
  const preferred: TexEngine = input.engine ?? "pdflatex";
  const other: TexEngine = preferred === "pdflatex" ? "xelatex" : "pdflatex";

  const unsupported = (message: string, excerpt = ""): TexCompileOutcome => ({
    ok: false,
    kind: "unsupported-build",
    message,
    excerpt,
  });
  const compileError = (message: string, excerpt = ""): TexCompileOutcome => ({
    ok: false,
    kind: "compile-error",
    message,
    excerpt,
  });

  if (!haveLatexmk()) {
    return unsupported("latexmk is not on PATH (required for TeX ingest: TeX Live)");
  }
  const engines = [preferred, other].filter((e) => haveTexEngine(e));
  if (engines.length === 0) {
    return unsupported(`neither ${preferred} nor ${other} is on PATH (required: TeX Live)`);
  }

  const srcStat = await fs.stat(input.srcDir).catch(() => null);
  if (!srcStat?.isDirectory()) {
    return compileError(`source directory does not exist: ${input.srcDir}`);
  }
  const mainStat = await fs.stat(input.mainTex).catch(() => null);
  if (!mainStat?.isFile()) {
    return compileError(`main .tex file does not exist: ${input.mainTex}`);
  }
  const srcRoot = await fs.realpath(input.srcDir);
  const mainRoot = await fs.realpath(input.mainTex);
  if (mainRoot !== srcRoot && !mainRoot.startsWith(srcRoot + path.sep)) {
    return compileError(`main .tex is not inside the source directory: ${input.mainTex}`);
  }
  const mainRel = path.relative(srcRoot, mainRoot);
  const jobname = path.basename(mainRoot).replace(/\.tex$/i, "");

  const hit = await prescanUnsupported(srcRoot);
  if (hit !== null) {
    return unsupported(`${hit.reason}: ${hit.file}`, hit.line);
  }

  const job = {
    srcDir: srcRoot,
    mainRel,
    jobname,
    outDir: input.outDir,
    timeoutMs,
    ...(input.cacheDir !== undefined ? { cacheDir: input.cacheDir } : {}),
    ...(input.renderProfile !== undefined ? { renderProfile: input.renderProfile } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const warnings: string[] = [];
  let lastError: AttemptResult | null = null;
  let firstInstrumentedError: AttemptResult | null = null;

  const noteEngineRetry = (engine: TexEngine): void => {
    if (engine !== preferred) {
      const firstLine = lastError?.excerpt.split("\n")[0];
      warnings.push(
        `${preferred} compile failed; artifacts produced by ${engine} retry` +
          (firstLine ? ` (first ${preferred} error: ${firstLine})` : "")
      );
    }
  };

  // Instrumented attempts (skipped entirely when the .sty asset is missing).
  const sty = input.styPath === undefined ? texStyPath() : input.styPath;
  if (sty !== null) {
    for (const engine of engines) {
      const r = await attemptCompile({ ...job, engine, instrumented: true, styPath: sty });
      if (r.status === "ok") {
        noteEngineRetry(engine);
        return {
          ok: true,
          engine: r.engine,
          artifacts: r.artifacts ?? {},
          warnings: [...warnings, ...r.warnings],
        };
      }
      if (r.status === "compile-timeout") {
        return { ok: false, kind: "compile-timeout", message: r.message, excerpt: r.excerpt };
      }
      if (r.status === "unsupported-build") {
        return { ok: false, kind: "unsupported-build", message: r.message, excerpt: r.excerpt };
      }
      lastError = r;
      firstInstrumentedError ??= r;
    }
    const firstLine = firstInstrumentedError?.excerpt.split("\n")[0];
    warnings.push(
      "instrumented compile failed for every engine; fell back to a clean compile — " +
        "cite/label/section/mathnum events unavailable, numbering degrades to .aux + " +
        "source counting" +
        (firstLine ? ` (first instrumented error: ${firstLine})` : "")
    );
  } else {
    warnings.push(
      "argelander.sty is missing (app bundling must carry this asset); clean compile — " +
        "cite/label/section/mathnum events unavailable, numbering degrades to .aux + source counting"
    );
  }

  // Clean-compile fallback in a fresh workspace.
  lastError = null;
  for (const engine of engines) {
    const r = await attemptCompile({
      ...job,
      engine,
      instrumented: false,
      styPath: null,
      keepLog: true,
    });
    if (r.status === "ok") {
      noteEngineRetry(engine);
      // Degraded success: keep the .log for debugging (it is only dropped
      // for a clean, fully instrumented success).
      return {
        ok: true,
        engine: r.engine,
        artifacts: r.artifacts ?? {},
        warnings: [...warnings, ...r.warnings],
      };
    }
    if (r.status === "compile-timeout") {
      return { ok: false, kind: "compile-timeout", message: r.message, excerpt: r.excerpt };
    }
    if (r.status === "unsupported-build") {
      return { ok: false, kind: "unsupported-build", message: r.message, excerpt: r.excerpt };
    }
    lastError ??= r;
  }

  const final = lastError;
  if (final !== null) {
    return { ok: false, kind: "compile-error", message: final.message, excerpt: final.excerpt };
  }
  return compileError("TeX compilation failed (no engine attempted)");
}

/** Structural check: compileTex satisfies the core port. */
export const texCompilePort: import("@argelanderspace/core").TexCompilePort = {
  compile: compileTex,
};

export interface TexCompileAttemptInput {
  srcDir: string;
  mainTex: string;
  outDir: string;
  engine?: TexEngine;
  timeoutMs?: number;
  /** Default true; false = clean compile (no wrapper, no event stream). */
  instrumented?: boolean;
  styPath?: string;
}

/**
 * A single compile attempt without the port's engine fallback and
 * instrumentation-fallback machinery — exported for the zero-interference
 * test (instrumented vs clean compile must produce identical .aux) and for
 * diagnostics.
 */
export async function compileTexAttempt(input: TexCompileAttemptInput): Promise<TexCompileOutcome> {
  const engine = input.engine ?? "pdflatex";
  const srcRoot = await fs.realpath(input.srcDir);
  const mainRoot = await fs.realpath(input.mainTex);
  const mainRel = path.relative(srcRoot, mainRoot);
  const jobname = path.basename(mainRoot).replace(/\.tex$/i, "");
  const instrumented = input.instrumented !== false;
  const r = await attemptCompile({
    srcDir: srcRoot,
    mainRel,
    jobname,
    outDir: input.outDir,
    engine,
    timeoutMs: input.timeoutMs ?? TEX_COMPILE_DEFAULT_TIMEOUT_MS,
    instrumented,
    styPath: instrumented ? (input.styPath ?? texStyPath()) : null,
    keepLog: !instrumented,
  });
  if (r.status === "ok") {
    return { ok: true, engine: r.engine, artifacts: r.artifacts ?? {}, warnings: r.warnings };
  }
  return { ok: false, kind: r.status, message: r.message, excerpt: r.excerpt };
}
