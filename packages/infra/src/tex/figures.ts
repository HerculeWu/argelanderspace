/**
 * Figure materialization (Stage 5 MS1, roadmap Q9): the {@link TexFigurePort}
 * implementation.
 *
 * - raster sources (png/jpg/jpeg/gif/webp) and .svg: byte-passthrough copy;
 * - .pdf: `dvisvgm --pdf` → SVG (text as paths, page 1);
 * - .eps: `dvisvgm --eps` → SVG.
 *
 * dvisvgm missing or any conversion failure degrades to `{ ok: false }`
 * (the caller keeps the figure block + caption without an image); this
 * module never throws.
 *
 * Output naming follows the Stage 3.1 convention
 * (`packages/core/src/pipelines/latex/assets.ts`): the source path relative
 * to srcDir, stemmed, "/" → "__", then `__<srcext>` + the output suffix —
 * `fig.pdf` → `fig__pdf.svg`, `fig.png` → `fig__png.png` — so a basename
 * shared across extensions can't collide onto one output file.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TexFigureOutcome, TexFigurePort, TexFigureRequest } from "@argelanderspace/core";
import { texFigureOutName } from "@argelanderspace/core";
import { findOnPath } from "../lib/proc.js";
import { runTexProcess, type TexProcResult } from "./proc.js";

const RASTER_EXTS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** dvisvgm conversions are sub-second; the bound only guards against hangs. */
const DVISVGM_TIMEOUT_MS = 30_000;

export function dvisvgmPath(): string | null {
  return findOnPath("dvisvgm");
}

export function haveDvisvgm(): boolean {
  return dvisvgmPath() !== null;
}

/**
 * Output basename for a figure source: relative-path stem with "__"
 * separators + `__<srcext>` + `suffix`. The convention is OWNED by core
 * (`@argelanderspace/core` `pipelines/tex/fuse/figures.ts`, MS2) — this
 * re-export keeps the port and its tests on one implementation.
 *
 * NOTE: the same convention exists in the retired Stage 3.1 `outName`
 * (`packages/core/src/pipelines/latex/assets.ts`) until MS3 deletes it.
 * All three share the inherited edge that `a/b.png` and `a__b.png` map to
 * the same output name — the "/" → "__" encoding is not injective (MS1
 * review N5).
 */
export { texFigureOutName };

async function convertVector(
  kind: "pdf" | "eps",
  src: string,
  dest: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!haveDvisvgm()) {
    return { ok: false, reason: "dvisvgm not on PATH; vector figure not converted" };
  }
  const args = [kind === "pdf" ? "--pdf" : "--eps", "--no-fonts", "-p", "1", "-o", dest, src];
  let result: TexProcResult;
  try {
    result = await runTexProcess("dvisvgm", args, { timeoutMs: DVISVGM_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: `dvisvgm invocation failed: ${String(err)}` };
  }
  const outStat = await fs.stat(dest).catch(() => null);
  if (result.timedOut || result.code !== 0 || !outStat?.isFile() || outStat.size === 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("; ");
    return {
      ok: false,
      reason:
        `dvisvgm ${kind}→svg failed` +
        (result.timedOut ? ` (timeout after ${DVISVGM_TIMEOUT_MS}ms)` : ` (exit ${result.code})`) +
        (detail ? `: ${detail}` : ""),
    };
  }
  return { ok: true };
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
