/**
 * Stage 10 M2b — Writer REST client (`/api/writer/*`, server app.ts).
 *
 * Mirrors api/plans.ts conventions: NO fixture fallback anywhere — a network
 * or server failure surfaces as an explicit error state in the view (never
 * disguised as empty data). The 409 PUT body carries the server's current
 * document (`{detail, rev, current}`) so the editor can adopt it directly
 * without a second round-trip.
 */

import type {
  ManuscriptSummary,
  WriterManuscript,
  WriterNumberingResponse,
  WriterTemplate,
} from "@argelanderspace/contracts";

export interface TemplatesResult {
  templates: WriterTemplate[];
  warnings: string[];
}

/** null = unreachable/failed (caller shows an error state). */
export async function fetchTemplates(): Promise<TemplatesResult | null> {
  try {
    const r = await fetch("/api/writer/templates");
    if (!r.ok) return null;
    return (await r.json()) as TemplatesResult;
  } catch {
    return null;
  }
}

export interface ManuscriptsResult {
  manuscripts: ManuscriptSummary[];
  warnings: string[];
}

/** null = unreachable/failed. */
export async function fetchManuscripts(): Promise<ManuscriptsResult | null> {
  try {
    const r = await fetch("/api/writer/manuscripts");
    if (!r.ok) return null;
    return (await r.json()) as ManuscriptsResult;
  } catch {
    return null;
  }
}

/** null = 404 (deleted / never existed); throws nothing on network failure —
 *  a failed fetch of an existing doc also yields null, callers distinguish by
 *  context (initial load vs. refetch keeps the current doc on failure). */
export async function fetchManuscript(id: string): Promise<WriterManuscript | null> {
  try {
    const r = await fetch(`/api/writer/manuscripts/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return (await r.json()) as WriterManuscript;
  } catch {
    return null;
  }
}

/** 400 (unknown template / bad input) and network failures both reject. */
export async function createManuscript(input: {
  template: string;
  title?: string;
}): Promise<WriterManuscript> {
  const r = await fetch("/api/writer/manuscripts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`create manuscript failed: ${r.status}`);
  return (await r.json()) as WriterManuscript;
}

export type PutManuscriptResult =
  | { ok: true; doc: WriterManuscript } // 200: persisted, rev bumped
  | { ok: false; conflict: WriterManuscript } // 409: server's current doc
  | { ok: false; conflict: null }; // other failure (network / 404 / 400)

/** Whole-document replace; the body carries the client's rev. */
export async function putManuscript(doc: WriterManuscript): Promise<PutManuscriptResult> {
  try {
    const r = await fetch(`/api/writer/manuscripts/${encodeURIComponent(doc.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (r.ok) return { ok: true, doc: (await r.json()) as WriterManuscript };
    if (r.status === 409) {
      const body = (await r.json()) as { current: WriterManuscript };
      return { ok: false, conflict: body.current };
    }
    return { ok: false, conflict: null };
  } catch {
    return { ok: false, conflict: null };
  }
}

export async function deleteManuscript(id: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/writer/manuscripts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Raw-body upload; resolves to the stored asset name (may differ from the
 *  file's name on collision). Throws on any non-2xx. */
export async function uploadAsset(id: string, file: File): Promise<string> {
  const r = await fetch(
    `/api/writer/manuscripts/${encodeURIComponent(id)}/assets?filename=${encodeURIComponent(file.name)}`,
    { method: "POST", body: file }
  );
  if (!r.ok) throw new Error(`asset upload failed: ${r.status}`);
  const body = (await r.json()) as { name: string };
  return body.name;
}

/** URL of the asset-serving route (figure <img src>). */
export function assetUrl(id: string, name: string): string {
  return `/api/writer/manuscripts/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`;
}

/** URL of the server-assembled export zip (manuscript.tex + bib + assets). */
export function exportUrl(id: string): string {
  return `/api/writer/manuscripts/${encodeURIComponent(id)}/export`;
}

/** Numbering state (D14); 404 → null. */
export async function fetchNumbering(id: string): Promise<WriterNumberingResponse | null> {
  const r = await fetch(`/api/writer/manuscripts/${encodeURIComponent(id)}/numbering`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`numbering fetch failed: ${r.status}`);
  return (await r.json()) as WriterNumberingResponse;
}

/** Force a numbering re-compile now (manual refresh). */
export async function refreshNumbering(id: string): Promise<WriterNumberingResponse> {
  const r = await fetch(`/api/writer/manuscripts/${encodeURIComponent(id)}/numbering/refresh`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`numbering refresh failed: ${r.status}`);
  return (await r.json()) as WriterNumberingResponse;
}
