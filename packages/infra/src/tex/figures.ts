/**
 * Figure materialization (Stage 5 MS1, roadmap Q9 — amended after smoke R1):
 * the {@link TexFigurePort} implementation.
 *
 * - raster sources (png/jpg/jpeg/gif/webp) and .svg: byte-passthrough copy;
 * - .pdf: `pdftocairo -svg` (poppler) → SVG (first page);
 * - .eps: two-step — `gs -sDEVICE=pdfwrite` (Ghostscript) → tmp PDF, then
 *   `pdftocairo -svg`.
 *
 * Smoke round 1 replaced dvisvgm with pdftocairo: `dvisvgm --pdf --no-fonts`
 * is not faithful on real figure PDFs (all text lost — 32k paths but zero
 * rendered glyphs in a real browser — and embedded raster XObjects dropped
 * wholesale), while `pdftocairo -svg` renders pixel-faithfully. The trivial
 * one-triangle fixture could not catch that; the fixtures here are real
 * matplotlib PDFs with text and an embedded raster.
 *
 * pdftocairo/gs missing or any conversion failure degrades to
 * `{ ok: false }` (the caller keeps the figure block + caption without an
 * image); this module never throws.
 *
 * Output naming follows the Stage 3.1 convention (owned by core in
 * `packages/core/src/pipelines/tex/fuse/figures.ts`): the source path relative
 * to srcDir, stemmed, "/" → "__", then `__<srcext>` + the output suffix —
 * `fig.pdf` → `fig__pdf.svg`, `fig.png` → `fig__png.png` — so a basename
 * shared across extensions can't collide onto one output file.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { TexFigureOutcome, TexFigurePort, TexFigureRequest } from "@argelanderspace/core";
import { texFigureOutName } from "@argelanderspace/core";
import { findOnPath } from "../lib/proc.js";
import { runTexProcess, type TexProcResult } from "./proc.js";

const RASTER_EXTS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** pdftocairo/gs conversions are seconds at most; the bound only guards against hangs. */
const CONVERT_TIMEOUT_MS = 60_000;

export function pdftocairoPath(): string | null {
  return findOnPath("pdftocairo");
}

export function havePdftocairo(): boolean {
  return pdftocairoPath() !== null;
}

export function ghostscriptPath(): string | null {
  return findOnPath("gs");
}

export function haveGhostscript(): boolean {
  return ghostscriptPath() !== null;
}

/**
 * Output basename for a figure source: relative-path stem with "__"
 * separators + `__<srcext>` + `suffix`. The convention is OWNED by core
 * (`@argelanderspace/core` `pipelines/tex/fuse/figures.ts`, MS2) — this
 * re-export keeps the port and its tests on one implementation.
 *
 * NOTE: the inherited edge that `a/b.png` and `a__b.png` map to the same
 * output name stands — the "/" → "__" encoding is not injective (MS1
 * review N5).
 */
export { texFigureOutName };

async function runStep(
  cmd: string,
  args: readonly string[],
  label: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let result: TexProcResult;
  try {
    result = await runTexProcess(cmd, args, { timeoutMs: CONVERT_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: `${label} invocation failed: ${String(err)}` };
  }
  if (result.timedOut || result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("; ");
    return {
      ok: false,
      reason:
        `${label} failed` +
        (result.timedOut ? ` (timeout after ${CONVERT_TIMEOUT_MS}ms)` : ` (exit ${result.code})`) +
        (detail ? `: ${detail}` : ""),
    };
  }
  return { ok: true };
}

async function producedFile(p: string): Promise<boolean> {
  const stat = await fs.stat(p).catch(() => null);
  return stat?.isFile() === true && stat.size > 0;
}

/** `pdftocairo -svg <src> <dest>` — writes `<dest>` exactly as named (first page only). */
async function pdfToSvg(
  src: string,
  dest: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ran = await runStep("pdftocairo", ["-svg", src, dest], "pdftocairo pdf→svg");
  if (!ran.ok) return ran;
  if (!(await producedFile(dest))) {
    return { ok: false, reason: "pdftocairo pdf→svg produced no output file" };
  }
  return { ok: true };
}

/**
 * EPS → SVG in two steps: Ghostscript `pdfwrite` (the old pipeline's EPS
 * practice: `-dSAFER -dEPSCrop`, absolute source path) into a temp PDF, then
 * the pdftocairo route above.
 */
async function epsToSvg(
  src: string,
  dest: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!haveGhostscript()) {
    return { ok: false, reason: "gs (ghostscript) not on PATH; EPS figure not converted" };
  }
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "tex-eps-"));
  const tmpPdf = path.join(tmp, "in.pdf");
  try {
    const gs = await runStep(
      "gs",
      [
        "-q",
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dEPSCrop",
        "-sDEVICE=pdfwrite",
        `-sOutputFile=${tmpPdf}`,
        src,
      ],
      "gs eps→pdf"
    );
    if (!gs.ok) return gs;
    if (!(await producedFile(tmpPdf))) {
      return { ok: false, reason: "gs eps→pdf produced no output file" };
    }
    return await pdfToSvg(tmpPdf, dest);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertVector(
  kind: "pdf" | "eps",
  src: string,
  dest: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!havePdftocairo()) {
    return {
      ok: false,
      reason: "pdftocairo (poppler-utils) not on PATH; vector figure not converted",
    };
  }
  return kind === "pdf" ? pdfToSvg(src, dest) : epsToSvg(src, dest);
}

export async function materializeTexFigure(req: TexFigureRequest): Promise<TexFigureOutcome> {
  try {
    const stat = await fs.stat(req.src).catch(() => null);
    if (!stat?.isFile()) {
      return { ok: false, reason: `figure not found: ${req.src}` };
    }
    const srcRoot = await fs.realpath(req.srcDir).catch(() => path.resolve(req.srcDir));
    const srcReal = await fs.realpath(req.src).catch(() => path.resolve(req.src));
    const rel = path.relative(srcRoot, srcReal);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, reason: `figure path escapes the source tree, ignored: ${req.src}` };
    }
    const ext = path.extname(req.src).toLowerCase();
    await fs.mkdir(req.destDir, { recursive: true });

    if (RASTER_EXTS.has(ext) || ext === ".svg") {
      const dest = path.join(req.destDir, texFigureOutName(srcRoot, srcReal, ext));
      await fs.copyFile(srcReal, dest);
      return { ok: true, file: path.basename(dest) };
    }
    if (ext === ".pdf" || ext === ".eps") {
      const dest = path.join(req.destDir, texFigureOutName(srcRoot, srcReal, ".svg"));
      const converted = await convertVector(ext === ".pdf" ? "pdf" : "eps", srcReal, dest);
      if (!converted.ok) return { ok: false, reason: converted.reason };
      return { ok: true, file: path.basename(dest) };
    }
    return { ok: false, reason: `unsupported figure type: ${ext || "(no extension)"}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Structural check: materializeTexFigure satisfies the core port. */
export const texFigurePort: TexFigurePort = { materialize: materializeTexFigure };
