import {
  type PdfAnnotation,
  PdfReaderSnapshotSchema,
  type ShelfAddCandidates,
  type ShelfAddPreviewResponse,
  type ShelfAddRequest,
  type ShelfAddResponse,
  type ShelfAnnotationsResponse,
  type ShelfArchived,
  type ShelfDeleteResponse,
  type ShelfEntryResponse,
  type ShelfItem,
  type ShelfItemProblem,
  type ShelfListResponse,
  type ShelfLookupResponse,
  type ShelfReplaceImpact,
  type ShelfTakePreview,
  type ShelfTakeRequest,
  type ShelfTakeResult,
  type WsShelfChanged,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";
import { bus } from "./ws-instance";

/*
 * The Shelf HTTP client (shelf ticket 05; server interface docs/library.md "Shelf" section, contracts
 * shelf-write.ts / shelf-take.ts). No fixture fallback: an unreachable server or a refusal is a typed failure the page
 * shows. A refusal keeps the server's `code` (what the page compares) and `detail` (what the person reads).
 */

/** A refusal or failure: `status` 0 is no answer at all. `body` is the refusal's other fields (`impact`, `item`, …). */
export interface ShelfFailure {
  ok: false;
  status: number;
  code: string;
  detail: string;
  body: Record<string, unknown>;
}

export type ShelfAnswer<T> = ({ ok: true } & T) | ShelfFailure;

function failure(e: unknown): ShelfFailure {
  if (e instanceof HttpError && e.status > 0) {
    const body = (e.cause === undefined && e.body && typeof e.body === "object" ? e.body : {}) as Record<string, unknown>;
    return { ok: false, status: e.status, code: e.code, detail: typeof body.detail === "string" ? body.detail : `HTTP ${e.status}`, body };
  }
  if ((e as { name?: string } | null)?.name === "AbortError") throw e;
  return { ok: false, status: 0, code: "unreachable", detail: "", body: {} };
}

async function call<T>(path: string, init: Parameters<typeof apiRequest>[1], signal?: AbortSignal): Promise<ShelfAnswer<{ value: T }>> {
  try {
    return { ok: true, value: await apiRequest<T>(path, { cache: "no-store", ...init }, signal ? { signal } : {}) };
  } catch (e) {
    return failure(e);
  }
}

const entry = (entryId: string) => `/api/shelf/entries/${encodeURIComponent(entryId)}`;

export const fetchShelf = (signal?: AbortSignal) => call<ShelfListResponse>("/api/shelf", {}, signal);
export const fetchShelfEntry = (entryId: string, signal?: AbortSignal) => call<ShelfEntryResponse>(entry(entryId), {}, signal);
export const fetchShelfAnnotations = (entryId: string, rev: number, signal?: AbortSignal) =>
  call<ShelfAnnotationsResponse>(`${entry(entryId)}/annotations?rev=${rev}`, {}, signal);

/** `GET /api/shelf/lookup`: the entries that are the same paper (DOI, arXiv, OpenAlex only). Null: none of the three. */
export function lookupShelf(ids: { doi?: string | null; arxiv?: string | null; openalex?: string | null }, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (ids.doi) q.set("doi", ids.doi);
  if (ids.arxiv) q.set("arxiv", ids.arxiv);
  if (ids.openalex) q.set("openalex", ids.openalex);
  if ([...q.keys()].length === 0) return null;
  return call<ShelfLookupResponse>(`/api/shelf/lookup?${q}`, {}, signal);
}

/** `GET /api/shelf/add-candidates/:workId`: the add dialog's read-only list (annotations by peek, never ensure). */
export const fetchAddCandidates = (workId: string, signal?: AbortSignal) =>
  call<ShelfAddCandidates>(`/api/shelf/add-candidates/${encodeURIComponent(workId)}`, {}, signal);
export const previewAddToShelf =(request: Omit<ShelfAddRequest, "confirm">) =>
  call<ShelfAddPreviewResponse>("/api/shelf/entries/preview", { method: "POST", json: request });
export const addToShelf = (request: ShelfAddRequest) => call<ShelfAddResponse>("/api/shelf/entries", { method: "POST", json: request });
export const deleteShelfEntry = (entryId: string, rev: number) =>
  call<ShelfDeleteResponse>(`${entry(entryId)}?rev=${rev}`, { method: "DELETE" });
export const previewTake = (entryId: string, request: ShelfTakeRequest) =>
  call<ShelfTakePreview>(`${entry(entryId)}/take/preview`, { method: "POST", json: request });
export const takeFromShelf = (entryId: string, request: ShelfTakeRequest) =>
  call<ShelfTakeResult>(`${entry(entryId)}/take`, { method: "POST", json: request });

/**
 * A PDF Doc's current workbench annotations, for the add dialog's list (the PDF snapshot, which checks the original
 * and the sidecar on every read). Null: they could not be read.
 */
export async function fetchPdfAnnotationsForShelf(docId: string, signal?: AbortSignal): Promise<PdfAnnotation[] | null> {
  try {
    const parsed = PdfReaderSnapshotSchema.safeParse(await apiRequest(`/api/paper/${encodeURIComponent(docId)}/pdf/snapshot`, { cache: "no-store" }, signal ? { signal } : {}));
    return parsed.success && parsed.data.annotations.doc_id === docId ? parsed.data.annotations.annotations : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

/** The parts of an `item_unreadable` refusal (and of every refusal after the annotations were read). */
export function refusalParts(f: ShelfFailure): { item: ShelfItem | null; problem: ShelfItemProblem | null; archived: ShelfArchived; impact: ShelfReplaceImpact | null } {
  const item = f.body.item && typeof f.body.item === "object" ? (f.body.item as ShelfItem) : null;
  const problem = typeof f.body.problem === "string" ? (f.body.problem as ShelfItemProblem) : null;
  const archived = Array.isArray(f.body.archived) ? (f.body.archived as ShelfArchived) : [];
  const impact = f.body.impact && typeof f.body.impact === "object" ? (f.body.impact as ShelfReplaceImpact) : null;
  return { item, problem, archived, impact };
}

/**
 * The Shelf changed through this server (`shelf.changed`); `onResync` fires on every (re)connect, when a change may
 * have been missed. Another workbench's writes are not announced: the Shelf dialog reads again when it opens.
 */
export function onShelfChanged(cb: (msg: WsShelfChanged) => void, onResync?: () => void): () => void {
  const offs = [bus.on("shelf.changed", cb), ...(onResync ? [bus.onResync(onResync)] : [])];
  return () => {
    for (const off of offs) off();
  };
}
