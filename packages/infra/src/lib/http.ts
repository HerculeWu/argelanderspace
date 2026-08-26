/**
 * Shared native-fetch plumbing for the infra adapters (decision: 原生 fetch
 * 自封装重试/节流/缓存 — no axios).
 *
 * Every network class accepts an optional `fetchImpl` so tests can run offline
 * against recorded fixtures; the default is the global `fetch`.
 *
 * Parity notes vs Python `requests` (documented divergences):
 * - Timeout is a single total-request timeout (`AbortSignal.timeout`), close
 *   enough to requests' `timeout=<seconds>` for these APIs.
 * - `fetch` follows redirects by default like `allow_redirects=True`; the final
 *   URL is `response.url` like `r.url`.
 * - Non-2xx raises {@link HttpError} (requests' `raise_for_status`).
 */

export type FetchImpl = typeof fetch;

/** Python `time.sleep`. */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/** HTTP status failure (requests' `raise_for_status`). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
    detail = ""
  ) {
    super(`HTTP ${status} for ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
  }
}

/**
 * Polite-pool throttle (the `_throttle` methods of the Python clients):
 * before each request, sleep so at least `delay` seconds passed since the
 * previous request. The timestamp updates even when no sleep was needed.
 */
export class Throttler {
  private last = 0;
  constructor(private readonly delaySeconds: number) {}

  async wait(): Promise<void> {
    if (this.delaySeconds <= 0) return;
    const now = Date.now() / 1000;
    const remaining = this.delaySeconds - (now - this.last);
    if (remaining > 0) await sleep(remaining);
    this.last = Date.now() / 1000;
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Total request timeout in seconds (requests' `timeout=`). */
  timeout?: number;
  signal?: AbortSignal;
}

function timeoutSignal(seconds: number | undefined, outer?: AbortSignal): AbortSignal | undefined {
  const t = seconds !== undefined && seconds > 0 ? AbortSignal.timeout(seconds * 1000) : undefined;
  if (t && outer) return AbortSignal.any([t, outer]);
  return t ?? outer;
}

async function checkOk(res: Response, url: string, bodyHint: () => Promise<string>): Promise<void> {
  if (!res.ok) throw new HttpError(res.status, url, await bodyHint());
}

/** GET (or simple method) → decoded text body, with raise_for_status semantics. */
export async function fetchText(
  impl: FetchImpl,
  url: string,
  opts: FetchOptions & { method?: string; body?: string } = {}
): Promise<{ finalUrl: string; text: string; status: number; headers: Headers }> {
  const res = await impl(url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
    redirect: "follow",
    signal: timeoutSignal(opts.timeout, opts.signal),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = decodeResponseText(buf, res.headers.get("content-type"));
  await checkOk(res, url, async () => text.slice(0, 300));
  return { finalUrl: res.url || url, text, status: res.status, headers: res.headers };
}

/** GET → raw bytes, with raise_for_status semantics. */
export async function fetchBytes(
  impl: FetchImpl,
  url: string,
  opts: FetchOptions = {}
): Promise<{ finalUrl: string; bytes: Uint8Array; status: number; headers: Headers }> {
  const res = await impl(url, {
    headers: opts.headers,
    redirect: "follow",
    signal: timeoutSignal(opts.timeout, opts.signal),
  });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new HttpError(res.status, url, snippet);
  }
  const buf = await res.arrayBuffer();
  return {
    finalUrl: res.url || url,
    bytes: new Uint8Array(buf),
    status: res.status,
    headers: res.headers,
  };
}

/**
 * GET streamed to a byte buffer with requests-style short-read detection
 * (`Fetcher.download`): if the server advertises a Content-Length but the body
 * ends early, throw so the caller can retry. Both requests and undici decode
 * gzip transparently while Content-Length stays the *compressed* length, so a
 * decoded body is never shorter than expected — the check only fires on
 * genuinely truncated identity transfers (the EDP Sciences failure mode).
 */
export async function fetchStreamedBytes(
  impl: FetchImpl,
  url: string,
  opts: FetchOptions = {}
): Promise<Uint8Array> {
  const res = await impl(url, {
    headers: opts.headers,
    redirect: "follow",
    signal: timeoutSignal(opts.timeout, opts.signal),
  });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new HttpError(res.status, url, snippet);
  }
  const expected = Number(res.headers.get("content-length") ?? 0) || 0;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  }
  if (expected > 0 && total < expected) {
    throw new Error(`short read ${total}/${expected}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decode a text response the way `requests`' `r.text` does: charset from the
 * Content-Type header; absent that, ISO-8859-1 for `text/*` (requests'
 * default), else UTF-8 (requests would chardet-guess — UTF-8 is the practical
 * approximation; documented divergence). Invalid bytes become U+FFFD like
 * requests' `errors="replace"`.
 *
 * Caveat: WHATWG TextDecoder maps the `iso-8859-1` label to windows-1252, so
 * bytes 0x80–0x9F decode to punctuation rather than C1 controls (requests
 * decodes true latin-1). Publisher pages are UTF-8 in practice.
 */
export function decodeResponseText(buf: Uint8Array, contentType: string | null): string {
  const ct = contentType ?? "";
  const m = /charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(ct);
  let label: string | undefined;
  if (m?.[1]) label = m[1];
  else if (ct.toLowerCase().startsWith("text/")) label = "iso-8859-1";
  else label = "utf-8";
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    // Unknown/unsupported charset label — fall back to UTF-8.
    return new TextDecoder("utf-8").decode(buf);
  }
}

/**
 * `requests` builds query strings with `urlencode` (form encoding); this uses
 * `URLSearchParams`, the same encoding except that Python leaves `~` raw and
 * encodes `*` while URLSearchParams does the opposite — both decode to the
 * same string server-side, and the source disk-cache keys are computed from
 * the pre-URL param dict, so cache compatibility is unaffected.
 */
export function withQuery(url: string, params: Record<string, string | number>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${q.toString()}`;
}
