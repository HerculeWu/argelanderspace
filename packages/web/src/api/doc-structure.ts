import { autoSourceText } from "@argelanderspace/contracts";
import { fetchDocDescription } from "./doc";
import { apiRequest } from "./request";

/** One place a source can point at in a shared-IR Doc: its structural id and the words that name it. */
export interface StructureOption {
  /** The structural id the reader opens (`sec-3`, `fig-4`, …). */
  anchor: string;
  kind: "section" | "figure" | "table" | "equation";
  /** What to list it as: `3.2 Heading`, `Figure 4`. */
  label: string;
  /** The display text a source gets when its text is left empty: `Section 3.2`, `Figure 4` (never `§`). */
  autoText: string;
}

/** What a Doc offers as source locations: shared-IR Docs list their structure, PDF Docs a page count. */
export type DocStructure = { format: "pdf"; pageCount: number } | { format: "ir"; options: StructureOption[] };

interface LooseSection {
  id?: unknown;
  number?: unknown;
  heading?: unknown;
  blocks?: unknown;
  children?: unknown;
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** Walks the IR's section tree in reading order (sections, then the figures, tables and numbered equations inside them). */
export function structureOptions(sections: unknown): StructureOption[] {
  const out: StructureOption[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const s of list as LooseSection[]) {
      const id = str(s.id);
      if (id) {
        const number = str(s.number);
        const heading = str(s.heading);
        out.push({
          anchor: id,
          kind: "section",
          label: [number, heading].filter(Boolean).join(" ") || id,
          autoText: number ? autoSourceText("section", number) : (heading ?? id),
        });
      }
      for (const b of Array.isArray(s.blocks) ? (s.blocks as Record<string, unknown>[]) : []) {
        const bid = str(b.id);
        const number = str(b.number);
        const type = b.type;
        if (!bid || (type !== "figure" && type !== "table" && type !== "equation")) continue;
        // an unnumbered equation has nothing to call it by; floats fall back to their label
        if (!number && type === "equation") continue;
        const text = number ? autoSourceText(type, number) : (str(b.label) ?? bid);
        out.push({ anchor: bid, kind: type, label: text, autoText: text });
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

/** Reads the structure a Doc already has (nothing is computed or stored for this). `ok: false` when it cannot be read. */
export async function fetchDocStructure(docId: string, signal?: AbortSignal): Promise<{ ok: true; structure: DocStructure } | { ok: false }> {
  const described = await fetchDocDescription(docId, signal);
  if (!described.ok) return { ok: false };
  if (described.description.format === "pdf") return { ok: true, structure: { format: "pdf", pageCount: described.description.page_count } };
  try {
    const ir = await apiRequest<{ sections?: unknown }>(`/api/paper/${encodeURIComponent(docId)}/ir`, {}, { signal });
    return { ok: true, structure: { format: "ir", options: structureOptions(ir.sections) } };
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    return { ok: false };
  }
}
