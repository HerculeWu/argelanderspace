/**
 * Port of `bibgraph/ingest_latex/fetch.py`: acquire and unpack an arXiv LaTeX
 * source package. Accepts an arXiv id (`2501.17225`, `arXiv:2501.17225v2`,
 * `astro-ph/0701001`), an arXiv URL (`/abs/`, `/pdf/`, `/e-print/`), or a
 * local path (a .tex file, a source directory, or a tarball). Downloads of
 * `https://arxiv.org/e-print/<id>` are cached on disk — the cache file naming
 * is byte-identical to the Python so existing `.latexcache` dirs are reused.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type FetchImpl, fetchBytes, Throttler } from "../lib/http.js";
import {
  extractTar,
  gunzipCapped,
  MAX_EXTRACT_BYTES,
  NotATarError,
  TarCorruptError,
} from "../lib/untar.js";

// Modern arXiv id (post-2007): YYMM.NNNNN, optional version. Old style:
// archive(.subclass)?/YYMMNNN.
const NEW_ID = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;
const OLD_ID = String.raw`[a-z][a-z\-\.]+/\d{7}(?:v\d+)?`;
const ID_RE = new RegExp(`^(?:${NEW_ID}|${OLD_ID})$`, "i");
const ARXIV_URL_RE = new RegExp(
  String.raw`arxiv\.org/(?:abs|pdf|e-print|format)/(${NEW_ID}|${OLD_ID})`,
  "i"
);
const ARXIV_PREFIX_RE = new RegExp(`^arxiv:\\s*(${NEW_ID}|${OLD_ID})$`, "i");

export const ARXIV_EPRINT = "https://arxiv.org/e-print/{id}";

/**
 * The arXiv submission has no usable LaTeX source (PDF-only). The message
 * text is byte-identical to the pre-Stage-15 plain `Error` (the CLI's
 * behaviour is unchanged); the dedicated type exists so the server can
 * classify the failure (`job.errorCode === "arxiv_pdf_only"`) and the web UI
 * can show targeted guidance without matching prose.
 */
export class ArxivPdfOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivPdfOnlyError";
  }
}

/** True for a bare arXiv id, an `arXiv:` prefix, or an arxiv.org URL. */
export function looksLikeArxiv(s: string): boolean {
  const t = s.trim();
  return ID_RE.test(t) || ARXIV_PREFIX_RE.test(t) || ARXIV_URL_RE.test(t);
}

/** Extract the canonical arXiv id (version kept) from any accepted form. */
export function arxivId(s: string): string | null {
  const t = s.trim();
  const prefix = ARXIV_PREFIX_RE.exec(t);
  if (prefix?.[1]) return prefix[1];
  const url = ARXIV_URL_RE.exec(t);
  if (url?.[1]) return url[1].replace(/\.pdf$/i, "");
  if (ID_RE.test(t)) return t;
  return null;
}

/**
 * The arXiv id from an EXPLICIT form only — the `arXiv:` prefix or an
 * arxiv.org URL (Stage 13 smoke decision: a bare id like `2609.17036` is
 * rejected as ambiguous in the manual-import UI; CLI ingest still accepts it).
 */
export function explicitArxivId(s: string): string | null {
  const t = s.trim();
  const prefix = ARXIV_PREFIX_RE.exec(t);
  if (prefix?.[1]) return prefix[1];
  const url = ARXIV_URL_RE.exec(t);
  if (url?.[1]) return url[1].replace(/\.pdf$/i, "");
  return null;
}

/**
 * Stable doc id. arXiv ids are namespaced `arxiv-<id>` so a LaTeX ingest never
 * collides with the same paper's PDF or HTML doc.
 */
export function docIdFor(arx: string | null, local: string | null): string {
  if (arx) {
    const safe = sanitize(arx).replace(/^[-._]+|[-._]+$/g, "");
    return `arxiv-${safe}`;
  }
  const stemRaw = local ? (isFile(local) ? stemOf(basename(local)) : basename(local)) : "document";
  const stem = sanitize(stemRaw).replace(/^[-._]+|[-._]+$/g, "");
  return stem ? `latex-${stem}` : "latex-document";
}

/** `re.sub(r"[^A-Za-z0-9._-]+", "-", s)` — the e-print cache filename sanitizer. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export interface LatexSource {
  /** Directory holding the unpacked .tex tree. */
  srcDir: string;
  /** The file carrying \documentclass + \begin{document}. */
  mainTex: string;
  docId: string;
  arxivId: string | null;
  /** The URL or local path we resolved. */
  origin: string;
}

export interface ArxivFetcherOptions {
  userAgent: string;
  timeout?: number;
  useCache?: boolean;
  /** Polite delay (s) between arXiv requests (Python `request_delay`, 1.0). */
  delay?: number;
  fetchImpl?: FetchImpl;
}

/** Downloads + caches arXiv e-print tarballs under a working directory. */
export class ArxivFetcher {
  private readonly cacheDir: string;
  private readonly userAgent: string;
  private readonly timeout: number;
  private readonly useCache: boolean;
  private readonly throttler: Throttler;
  private readonly fetchImpl: FetchImpl;

  constructor(cacheDir: string, opts: ArxivFetcherOptions) {
    this.cacheDir = cacheDir;
    mkdirSync(cacheDir, { recursive: true });
    this.userAgent = opts.userAgent;
    this.timeout = opts.timeout ?? 60;
    this.useCache = opts.useCache ?? true;
    this.throttler = new Throttler(opts.delay ?? 1.0);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Fetch `e-print/<id>` to a cached file; return its path. */
  async downloadEprint(arx: string): Promise<string> {
    const dest = join(this.cacheDir, `${sanitize(arx)}.tar.gz`);
    if (this.useCache && existsNonEmpty(dest)) return dest;
    const url = ARXIV_EPRINT.replace("{id}", arx);
    await this.throttler.wait();
    const { bytes } = await fetchBytes(this.fetchImpl, url, {
      headers: { "User-Agent": this.userAgent },
      timeout: this.timeout,
    });
    if (bytes.length === 0) throw new Error(`empty e-print response for ${arx}`);
    const tmp = `${dest}.part`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    return dest;
  }
}

/**
 * Unpack an arXiv source bundle (gzipped tar, plain tar, or a single gzipped
 * file) into `dest`. arXiv strips file extensions from single-file
 * submissions, so a lone gzip is materialised as `main.tex`.
 */
export function extractArxivSource(archive: string | Uint8Array, dest: string): void {
  const buf = typeof archive === "string" ? readFileBytes(archive) : archive;
  const name = typeof archive === "string" ? basename(archive) : "archive";
  mkdirSync(dest, { recursive: true });
  try {
    extractTar(buf, dest);
    return;
  } catch (e) {
    if (e instanceof TarCorruptError) {
      throw new Error(`${name} is a corrupt/truncated tar: ${e.message}`);
    }
    if (!(e instanceof NotATarError)) throw e;
  }
  // Not a tar: try a single gzipped member (arXiv's one-file submissions),
  // reading at most the cap + 1 byte so a gzip bomb can't exhaust memory.
  let data: Uint8Array;
  try {
    data = gunzipCapped(buf, MAX_EXTRACT_BYTES + 1);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `${name} decompresses beyond the size cap (${MAX_EXTRACT_BYTES}); refusing (bomb?).`
      );
    }
    throw new ArxivPdfOnlyError(
      `${name} is neither a tar nor a readable gzip stream (${String(e)}); ` +
        "the submission may be PDF-only (no LaTeX source)."
    );
  }
  const text = new TextDecoder("latin1").decode(data);
  if (!text.includes("\\documentclass") && !text.includes("\\begin{document}")) {
    throw new ArxivPdfOnlyError(`${name} unpacked to a non-LaTeX file (PDF-only source?).`);
  }
  writeFileSync(join(dest, "main.tex"), data);
}

// Files that are #included but are never themselves the driver.
const NOT_MAIN_RE = /(authors?|affil|institut)/i;

/** Pick the driver .tex: the one with `\documentclass` + `\begin{document}`. */
export function findMainTex(srcDir: string): string {
  const texs = rglob(srcDir)
    .filter((p) => p.endsWith(".tex"))
    .sort();
  if (texs.length === 0) throw new Error(`no .tex file found under ${srcDir}`);
  const scored: Array<{ score: number; path: string }> = [];
  for (const t of texs) {
    let head: string;
    try {
      head = readTextLossy(t);
    } catch {
      continue;
    }
    let score = 0;
    if (head.includes("\\begin{document}")) score += 100;
    if (head.includes("\\documentclass")) score += 50;
    if (NOT_MAIN_RE.test(basename(t))) score -= 200;
    score += Math.min(Math.floor(head.length / 4000), 20); // tie-break: prefer the big one
    scored.push({ score, path: t });
  }
  if (scored.length === 0) throw new Error(`no readable .tex file under ${srcDir}`);
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const best = scored[0];
  if (!best) throw new Error(`no readable .tex file under ${srcDir}`);
  return best.path;
}

/**
 * Resolve `source` (arXiv id/url or local path) to an unpacked LatexSource.
 * `workRoot` is the pipeline output root (Python `out_root`); extracted trees
 * land in `<workRoot>/<docId>/src`. A fixed `opts.docId` (the web-upload path
 * pre-extracts the zip there itself) short-circuits `docIdFor`.
 */
export async function acquireSource(
  source: string,
  workRoot: string,
  opts: { fetcher: ArxivFetcher; docId?: string }
): Promise<LatexSource> {
  const arx = arxivId(source);
  if (arx === null) {
    // Local path: a .tex, a directory, or a tarball.
    const p = resolve(expandUser(source));
    if (!existsSync(p)) {
      throw new Error(`'${source}' is neither an arXiv id/URL nor an existing path`);
    }
    const docId = opts.docId ?? docIdFor(null, p);
    if (statSync(p).isDirectory()) {
      return { srcDir: p, mainTex: findMainTex(p), docId, arxivId: null, origin: p };
    }
    if (p.toLowerCase().endsWith(".tex")) {
      return { srcDir: dirname(p), mainTex: p, docId, arxivId: null, origin: p };
    }
    const dest = join(workRoot, docId, "src");
    extractArxivSource(p, dest);
    return { srcDir: dest, mainTex: findMainTex(dest), docId, arxivId: null, origin: p };
  }

  const docId = opts.docId ?? docIdFor(arx, null);
  const archive = await opts.fetcher.downloadEprint(arx);
  const dest = join(workRoot, docId, "src");
  // Re-extract only when empty (cheap idempotence; the tarball itself is cached).
  if (!isDir(dest) || !rglob(dest).some((p) => p.endsWith(".tex"))) {
    extractArxivSource(archive, dest);
  }
  return {
    srcDir: dest,
    mainTex: findMainTex(dest),
    docId,
    arxivId: arx,
    origin: ARXIV_EPRINT.replace("{id}", arx),
  };
}

// --------------------------------------------------------------------------- //
// fs helpers
// --------------------------------------------------------------------------- //

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsNonEmpty(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

function rglob(root: string): string[] {
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

function readFileBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

/** `Path.read_text("utf-8", errors="replace")`. */
function readTextLossy(p: string): string {
  return new TextDecoder("utf-8").decode(readFileSync(p));
}
