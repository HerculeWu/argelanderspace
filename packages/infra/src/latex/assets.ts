/**
 * Port of `bibgraph/ingest_latex/assets.py`: resolve `\includegraphics`
 * targets to served PNGs — vector PDF via mupdf, EPS/PS via Ghostscript,
 * already-raster figures copied through. Output lands in the doc's `assets/`
 * dir and is served by `/images/<doc_id>/<file>` like the other pipelines.
 *
 * Bug-for-bug notes: the `_TRY_EXT` probe order, the first-wins basename
 * index, the `_within` containment guard (a crafted `../../etc/x` must never
 * be served through /images), and the `stem__ext.png` output naming are all
 * preserved verbatim. Failures warn and return undefined; a figure never
 * aborts an ingest.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { epsToPng, pdfToPng } from "../pdf/raster.js";

const RASTER = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VECTOR_PDF = new Set([".pdf"]);
const VECTOR_EPS = new Set([".eps", ".ps"]);
/** Extensions \includegraphics omits, in the order TeX would try them. */
const TRY_EXT = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".gif", ".PDF", ".PNG"];

/** `Path(p).is_relative_to(base.resolve())` on resolved paths (blocks `../` + symlink escape). */
function within(base: string, p: string): boolean {
  try {
    const rel = relative(realpathSync(base), realpathSync(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** `Path(name).stem` — basename minus its last extension. */
function stemOf(name: string): string {
  const base = basename(name);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** Recursive file list (`Path.rglob("*")` filtered to files). */
function rglobFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

export interface AssetResolverOptions {
  /** Raster DPI for vector figures (Python `figure_dpi`, default 200). */
  dpi?: number;
  /** Longest-side cap in px (Python `figure_max_px`, default 2200). */
  maxPx?: number;
  /** When false, every lookup returns undefined (download_assets=False). */
  enabled?: boolean;
  log?: (msg: string) => void;
}

/** Resolves a graphics path argument to a served asset basename (cached). */
export class AssetResolver {
  private readonly srcDir: string;
  private readonly assetDir: string;
  private readonly dpi: number;
  private readonly maxPx: number;
  private readonly enabled: boolean;
  private readonly log?: (msg: string) => void;
  private readonly cache = new Map<string, string | undefined>();
  private byName: Map<string, string> | undefined;

  constructor(srcDir: string, assetDir: string, opts: AssetResolverOptions = {}) {
    this.srcDir = srcDir;
    this.assetDir = assetDir;
    this.dpi = opts.dpi ?? 200;
    this.maxPx = opts.maxPx ?? 2200;
    this.enabled = opts.enabled ?? true;
    this.log = opts.log;
  }

  // -- locate ------------------------------------------------------------- //
  private index(): Map<string, string> {
    if (this.byName === undefined) {
      this.byName = new Map();
      for (const p of rglobFiles(this.srcDir)) {
        const name = basename(p);
        if (!this.byName.has(name)) this.byName.set(name, p);
        const stem = stemOf(name);
        if (!this.byName.has(stem)) this.byName.set(stem, p);
      }
    }
    return this.byName;
  }

  private locate(arg: string): string | undefined {
    const cleaned = arg.trim().replaceAll('"', "").replaceAll("\\", "/");
    const cand = join(this.srcDir, cleaned);
    if (isFile(cand)) return cand;
    for (const ext of TRY_EXT) {
      const withExt = join(this.srcDir, cleaned + ext);
      if (isFile(withExt)) return withExt;
    }
    // last resort: match by basename anywhere in the tree
    const idx = this.index();
    return idx.get(basename(cleaned)) ?? idx.get(stemOf(cleaned));
  }

  // -- public ------------------------------------------------------------- //
  /** Return a basename under `assets/` for `arg`, or undefined if unusable. */
  image(arg: string): string | undefined {
    if (!arg || !this.enabled) return undefined;
    if (this.cache.has(arg)) return this.cache.get(arg);
    const out = this.resolve(arg);
    this.cache.set(arg, out);
    return out;
  }

  private outName(src: string, suffix: string): string {
    const rel = relative(this.srcDir, src);
    const relPath = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(src);
    // Encode the source extension so e.g. fig.pdf and fig.png (which the
    // reader resolves by basename) can't collide onto one output file.
    const ext = extname(relPath);
    const stemmed = (ext ? relPath.slice(0, -ext.length) : relPath).split("/").join("__");
    const srcExt = extname(src).slice(1).toLowerCase() || "img";
    return `${stemmed}__${srcExt}${suffix}`;
  }

  private resolve(arg: string): string | undefined {
    const src = this.locate(arg);
    if (src === undefined) {
      this.log?.(`figure not found: ${arg}`);
      return undefined;
    }
    // A \includegraphics path must stay inside the source tree — never let a
    // crafted "../../etc/x" disclose a host file through the /images route.
    if (!within(this.srcDir, src)) {
      this.log?.(`figure path escapes source tree, ignored: ${arg}`);
      return undefined;
    }
    const ext = extname(src).toLowerCase();
    try {
      mkdirSync(this.assetDir, { recursive: true });
      if (RASTER.has(ext)) {
        const dest = join(this.assetDir, this.outName(src, ext));
        if (!existsNonEmpty(dest)) copyFileSync(src, dest);
        return basename(dest);
      }
      const dest = join(this.assetDir, this.outName(src, ".png"));
      if (existsNonEmpty(dest)) return basename(dest);
      if (VECTOR_PDF.has(ext) && pdfToPng(src, dest, { dpi: this.dpi, maxPx: this.maxPx })) {
        return basename(dest);
      }
      if (VECTOR_EPS.has(ext) && epsToPng(src, dest, { dpi: this.dpi, log: this.log })) {
        return basename(dest);
      }
      this.log?.(`unhandled figure type ${ext} (${basename(src)})`);
    } catch (e) {
      // never abort ingest on a figure
      this.log?.(`rasterise failed for ${basename(src)}: ${String(e)}`);
    }
    return undefined;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsNonEmpty(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}
