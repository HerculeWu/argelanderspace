/**
 * Figure asset naming convention for the Stage 5 tex pipeline — owned by
 * core (the fuser predicts asset names; the infra `TexFigurePort` applies
 * the same convention mechanically). Mirrors the Stage 3.1 `outName`
 * (deleted with the old pipeline in MS3b; MS1 review N5: the "/" → "__"
 * encoding is not injective — `a/b.png` vs `a__b.png` collide — inherited,
 * not a regression).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Raster/SVG passthrough extensions (the rest convert to SVG). */
export const TEX_FIGURE_RASTER_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Output suffix for a source extension: ".svg" for vector (pdf/eps), own ext else. */
export function texFigureOutSuffix(srcExt: string): string {
  const e = srcExt.toLowerCase();
  return e === ".pdf" || e === ".eps" ? ".svg" : e;
}

/**
 * Output basename for a figure source: relative-path stem with "__"
 * separators + `__<srcext>` + `suffix` — `fig.pdf` → `fig__pdf.svg`,
 * `fig.png` → `fig__png.png` — so a basename shared across extensions
 * can't collide onto one output file.
 */
export function texFigureOutName(srcDir: string, src: string, suffix: string): string {
  const rel = path.relative(srcDir, src);
  const relPath =
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(src);
  const ext = path.extname(relPath);
  const stemmed = (ext ? relPath.slice(0, -ext.length) : relPath).split("/").join("__");
  const srcExt = path.extname(src).slice(1).toLowerCase() || "img";
  return `${stemmed}__${srcExt}${suffix}`;
}

// ---------------------------------------------------------------------------
// Materialized asset intrinsic size (Stage 6, jump accuracy)
// ---------------------------------------------------------------------------

/**
 * Intrinsic size (CSS px) of a materialized figure asset. For SVGs with
 * absolute root width/height (the only production-reachable shape — pdftocairo
 * always emits unitless absolute dims) this mirrors the browser's <img>
 * intrinsic-dimension rule exactly, including unit conversion. The viewBox
 * fallback is defensive only: browsers scale viewBox-only SVGs to the
 * container instead (so it does NOT mirror the browser there), and mixed
 * absolute/viewBox roots get both dims from the viewBox — both shapes can't
 * survive a real pdflatex compile as passthrough sources, so neither occurs
 * in practice. PNG dims come from the IHDR header. Best-effort — returns
 * undefined for unsupported formats (jpg/gif/webp passthrough) and unreadable
 * files (stub ports in tests may not write anything).
 */
export function texFigureAssetSize(filePath: string): { w: number; h: number } | undefined {
  try {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".svg")) return svgIntrinsicSize(fs.readFileSync(filePath, "utf8"));
    if (lower.endsWith(".png")) return pngIntrinsicSize(fs.readFileSync(filePath));
    return undefined;
  } catch {
    return undefined;
  }
}

const SVG_TAG_RE = /<svg\b([^>]*)>/;

const UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

function svgAttr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs)?.[1];
}

function lengthToPx(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^([\d.]+)\s*(px|pt|pc|in|cm|mm)?$/.exec(v.trim());
  if (m === null) return undefined; // "%" etc. → viewBox fallback
  const n = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * (UNIT_PX[m[2] ?? ""] ?? 1);
}

function svgIntrinsicSize(text: string): { w: number; h: number } | undefined {
  const tag = SVG_TAG_RE.exec(text.slice(0, 4096));
  if (tag === null) return undefined;
  const attrs = tag[1] ?? "";
  let w = lengthToPx(svgAttr(attrs, "width"));
  let h = lengthToPx(svgAttr(attrs, "height"));
  if (w === undefined || h === undefined) {
    const parts = (svgAttr(attrs, "viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number.parseFloat);
    const vw = parts[2];
    const vh = parts[3];
    if (
      parts.length !== 4 ||
      vw === undefined ||
      vh === undefined ||
      ![vw, vh].every((n) => Number.isFinite(n) && n > 0)
    ) {
      return undefined;
    }
    w = vw;
    h = vh;
  }
  return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

function pngIntrinsicSize(buf: Buffer): { w: number; h: number } | undefined {
  // 8-byte signature + 4-byte length + "IHDR" + u32 width + u32 height (BE)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : undefined;
}
