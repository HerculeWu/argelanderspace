/**
 * "document busy": the one value for a Doc that has a queued/running mutation or delete (DocMutationRegistry, in the
 * server). It is the HTTP 409 detail, the message of what core and the server throw for it, and what the page and the
 * Copilot compare a 409 detail with (architecture ticket 02; docs/contracts.md "删除生命周期").
 *
 * A thrown busy carries its kind on the own property `conflict: "busy"` — the field `PdfAnnotationConflictError("busy")`
 * already has — so a catcher tells it apart without reading the message. The error stays a plain `Error` built where it
 * is thrown (its name, stack and the user log's record unchanged); the mark is not `code`, which the log records.
 */

export const DOCUMENT_BUSY = "document busy" as const;

/** Mark `error` as a busy Doc (in place) and give it back: `throw markDocumentBusy(new Error(DOCUMENT_BUSY))`. */
export function markDocumentBusy<E extends Error>(error: E): E & { readonly conflict: "busy" } {
  return Object.assign(error, { conflict: "busy" as const });
}

/** Whether `error` was thrown for a busy Doc: an Error whose `conflict` is `"busy"` (not its message). */
export function isDocumentBusyError(error: unknown): boolean {
  return error instanceof Error && (error as { conflict?: unknown }).conflict === "busy";
}
