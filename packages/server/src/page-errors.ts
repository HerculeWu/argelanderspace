/**
 * Errors the page reports (desktop-app ticket 08): `POST /api/page-errors` writes one `page.error` record to the
 * user-level log for an unhandled error, an unhandled promise rejection or a render error of the web app.
 *
 * What arrives comes from a browser and is not trusted. Nothing of the request is written as it came: every field
 * is checked against a shape or a list written here, and whatever fails the check is left out or written as a fixed
 * value. There is no message field — an error's message is never recorded, whatever its type — and a field this
 * file does not know is not looked at.
 *
 *   - `kind`: one of {@link PAGE_ERROR_KINDS}.
 *   - `name`: one of {@link KNOWN_ERROR_NAMES}, or a short name of the shape error classes have — a capital letter,
 *     letters and digits, ending in `Error` or `Exception`; anything else is written as `UnrecognizedName`.
 *   - `stack`: at most {@link PAGE_ERROR_FRAMES_MAX} frames, each the text `file:line:column`. A frame is kept only
 *     when its file is one of the page's own built scripts, which is decided by looking: a plain file of that name
 *     is in the `assets/` directory of the web build this server serves. The text itself only has to be a script's
 *     file name without a directory (letters, digits and `._-`, ending in `.js` or `.mjs`; Vite's names are
 *     `index-eZgqHfVD.js`, `direct-engine-BMwLK-Tl.js`, `browser-BKLM0ThC-D7mrvnwI.js`). Every other frame — a
 *     browser extension's, an inline script's, anything with a path, a query or a function name in it — is
 *     dropped; a server that serves no web build (the Vite dev server does) keeps no frame.
 *   - `pane`: one of {@link PAGE_ERROR_PANES}.
 *
 * The record is written with the log module's own error field (no new kind of field): an Error is put together
 * from the checked name and the kept frames and handed to `f.error`, which writes a name and `file:line:column`
 * frames and nothing else. A frame's file is written as `/assets/<file>`, the place the server serves it from.
 *
 * How many: at most {@link PAGE_ERRORS_PER_MINUTE} a minute and {@link PAGE_ERRORS_PER_LAUNCH} per server run, each
 * request at most {@link PAGE_ERROR_BODY_MAX_BYTES} bytes (enforced while the body is read). What is over is
 * dropped and counted, and the counts are written as `page.errors_dropped` — once when the minute in which the
 * first report was dropped is over, so a page that keeps failing costs one count record a minute, not one a report.
 * A server that closes before that minute is over writes the counts it holds as it closes.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PANE_VIEWS } from "@argelanderspace/contracts";
import { f } from "@argelanderspace/infra";
import type { Context } from "hono";
import { type ServerLog, silentLog } from "./log.js";
import type { ProtectedRoutes } from "./protected-app.js";

export const PAGE_ERRORS_PER_MINUTE = 20;
export const PAGE_ERRORS_PER_LAUNCH = 200;
export const PAGE_ERROR_BODY_MAX_BYTES = 8 * 1024;
export const PAGE_ERROR_FRAMES_MAX = 30;
const WINDOW_MS = 60_000;

export const PAGE_ERROR_KINDS = ["error", "unhandledrejection", "render"] as const;
/**
 * What a pane can show (contracts `PANE_VIEWS`: the workbench views and the settings page), and `none` for an error
 * outside any of them.
 */
export const PAGE_ERROR_PANES = [...PANE_VIEWS, "none"] as const;

/** The error names of the JavaScript engine and of the DOM, and the page's word for a thrown non-Error. */
const KNOWN_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "InternalError",
  "DOMException",
  "AbortError",
  "DataCloneError",
  "InvalidStateError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "NotSupportedError",
  "QuotaExceededError",
  "SecurityError",
  "TimeoutError",
  "NonError",
]);
const NAME_SHAPE = /^[A-Z][A-Za-z0-9]{0,39}(?:Error|Exception)$/;
export const UNRECOGNIZED_NAME = "UnrecognizedName";

// `<file>:<line>:<column>`, the file a script's name with no path separator in it. Whether it is one of the page's
// scripts is not read off the name (a name and a base64url hash both may have hyphens: `direct-engine-BMwLK-Tl.js`,
// `worker-engine-2r7-DNkh.js`): the file has to be there (`builtScripts`).
const FRAME = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}\.m?js):([1-9]\d{0,6}):([1-9]\d{0,6})$/;

const DROP_REASONS = ["per_minute", "per_launch", "too_large", "malformed"] as const;
type DropReason = (typeof DROP_REASONS)[number];

export interface PageErrorOptions {
  /** The web build this server serves; the scripts in its `assets/` are the only files a frame may name. */
  webDist?: string | null | undefined;
  /** The length of the rate window and of the wait before dropped reports are counted in the log; default a minute. */
  windowMs?: number | undefined;
  /**
   * Handed, once, the function a closing server calls: it writes the counts of dropped reports that are still
   * waiting for their window to end.
   */
  atClose?: ((writePending: () => void) => void) | undefined;
}

function checkedName(value: unknown): string {
  if (typeof value !== "string") return UNRECOGNIZED_NAME;
  return KNOWN_ERROR_NAMES.has(value) || NAME_SHAPE.test(value) ? value : UNRECOGNIZED_NAME;
}

/** The names of the built scripts in `<webDist>/assets`; read at each report (a rebuild changes them). */
function builtScripts(webDist: string | null | undefined): Set<string> {
  if (typeof webDist !== "string") return new Set();
  try {
    return new Set(
      readdirSync(join(webDist, "assets"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    );
  } catch {
    return new Set();
  }
}

function checkedFrames(value: unknown, scripts: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || scripts.size === 0) return [];
  const frames: string[] = [];
  // Only so many are looked at, however many were sent.
  for (const raw of value.slice(0, PAGE_ERROR_FRAMES_MAX)) {
    if (typeof raw !== "string" || raw.length > 120) continue;
    const m = FRAME.exec(raw);
    if (m?.[1] !== undefined && scripts.has(m[1])) frames.push(`/assets/${m[1]}:${m[2]}:${m[3]}`);
  }
  return frames;
}

/** An Error made of checked parts only, in the shape the log's error field reads: `name`, then `at file:l:c` lines. */
function errorOf(name: string, frames: readonly string[]): Error {
  const error = new Error("");
  error.name = name;
  error.stack = [name, ...frames.map((frame) => `    at ${frame}`)].join("\n");
  return error;
}

/**
 * Reads at most `limit` bytes of the body; null when there is more (the rest is not read: the stream is cancelled at
 * the first chunk over the limit, so a chunked request with no length cannot make the server hold more).
 */
export async function readLimited(c: Context, limit: number): Promise<Uint8Array | null> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) return null;
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Mounts `POST /api/page-errors`. The answer says whether the report was written: `{recorded: true}`, or
 * `{recorded: false, reason}` for one that was dropped (the page shows which). A server without a log records
 * nothing and says so; it counts nothing either.
 */
export function mountPageErrorRoute(
  app: ProtectedRoutes,
  log: ServerLog,
  options: PageErrorOptions = {}
): void {
  const windowMs = options.windowMs ?? WINDOW_MS;
  let windowStart = Number.NEGATIVE_INFINITY;
  let inWindow = 0;
  let total = 0;
  const dropped = new Map<DropReason, number>();
  let flush: ReturnType<typeof setTimeout> | null = null;

  const writeDropped = (): void => {
    if (flush !== null) clearTimeout(flush);
    flush = null;
    for (const [reason, count] of dropped) {
      log.warn("page.errors_dropped", {
        reason: f.oneOf(DROP_REASONS, reason),
        count: f.num(count),
        recorded_this_launch: f.num(total),
      });
    }
    dropped.clear();
  };
  const drop = (reason: DropReason): void => {
    dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
    if (flush === null) {
      flush = setTimeout(writeDropped, windowMs);
      flush.unref?.();
    }
  };
  options.atClose?.(writeDropped);
  const refused = (c: Context, reason: DropReason | "no_log", status: 200 | 400 | 413 = 200) =>
    c.json({ recorded: false, reason }, status);

  app.post("/api/page-errors", async (c) => {
    const silent = log === silentLog;

    let bytes: Uint8Array | null;
    try {
      bytes = await readLimited(c, PAGE_ERROR_BODY_MAX_BYTES);
    } catch {
      bytes = new Uint8Array();
    }
    if (bytes === null) {
      if (!silent) drop("too_large");
      return refused(c, "too_large", 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      body = undefined;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      if (!silent) drop("malformed");
      return refused(c, "malformed", 400);
    }
    if (silent) return refused(c, "no_log");

    if (total >= PAGE_ERRORS_PER_LAUNCH) {
      drop("per_launch");
      return refused(c, "per_launch");
    }
    const now = performance.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      inWindow = 0;
    }
    if (inWindow >= PAGE_ERRORS_PER_MINUTE) {
      drop("per_minute");
      return refused(c, "per_minute");
    }
    inWindow += 1;
    total += 1;

    const report = body as { kind?: unknown; name?: unknown; stack?: unknown; pane?: unknown };
    log.error("page.error", {
      kind: f.oneOf(PAGE_ERROR_KINDS, typeof report.kind === "string" ? report.kind : ""),
      pane: f.oneOf(PAGE_ERROR_PANES, typeof report.pane === "string" ? report.pane : ""),
      error: f.error(
        errorOf(
          checkedName(report.name),
          checkedFrames(report.stack, builtScripts(options.webDist))
        )
      ),
    });
    return c.json({ recorded: true });
  });
}
