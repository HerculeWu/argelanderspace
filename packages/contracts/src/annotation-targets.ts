/**
 * Annotation targets built from the stored IR: ONE implementation for the web Reader (the toolbar, the structure
 * edge buttons) and the Copilot `reader` tool, so an agent-made target is the same target a user would make.
 *
 * - `buildStructureTarget`: the structure target of a section/block with its full, untruncated creation snapshot;
 * - `withAssetHash`: figure/table snapshots take their `asset_hash` from the admitted asset manifest only;
 * - `resolveTextTarget`: a text target from `{block, container, start, end}` in canonical UTF-16 offsets. The same
 *   atomic rule as the DOM selection mapper: an endpoint strictly inside a math/cite/xref segment is expanded to
 *   the whole segment, so the stored range always spans whole atoms and `quote` is exactly the canonical slice.
 *
 * Pure: no DOM, no i18n, no I/O. Nothing here changes the stored annotation format.
 */
import {
  type AnnotationSnapshot,
  type AnnotationStructureTarget,
  type AnnotationTarget,
  type AnnotationTextContainer,
  type AnnotationTextTarget,
  canonicalContainerText,
  canonicalSegmentsText,
  canonicalSegmentText,
} from "./annotations.js";
import type { IrBlock, IrSection, IrSegment } from "./doc-ir.js";
import type { AssetDigest } from "./reader-coherence.js";
import type { TexDocIr } from "./tex-ir.js";

/** Snapshot object with the undefined-valued keys dropped (zod optionals stay absent). */
function clean(o: Record<string, unknown>): AnnotationSnapshot {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as AnnotationSnapshot;
}

const cap = (segments: IrSegment[] | undefined) =>
  segments === undefined ? undefined : canonicalSegmentsText(segments);

/**
 * The structure target for a section/block, snapshot included (per-kind fields; `asset_hash` is added from the
 * accepted manifest by `withAssetHash`). A section arrives as an `IrSection`, distinguished by its `blocks` field.
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
  const base = {
    number: node.type !== "paragraph" && node.type !== "list" ? node.number : undefined,
  };
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

/** Snapshot hashes come only from the accepted coherent manifest; a declared image without a digest throws. */
export function withAssetHash(
  assets: readonly AssetDigest[],
  blockById: ReadonlyMap<string, IrBlock>,
  target: AnnotationTarget
): AnnotationTarget {
  if (target.type !== "structure" || (target.kind !== "figure" && target.kind !== "table"))
    return target;
  const block = blockById.get(target.id);
  const imgPath =
    block && (block.type === "figure" || block.type === "table") ? block.imgPath : undefined;
  if (!imgPath) return target;
  const hash = assets.find((a) => a.imgPath === imgPath)?.sha256;
  if (!hash) throw new Error("Missing accepted asset digest");
  return { ...target, snapshot: { ...target.snapshot, asset_hash: hash } };
}

/** Every block and section of an IR by id (sections are structure-annotation targets too). */
export function irIndex(ir: TexDocIr): {
  blocks: Map<string, IrBlock>;
  sections: Map<string, IrSection>;
} {
  const blocks = new Map<string, IrBlock>();
  const sections = new Map<string, IrSection>();
  const walk = (list: IrSection[]) => {
    for (const section of list) {
      sections.set(section.id, section);
      for (const block of section.blocks) blocks.set(block.id, block);
      walk(section.children);
    }
  };
  walk(ir.sections);
  return { blocks, sections };
}

/** The segments of a text container, or null when the block has no such container. */
function containerSegments(block: IrBlock, container: AnnotationTextContainer): IrSegment[] | null {
  switch (container.type) {
    case "content":
      return block.type === "paragraph" ? block.segments : null;
    case "list_item":
      return block.type === "list" ? (block.items[container.index]?.segments ?? null) : null;
    case "caption":
      return (block.type === "figure" ||
        block.type === "table" ||
        block.type === "code" ||
        block.type === "algorithm") &&
        block.captionSegments !== undefined
        ? block.captionSegments
        : null;
  }
}

export type TextTargetInput = {
  block: string;
  container: AnnotationTextContainer;
  start: number;
  end: number;
  /** When given it must equal the canonical slice of the range AS GIVEN (before atomic expansion). */
  quote?: string;
};
export type TextTargetResult =
  | { ok: true; target: AnnotationTextTarget; expanded: boolean }
  | {
      ok: false;
      reason: "no_block" | "no_container" | "range" | "quote_mismatch";
      detail: string;
    };

/**
 * The text target of one logical container. `no_block`: no such block (sections and references cannot hold text
 * targets); `no_container`: the block has no such container (equation/code/algorithm bodies, table bodies and
 * headings are structure-only); `range`: not `0 <= start < end <= length` of the canonical text;
 * `quote_mismatch`: the offsets do not select the quote the caller meant (a wrong count, or a different epoch).
 */
export function resolveTextTarget(ir: TexDocIr, input: TextTargetInput): TextTargetResult {
  const block = irIndex(ir).blocks.get(input.block);
  if (!block)
    return { ok: false, reason: "no_block", detail: `no block ${input.block} in this document` };
  const segments = containerSegments(block, input.container);
  if (segments === null)
    return {
      ok: false,
      reason: "no_container",
      detail: `block ${block.id} (${block.type}) has no ${input.container.type} text container`,
    };
  const canonical = canonicalContainerText(block, input.container);
  const { start, end } = input;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > canonical.length
  )
    return {
      ok: false,
      reason: "range",
      detail: `the range [${start}, ${end}) is not inside the container text (${canonical.length} UTF-16 code units)`,
    };
  if (input.quote !== undefined && canonical.slice(start, end) !== input.quote)
    return {
      ok: false,
      reason: "quote_mismatch",
      detail: "the quote is not what the container holds at these offsets; read the document again",
    };
  let from = start;
  let to = end;
  let at = 0;
  for (const segment of segments) {
    const length = canonicalSegmentText(segment).length;
    const lo = at;
    const hi = at + length;
    at = hi;
    if (segment.type === "text") continue;
    if (start > lo && start < hi) from = lo;
    if (end > lo && end < hi) to = hi;
  }
  return {
    ok: true,
    expanded: from !== start || to !== end,
    target: {
      type: "text",
      block: block.id,
      container: input.container,
      start: from,
      end: to,
      quote: canonical.slice(from, to),
    },
  };
}
