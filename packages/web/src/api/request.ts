/**
 * The web client's one fetch wrapper. Every module under api/ goes through `apiRequest` and keeps its own exported
 * result shape (discriminated unions, typed error classes); only the transport and the reading of a failed answer live
 * here. Nothing in this file changes what is sent or what the server's details say.
 */

/**
 * A request that produced no ok answer. `status` is the HTTP status, or 0 when the server did not answer at all
 * (code `unreachable`). `body` is the parsed error body (null when there was none or it was not JSON). `cause` is the
 * underlying failure when there was no usable answer: the network error (status 0) or the parse error of a non-JSON
 * error body.
 */
export class HttpError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: string,
    readonly status: number,
    readonly body: unknown = null,
    cause?: unknown
  ) {
    super(code);
    if (cause !== undefined) this.cause = cause;
  }
}

export type ApiRequestInit = RequestInit & {
  /** Sent as JSON with a JSON content type (the caller's headers still apply). */
  json?: unknown;
  /** Sent as is, e.g. a PDF or zip upload. */
  raw?: BodyInit;
};

export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** "json" (default): resolve the parsed body. "none": resolve the unread Response (binary bodies, status checks). */
  parse?: "json" | "none";
}

export type ConflictKind = "busy" | "changed" | "rev-mismatch" | "stale";

// The contract's 409 details (docs/contracts.md): matched literally, never loosened.
const CONFLICT_DETAILS = new Map<unknown, ConflictKind>([
  ["document busy", "busy"],
  ["document changed", "changed"],
  ["rev mismatch", "rev-mismatch"],
]);

const detailKind = (body: unknown): ConflictKind | null =>
  CONFLICT_DETAILS.get((body as { detail?: unknown } | null)?.detail) ?? null;

/** Which of the contract's 409 conflicts a failed request was; null for anything else. */
export function conflictKind(err: unknown): ConflictKind | null {
  if (!(err instanceof HttpError) || err.status !== 409) return null;
  const kind = detailKind(err.body);
  if (kind) return kind;
  return (err.body as { code?: unknown } | null)?.code === "stale" ? "stale" : null;
}

const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === "AbortError";

/**
 * Fetch `path`. Resolves the parsed JSON (or, with `parse: "none"`, the Response) of an ok answer; a non-JSON ok
 * answer rejects with the parse error itself. Rejects with an `HttpError` otherwise: `unreachable`/0 when fetch
 * failed, else the body's `code`, a contract conflict derived from its `detail`, or `unavailable`. An abort is
 * rethrown as is.
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}, opts: ApiRequestOptions = {}): Promise<T> {
  const { json, raw, ...rest } = init;
  const request: RequestInit = { ...rest };
  if (json !== undefined) {
    request.headers = { "Content-Type": "application/json", ...(rest.headers as Record<string, string> | undefined) };
    request.body = JSON.stringify(json);
  } else if (raw !== undefined) {
    request.body = raw;
  }
  if (opts.signal) request.signal = opts.signal;
  for (const key of Object.keys(request) as (keyof RequestInit)[]) if (request[key] === undefined) delete request[key];

  let response: Response;
  try {
    response = await (Object.keys(request).length > 0 ? fetch(path, request) : fetch(path));
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new HttpError("unreachable", 0, null, error);
  }
  if (!response.ok) {
    let body: unknown = null;
    let unreadable: unknown;
    try {
      body = await response.json();
    } catch (error) {
      unreadable = error;
    }
    const code = (body as { code?: unknown } | null)?.code;
    throw new HttpError(typeof code === "string" ? code : (detailKind(body) ?? "unavailable"), response.status, body, unreadable);
  }
  if (opts.parse === "none") return response as T;
  return (await response.json()) as T;
}

/** The failure underneath an HttpError that had no usable answer (network error, non-JSON error body); else `err`. */
export const underlyingError = (err: unknown): unknown =>
  err instanceof HttpError && err.cause !== undefined ? err.cause : err;
