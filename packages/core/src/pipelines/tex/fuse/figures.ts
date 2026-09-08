/**
 * Figure asset naming convention for the Stage 5 tex pipeline — owned by
 * core (the fuser predicts asset names; the infra `TexFigurePort` applies
 * the same convention mechanically). Mirrors the Stage 3.1 `outName`
 * (deleted with the old pipeline in MS3b; MS1 review N5: the "/" → "__"
 * encoding is not injective — `a/b.png` vs `a__b.png` collide — inherited,
 * not a regression).
 */
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
