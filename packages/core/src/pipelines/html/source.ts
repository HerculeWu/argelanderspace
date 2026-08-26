/**
 * Pure URL helpers of `bibgraph/ingest_html/fetch.py`: DOI detection, source
 * normalization, and doc-id derivation. The stateful `Fetcher` (HTTP + cache)
 * stays in infra (M2); these pure pieces live with the pipeline composition.
 * Infra's `html/fetcher.ts` re-exports them so there is a single source of
 * truth for the cache-key-critical strings.
 */

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
