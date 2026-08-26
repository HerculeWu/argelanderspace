/**
 * Port of `bibgraph/ingest_html/fetch.py`: fetching + on-disk caching for
 * publisher HTML. Accepts a DOI or a publisher URL, resolves it to the
 * full-text HTML page, and caches every network response (main page, per-float
 * sub-pages, images) under the document's output dir so re-runs are offline.
 *
 * Parity notes:
 * - Cache filenames are `sha1(url)[:16]` + `.html`/`.url`, byte-identical to
 *   the Python — existing `.htmlcache` directories are reused.
 * - HTML parsing is cheerio (decision 11), replacing BeautifulSoup
 *   `html.parser`. Both are lenient HTML5-ish parsers, but DOM details can
 *   differ (e.g. optional-tag insertion); any observable delta surfaces in the
 *   M3 golden diffs.
 * - `Fetcher._throttle` IS a since-last-request throttle (unlike the sources'
 *   fixed sleep).
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { type FetchImpl, fetchStreamedBytes, fetchText, Throttler } from "../lib/http.js";
import { sha1Hex } from "../sources/cache.js";

// A bare DOI: "10.<registrant>/<suffix>" (suffix may contain almost anything).
const DOI_RE = /^10\.\d{4,9}\/\S+$/;
// A DOI embedded in a doi.org URL.
const DOI_URL_RE = /doi\.org\/(10\.\d{4,9}\/\S+)$/i;

export function looksLikeDoi(s: string): boolean {
  return DOI_RE.test(s.trim());
}

/** Turn a DOI / doi.org URL / publisher URL into a fetchable URL. */
export function normalizeSource(source: string): string {
  const s = source.trim();
  if (looksLikeDoi(s)) return `https://doi.org/${s}`;
  const m = DOI_URL_RE.exec(s);
  if (m?.[1]) return `https://doi.org/${m[1]}`;
  if (!s.startsWith("http://") && !s.startsWith("https://")) {
    // bare host/path or unknown token — assume https
    return `https://${s}`;
  }
  return s;
}

export interface FetcherOptions {
  userAgent: string;
  timeout?: number; // 30
  useCache?: boolean; // true
  /** Polite delay (s) between requests (Python `request_delay`, 0.3). */
  delay?: number;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

/** A caching HTTP client scoped to one document's working directory. */
export class Fetcher {
  private readonly cacheDir: string;
  private readonly userAgent: string;
  private readonly timeout: number;
  private readonly useCache: boolean;
  private readonly throttler: Throttler;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(cacheDir: string, opts: FetcherOptions) {
    this.cacheDir = cacheDir;
    mkdirSync(cacheDir, { recursive: true });
    this.userAgent = opts.userAgent;
    this.timeout = opts.timeout ?? 30;
    this.useCache = opts.useCache ?? true;
    this.throttler = new Throttler(opts.delay ?? 0.3);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  private cachePath(key: string, suffix: string): string {
    return join(this.cacheDir, `${sha1Hex(key).slice(0, 16)}${suffix}`);
  }

  // -- text pages --------------------------------------------------------- //
  /** Return `{ finalUrl, text }`; cached by URL on disk. */
  async get(url: string): Promise<{ finalUrl: string; text: string }> {
    const cache = this.cachePath(url, ".html");
    const meta = this.cachePath(url, ".url");
    if (this.useCache && isFile(cache) && isFile(meta)) {
      this.log?.(`cache hit ${url}`);
      return {
        finalUrl: readFileSync(meta, "utf-8").trim(),
        text: readFileSync(cache, "utf-8"),
      };
    }
    await this.throttler.wait();
    this.log?.(`GET ${url}`);
    const { finalUrl, text } = await fetchText(this.fetchImpl, url, {
      headers: { "User-Agent": this.userAgent },
      timeout: this.timeout,
    });
    // Python writes the cache non-atomically (write_text) — kept as-is.
    writeFileSync(cache, text, "utf-8");
    writeFileSync(meta, finalUrl, "utf-8");
    return { finalUrl, text };
  }

  /** `get` + cheerio parse (Python `BeautifulSoup(text, "html.parser")`). */
  async getSoup(url: string): Promise<{ finalUrl: string; soup: cheerio.CheerioAPI }> {
    const { finalUrl, text } = await this.get(url);
    return { finalUrl, soup: cheerio.load(text) };
  }

  // -- binary assets ------------------------------------------------------ //
  /**
   * Stream `url` to `dest` (skipped if already present). Returns success.
   * Retried: the EDP Sciences server occasionally drops a large image
   * connection mid-body; a fresh streamed request reliably completes it.
   */
  async download(url: string, dest: string, retries = 3): Promise<boolean> {
    if (this.useCache && existsNonEmpty(dest)) return true;
    mkdirSync(dirname(dest), { recursive: true });
    let last: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.throttler.wait();
        const bytes = await fetchStreamedBytes(this.fetchImpl, url, {
          headers: { "User-Agent": this.userAgent },
          timeout: this.timeout,
        });
        // Atomic write: a crash mid-write must not leave a truncated file
        // that the size>0 cache check would later accept as complete.
        const tmp = `${dest}.part`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, dest);
        return true;
      } catch (e) {
        last = e; // transient: retry
      }
    }
    this.log?.(`asset download failed ${url} (${String(last)})`);
    return false;
  }
}

/**
 * Derive a stable doc id from a full-text URL.
 * A&A: `.../aa39341-20/aa39341-20.html` → `aa39341-20`. Falls back to the last
 * meaningful path segment, sanitized for use as a directory name.
 */
export function docIdFromUrl(url: string): string {
  let path = url;
  let host = "";
  try {
    const u = new URL(url);
    path = u.pathname;
    host = u.hostname;
  } catch {
    // Python's urlparse never throws; treat the raw string as the path.
    path = url.split(/[?#]/, 1)[0] ?? "";
  }
  const segs = path
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "");
  let stem = "";
  const last = segs[segs.length - 1];
  if (last !== undefined) {
    stem = last.replace(/\.s?html?$/i, "");
    // prefer the parent dir if the file stem is generic (index/fulltext)
    if (["index", "fulltext", "full_html", ""].includes(stem.toLowerCase()) && segs.length >= 2) {
      stem = segs[segs.length - 2] ?? "";
    }
  }
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (stem) return stem;
  // No usable path segment: fall back to the host so distinct sites don't
  // collide into one 'document' dir.
  host = host.replaceAll(".", "-").replace(/^-+|-+$/g, "");
  return host || "document";
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
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}
