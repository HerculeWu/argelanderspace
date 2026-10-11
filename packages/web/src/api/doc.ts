import { DocDescriptionSchema, type DocDescription } from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

export type DocDescriptionResult =
  | { ok: true; description: DocDescription }
  | { ok: false; reason: "http" | "invalid" | "network" };

export async function fetchDocDescription(
  docId: string,
  signal?: AbortSignal
): Promise<DocDescriptionResult> {
  try {
    const parsed = DocDescriptionSchema.safeParse(await apiRequest(`/api/paper/${encodeURIComponent(docId)}/description`, {}, { signal }));
    if (!parsed.success || parsed.data.doc_id !== docId) return { ok: false, reason: "invalid" };
    return { ok: true, description: parsed.data };
  } catch (e) {
    return { ok: false, reason: e instanceof HttpError && e.status > 0 ? "http" : "network" };
  }
}
