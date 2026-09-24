import { DocDescriptionSchema, type DocDescription } from "@argelanderspace/contracts";

export type DocDescriptionResult =
  | { ok: true; description: DocDescription }
  | { ok: false; reason: "http" | "invalid" | "network" };

export async function fetchDocDescription(
  docId: string,
  signal?: AbortSignal
): Promise<DocDescriptionResult> {
  try {
    const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/description`, { signal });
    if (!response.ok) return { ok: false, reason: "http" };
    const parsed = DocDescriptionSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.doc_id !== docId) return { ok: false, reason: "invalid" };
    return { ok: true, description: parsed.data };
  } catch {
    return { ok: false, reason: "network" };
  }
}
