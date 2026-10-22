/**
 * The two small helpers every route's failure words are built with, defined once: FastAPI's
 * `HTTPException(status, msg)` body, and Python's `f"...{value!r}..."` for the simple ids that reach these messages.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function detail(msg: string, status: ContentfulStatusCode) {
  return { body: { detail: msg }, status };
}

export function pyRepr(s: string): string {
  return `'${s}'`;
}
