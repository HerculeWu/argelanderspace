import type {
  Annotation,
  AnnotationStructureKind,
  AnnotationTarget,
} from "@argelanderspace/contracts";
import i18n from "../i18n";


// Pure annotation helpers (Stage 8 MS3): snapshot building from the render IR
// (roadmap §1 per-kind fields, full and untruncated — the snapshot records
// "what was annotated" for the UI / agent context / future migration input,
// never for automatic re-anchoring), document-order sorting, list summaries,
// and the `a_<8hex>` id factory (same shape as core's randomBytes(4)).

/** Localized kind label, resolved at call time so a language switch takes
 *  effect (an explicit typed mapping — no key concatenation). */
export function kindLabel(kind: AnnotationStructureKind): string {
  switch (kind) {
    case "section":
      return i18n.t("annotation.kind.section");
    case "paragraph":
      return i18n.t("annotation.kind.paragraph");
    case "list":
      return i18n.t("annotation.kind.list");
    case "equation":
      return i18n.t("annotation.kind.equation");
    case "figure":
      return i18n.t("annotation.kind.figure");
    case "table":
      return i18n.t("annotation.kind.table");
    case "code":
      return i18n.t("annotation.kind.code");
    case "algorithm":
      return i18n.t("annotation.kind.algorithm");
  }
}

/** `a_<8 hex>` — crypto.getRandomValues (browser + Node ≥19 share it). */
export function newAnnotationId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "a_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The structure-target builders are shared with the Copilot `reader` tool (one implementation in contracts).
export { buildStructureTarget, withAssetHash } from "@argelanderspace/contracts";

/** The block id a target is anchored to (null for whole-document targets). */
export function targetBlockId(target: AnnotationTarget): string | null {
  if (target.type === "structure") return target.id;
  if (target.type === "text") return target.block;
  return null;
}

/**
 * Document reading order: document-level annotations first, then everything
 * else by its target's position in `blockOrder` (stable within a block — the
 * file order is the tiebreak). Targets whose block vanished from the IR sort
 * last (they render normally; invalidation, not the UI, owns cleanup).
 */
export function sortAnnotations(
  annotations: Annotation[],
  blockOrder: Map<string, number>
): Annotation[] {
  return annotations
    .map((a, i) => ({ a, i }))
    .sort((x, y) => orderKey(x.a, blockOrder) - orderKey(y.a, blockOrder) || x.i - y.i)
    .map(({ a }) => a);
}

function orderKey(a: Annotation, blockOrder: Map<string, number>): number {
  const bid = targetBlockId(a.target);
  if (bid === null) return -1;
  return blockOrder.get(bid) ?? Number.MAX_SAFE_INTEGER;
}

export interface TargetSummary {
  /** Localized kind label + number (e.g. "Figure 3" / "Section 1"), or the whole-document label. */
  label: string;
  /** Creation-time snippet from the snapshot / quote (may be ""). */
  snippet: string;
  /** Containing section path ("1 Introduction › 2.1 Gaia data"), when known. */
  path: string | null;
}

const SNIP_LEN = 80;
const snip = (s: string | undefined): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIP_LEN ? t.slice(0, SNIP_LEN) + "…" : t;
};

/** The list-entry summary of an annotation's target (snapshot-based: it shows
 *  what was annotated at creation time, per the roadmap's snapshot duties). */
export function targetSummary(
  a: Annotation,
  ctx: { sectionOfBlock: Map<string, string>; sectionPath: Map<string, string> }
): TargetSummary {
  const pathOf = (secId: string | null): string | null =>
    secId === null ? null : (ctx.sectionPath.get(secId) ?? null);
  if (a.target.type === "document") {
    return { label: i18n.t("annotation.summary.document"), snippet: "", path: null };
  }
  if (a.target.type === "text") {
    return {
      label: i18n.t("annotation.summary.text"),
      snippet: snip(i18n.t("annotation.summary.quote", { quote: a.target.quote })),
      path: pathOf(ctx.sectionOfBlock.get(a.target.block) ?? null),
    };
  }
  const { kind, snapshot } = a.target;
  const label = kindLabel(kind) + (snapshot.number ? ` ${snapshot.number}` : "");
  const snippetSource =
    kind === "section"
      ? snapshot.heading
      : kind === "paragraph"
        ? snapshot.text
        : kind === "list"
          ? snapshot.items?.[0]
          : kind === "equation"
            ? snapshot.latex
            : (snapshot.caption ?? snapshot.body ?? snapshot.table_body);
  return {
    label,
    snippet: snip(snippetSource),
    // a section target's path is its own; other kinds sit inside a section
    path: kind === "section" ? pathOf(a.target.id) : pathOf(ctx.sectionOfBlock.get(a.target.id) ?? null),
  };
}
