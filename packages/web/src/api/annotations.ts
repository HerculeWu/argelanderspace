import type { AnnotationsFile } from "@argelanderspace/contracts";

// The reader's annotation store (Stage 8 MS3) talks to
// `GET/PUT /api/paper/:doc_id/annotations`. Same discipline as api/plans.ts:
// NO fixture fallback — an unreachable server yields a typed failure and the
// panel shows an explicit error state, never a fake empty list. The client
// holds `content_fingerprint` + `rev` from the GET and echoes the whole file
// back on PUT; the server double-checks both (roadmap §5).

export type FetchAnnotationsResult =
  | { ok: true; file: AnnotationsFile }
  // `missing` (404): the doc was deleted externally — the watcher fires
  // `annotation.changed` with cause "external" for the removed current.json,
  // so a refetch can legitimately 404; callers clear, never error.
  | { ok: false; missing: boolean; status: number };

export async function fetchAnnotations(docId: string): Promise<FetchAnnotationsResult> {
  try {
    const r = await fetch(`/api/paper/${encodeURIComponent(docId)}/annotations`);
    if (!r.ok) return { ok: false, missing: r.status === 404, status: r.status };
    return { ok: true, file: (await r.json()) as AnnotationsFile };
  } catch {
    return { ok: false, missing: false, status: 0 };
  }
}

export type PutAnnotationsResult =
  | { ok: true; file: AnnotationsFile } // 200: persisted, rev bumped
  // 409 "document changed": the doc was re-ingested under our feet; the old
  // epoch is archived and the response carries the fresh (empty) file.
  | { ok: false; kind: "document-changed"; file: AnnotationsFile }
  // 409 "rev mismatch": another writer landed first; caller refetches.
  | { ok: false; kind: "rev-mismatch"; rev: number }
  // 500 / network: infrastructure failure — show the error, keep the UI.
  | { ok: false; kind: "error"; detail: string };

/** Whole-document replace. The body echoes the client's fingerprint+rev; the
 *  server answers 200 with the bumped file or one of the two 409 shapes. */
export async function putAnnotations(
  docId: string,
  file: AnnotationsFile
): Promise<PutAnnotationsResult> {
  try {
    const r = await fetch(`/api/paper/${encodeURIComponent(docId)}/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
    });
    if (r.ok) return { ok: true, file: (await r.json()) as AnnotationsFile };
    const body = (await r.json().catch(() => null)) as {
      detail?: string;
      file?: AnnotationsFile;
      rev?: number;
    } | null;
    if (r.status === 409 && body?.detail === "document changed" && body.file) {
      return { ok: false, kind: "document-changed", file: body.file };
    }
    if (r.status === 409 && body?.detail === "rev mismatch") {
      return { ok: false, kind: "rev-mismatch", rev: body.rev ?? file.rev };
    }
    return { ok: false, kind: "error", detail: body?.detail ?? `annotations PUT ${r.status}` };
  } catch (e) {
    return { ok: false, kind: "error", detail: String(e) };
  }
}

export type DeleteDocResult =
  | { ok: true }
  // 409 "document busy": a queued/running ingest pins the doc — the task ends
  // on its own, the user simply retries later.
  | { ok: false; busy: true }
  // 404: the doc is already gone (deleted elsewhere) — treat as done.
  | { ok: false; busy: false; missing: boolean; detail: string };

/** Stage 8 §8: global physical delete of one doc (output dir + annotations +
 *  removal from every work's doc_ids). */
export async function deletePaperDoc(docId: string): Promise<DeleteDocResult> {
  try {
    const r = await fetch(`/api/paper/${encodeURIComponent(docId)}`, { method: "DELETE" });
    if (r.ok) return { ok: true };
    const body = (await r.json().catch(() => null)) as { detail?: string } | null;
    if (r.status === 409) return { ok: false, busy: true };
    return {
      ok: false,
      busy: false,
      missing: r.status === 404,
      detail: body?.detail ?? `DELETE ${r.status}`,
    };
  } catch (e) {
    return { ok: false, busy: false, missing: false, detail: String(e) };
  }
}
