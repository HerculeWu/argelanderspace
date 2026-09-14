import {
  canonicalSegmentsText,
  type Annotation,
  type AssetDigest,
  type AnnotationSnapshot,
  type AnnotationStructureKind,
  type AnnotationStructureTarget,
  type AnnotationTarget,
  type IrBlock,
  type IrSection,
} from "@argelanderspace/contracts";


// Pure annotation helpers (Stage 8 MS3): snapshot building from the render IR
// (roadmap §1 per-kind fields, full and untruncated — the snapshot records
// "what was annotated" for the UI / agent context / future migration input,
// never for automatic re-anchoring), document-order sorting, list summaries,
// and the `a_<8hex>` id factory (same shape as core's randomBytes(4)).

/** Chinese kind labels for the annotation UI (the reader UI is Chinese). */
export const KIND_LABEL: Record<AnnotationStructureKind, string> = {
  section: "章节",
  paragraph: "段落",
  list: "列表",
  equation: "公式",
  figure: "图",
  table: "表",
  code: "代码",
  algorithm: "算法",
};

/** `a_<8 hex>` — crypto.getRandomValues (browser + Node ≥19 share it). */
export function newAnnotationId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "a_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Snapshot object with the undefined-valued keys dropped (zod optionals stay
 *  absent, keeping the stored JSON self-describing). */
function clean(o: Record<string, unknown>): AnnotationSnapshot {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as AnnotationSnapshot;
}

const cap = (segments: Parameters<typeof canonicalSegmentsText>[0] | undefined) =>
  segments === undefined ? undefined : canonicalSegmentsText(segments);

/**
 * The structure target for a section/block, snapshot included (per-kind fields
 * from roadmap §1; `asset_hash` is added from the accepted manifest by
 * `withAssetHash`). `blockById` registers sections too
 * (as the heading jump targets), so an `IrSection` arrives cast as a block —
 * distinguished by the `blocks` field.
 */
export function buildStructureTarget(node: IrBlock | IrSection): AnnotationStructureTarget {
  if ("blocks" in node) {
    return {
      type: "structure",
      id: node.id,
      kind: "section",
      snapshot: clean({ number: node.number, heading: node.heading }),
    };
  }
  const base = { number: node.type !== "paragraph" && node.type !== "list" ? node.number : undefined };
  switch (node.type) {
    case "paragraph":
      return {
        type: "structure",
        id: node.id,
        kind: "paragraph",
        snapshot: clean({ text: canonicalSegmentsText(node.segments) }),
      };
    case "list":
      return {
        type: "structure",
        id: node.id,
        kind: "list",
        snapshot: clean({
          ordered: node.ordered,
          items: node.items.map((it) => canonicalSegmentsText(it.segments)),
        }),
      };
    case "equation":
      return {
        type: "structure",
        id: node.id,
        kind: "equation",
        snapshot: clean({ ...base, label: node.label, latex: node.latex }),
      };
    case "figure":
      return {
        type: "structure",
        id: node.id,
        kind: "figure",
        snapshot: clean({
          ...base,
          label: node.label,
          caption: cap(node.captionSegments),
          footnote: node.footnote,
        }),
      };
    case "table":
      return {
        type: "structure",
        id: node.id,
        kind: "table",
        snapshot: clean({
          ...base,
          label: node.label,
          caption: cap(node.captionSegments),
          footnote: node.footnote,
          table_body: node.tableBody,
        }),
      };
    case "code":
      return {
        type: "structure",
        id: node.id,
        kind: "code",
        snapshot: clean({
          ...base,
          label: node.label,
          caption: cap(node.captionSegments),
          lang: node.lang,
          body: node.body,
        }),
      };
    case "algorithm":
      return {
        type: "structure",
        id: node.id,
        kind: "algorithm",
        snapshot: clean({
          ...base,
          label: node.label,
          caption: cap(node.captionSegments),
          body: node.body,
        }),
      };
  }
}

/** Snapshot hashes come only from the accepted coherent manifest. */
export function withAssetHash(
  assets: AssetDigest[],
  blockById: Map<string, IrBlock>,
  target: AnnotationTarget
): AnnotationTarget {
  if (target.type !== "structure" || (target.kind !== "figure" && target.kind !== "table")) return target;
  const block = blockById.get(target.id);
  const imgPath = block && (block.type === "figure" || block.type === "table") ? block.imgPath : undefined;
  if (!imgPath) return target;
  const hash = assets.find((a) => a.imgPath === imgPath)?.sha256;
  if (!hash) throw new Error("Missing accepted asset digest");
  return { ...target, snapshot: { ...target.snapshot, asset_hash: hash } };
}

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
  /** Kind label + number, e.g. "图 3" / "章节 1" / "整篇文档". */
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
    return { label: "整篇文档", snippet: "", path: null };
  }
  if (a.target.type === "text") {
    return {
      label: "文本标注",
      snippet: snip(`「${a.target.quote}」`),
      path: pathOf(ctx.sectionOfBlock.get(a.target.block) ?? null),
    };
  }
  const { kind, snapshot } = a.target;
  const label = KIND_LABEL[kind] + (snapshot.number ? ` ${snapshot.number}` : "");
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
