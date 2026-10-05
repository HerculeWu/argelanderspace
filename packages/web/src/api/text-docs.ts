import {
  type DocDescription,
  TextGenerationResultSchema,
  type TextDiagnostic,
  type TextGenerationResult,
  type TextSourceDto,
  TextSourceDtoSchema,
  type TextValidationResult,
  TextValidationResultSchema,
} from "@argelanderspace/contracts";

// The text Doc's HTTP client (ticket 25). No fixture fallback: an unreachable server or an unexpected body is a typed
// failure the page shows, never an empty source.

const base = (docId: string) => `/api/paper/${encodeURIComponent(docId)}`;
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function detailOf(response: Response): Promise<{ detail: string; body: Record<string, unknown> }> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { detail: typeof body.detail === "string" ? body.detail : `HTTP ${response.status}`, body };
}

export type CreateTextDocResult =
  | { ok: true; docId: string; created: boolean }
  | { ok: false; detail: string };

export async function createTextDoc(workId: string, operationId: string): Promise<CreateTextDocResult> {
  try {
    const response = await fetch("/api/library/text-docs", json({ workId, operationId }));
    if (!response.ok) return { ok: false, detail: (await detailOf(response)).detail };
    const body = (await response.json()) as { description?: DocDescription };
    if (!body.description?.doc_id) return { ok: false, detail: "unexpected response" };
    return { ok: true, docId: body.description.doc_id, created: response.status === 201 };
  } catch {
    return { ok: false, detail: "the service did not answer" };
  }
}

export type TextSourceRead =
  | { ok: true; source: TextSourceDto }
  | { ok: false; missing: boolean; detail: string };

export async function fetchTextSource(docId: string, signal?: AbortSignal): Promise<TextSourceRead> {
  try {
    const response = await fetch(`${base(docId)}/source`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return { ok: false, missing: response.status === 404, detail: (await detailOf(response)).detail };
    const parsed = TextSourceDtoSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.doc_id !== docId) return { ok: false, missing: false, detail: "unexpected response" };
    return { ok: true, source: parsed.data };
  } catch {
    return { ok: false, missing: false, detail: "the service did not answer" };
  }
}

export type TextSourceSave =
  | { ok: true; source: TextSourceDto }
  /** Another writer got there first; `source` is what is stored now. The local text is NOT replaced by it. */
  | { ok: false; kind: "conflict"; source: TextSourceDto | null }
  | { ok: false; kind: "busy" | "missing" | "error"; detail: string };

export async function saveTextSource(docId: string, expectedRev: number, markdown: string): Promise<TextSourceSave> {
  try {
    const response = await fetch(`${base(docId)}/source`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRev, markdown }),
    });
    if (response.ok) {
      const parsed = TextSourceDtoSchema.safeParse(await response.json());
      return parsed.success ? { ok: true, source: parsed.data } : { ok: false, kind: "error", detail: "unexpected response" };
    }
    const { detail, body } = await detailOf(response);
    if (response.status === 409 && detail === "rev mismatch") {
      const parsed = TextSourceDtoSchema.safeParse(body.source);
      return { ok: false, kind: "conflict", source: parsed.success ? parsed.data : null };
    }
    if (response.status === 409) return { ok: false, kind: "busy", detail };
    return { ok: false, kind: response.status === 404 ? "missing" : "error", detail };
  } catch {
    return { ok: false, kind: "error", detail: "the service did not answer" };
  }
}

export type TextValidate =
  | { ok: true; result: TextValidationResult }
  | { ok: false; kind: "stale" | "error"; detail: string };

export async function validateTextSource(docId: string, sourceRev: number): Promise<TextValidate> {
  try {
    const response = await fetch(`${base(docId)}/source/validate`, json({ sourceRev }));
    if (response.ok) {
      const parsed = TextValidationResultSchema.safeParse(await response.json());
      return parsed.success ? { ok: true, result: parsed.data } : { ok: false, kind: "error", detail: "unexpected response" };
    }
    return { ok: false, kind: response.status === 409 ? "stale" : "error", detail: (await detailOf(response)).detail };
  } catch {
    return { ok: false, kind: "error", detail: "the service did not answer" };
  }
}

export type TextGenerate =
  | { ok: true; result: TextGenerationResult }
  | { ok: false; kind: "diagnostics"; diagnostics: TextDiagnostic[]; detail: string }
  | { ok: false; kind: "stale" | "blocked" | "busy" | "error"; detail: string };

export async function generateTextDoc(docId: string, sourceRev: number, operationId: string): Promise<TextGenerate> {
  try {
    const response = await fetch(`${base(docId)}/source/generate`, json({ sourceRev, operationId }));
    if (response.ok) {
      const parsed = TextGenerationResultSchema.safeParse(await response.json());
      return parsed.success ? { ok: true, result: parsed.data } : { ok: false, kind: "error", detail: "unexpected response" };
    }
    const { detail, body } = await detailOf(response);
    if (response.status === 422 && Array.isArray(body.diagnostics))
      return { ok: false, kind: "diagnostics", diagnostics: body.diagnostics as TextDiagnostic[], detail };
    if (response.status === 409) {
      const code = body.code;
      return { ok: false, kind: code === "stale" ? "stale" : code === "replacement_blocked" ? "blocked" : "busy", detail };
    }
    return { ok: false, kind: "error", detail };
  } catch {
    return { ok: false, kind: "error", detail: "the service did not answer" };
  }
}
