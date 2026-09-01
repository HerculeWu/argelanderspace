import React from "react";
import type {
  IrBlock,
  IrCiteSegment,
  IrSegment,
  IrXrefSegment,
  IrXrefTarget,
} from "@argelanderspace/contracts";
import { useStore } from "../store";
import { Math } from "./math";

// Segment renderer (Stage 3 / MS2b): the IR carries body text pre-segmented
// into text/math/cite/xref runs with occurrences already paired in core, so
// this module only maps segments to nodes — no token scanning, no positional
// pairing. Chip behavior mirrors the retired richtext.tsx one-to-one.

const KIND_LABEL: Record<string, string> = {
  equation: "Eq.",
  figure: "Fig.",
  table: "Table",
  section: "Sec.",
  algorithm: "Alg.",
  code: "Listing",
};

function prettifyXref(t: IrXrefTarget): string {
  const lbl = t.targetType !== undefined ? KIND_LABEL[t.targetType] : undefined;
  if (lbl !== undefined && t.number !== undefined) return `${lbl} ${t.number}`;
  return t.id;
}

/** Render an IR segment run with inline math + ref chips. */
export function Segments({
  segments,
  as: Tag = "span",
  className,
  ...rest
}: {
  segments: IrSegment[];
  as?: keyof JSX.IntrinsicElements;
  className?: string;
} & Record<string, unknown>) {
  const store = useStore();
  const nodes = React.useMemo(() => renderSegments(segments ?? [], store), [segments, store]);
  return (
    <Tag className={className} {...(rest as Record<string, unknown>)}>
      {nodes}
    </Tag>
  );
}

/** A plain string with only $…$ inline math rendered — for headings and the
 *  doc title, which the IR carries as clean strings (no cite/xref tokens). */
export function MathText({
  text,
  as: Tag = "span",
  className,
  ...rest
}: {
  text: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
} & Record<string, unknown>) {
  const nodes = React.useMemo(() => {
    const src = text ?? "";
    const out: React.ReactNode[] = [];
    // same inline-math rule as the IR scanner ($$ never matches)
    const re = /\$(?!\$)([^$]+?)\$/g;
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) out.push(src.slice(last, m.index));
      out.push(<Math key={key++} latex={m[1]!} />);
      last = re.lastIndex;
    }
    if (last < src.length) out.push(src.slice(last));
    return out;
  }, [text]);
  return (
    <Tag className={className} {...(rest as Record<string, unknown>)}>
      {nodes}
    </Tag>
  );
}

function renderSegments(
  segments: IrSegment[],
  store: ReturnType<typeof useStore>
): React.ReactNode[] {
  return segments.map((seg, i) => {
    switch (seg.type) {
      case "text":
        return seg.text;
      case "math":
        return <Math key={i} latex={seg.latex} />;
      case "cite":
        return citeChip(seg, i, store);
      case "xref":
        return xrefChip(seg, i, store);
    }
  });
}

function citeChip(
  seg: IrCiteSegment,
  key: number,
  store: ReturnType<typeof useStore>
): React.ReactNode {
  const refs = seg.refs;
  const anyUnresolved = refs.length === 0 || refs.some((r) => !r.resolved);
  const label =
    seg.raw ||
    refs.map((r) => (r.resolved && r.short !== undefined ? r.short : r.id)).join("; ") ||
    "?";
  const title = refs
    .map((r) => store.refById.get(r.id)?.raw)
    .filter(Boolean)
    .join("\n");
  const focusId = (refs.find((r) => r.resolved) ?? refs[0])?.id;
  const clickable = !anyUnresolved && focusId !== undefined;
  return (
    <span
      key={key}
      className={"chip cite-chip" + (clickable ? "" : " chip-unresolved")}
      title={title || "unresolved citation"}
      onClick={clickable ? () => store.focusReference(focusId) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                store.focusReference(focusId);
              }
            }
          : undefined
      }
    >
      {label}
    </span>
  );
}

function xrefChip(
  seg: IrXrefSegment,
  key: number,
  store: ReturnType<typeof useStore>
): React.ReactNode {
  const t = seg.target;
  const targetId = t.resolved ? t.id : undefined;
  const label = seg.raw || prettifyXref(t);
  if (!targetId || !store.blockById.has(targetId)) {
    return (
      <span key={key} className="chip xref-chip chip-unresolved" title="target not found">
        {label}
      </span>
    );
  }
  return (
    <span
      key={key}
      className="chip xref-chip"
      title={`go to ${targetId}`}
      role="button"
      tabIndex={0}
      onClick={() => store.jumpTo(targetId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          store.jumpTo(targetId);
        }
      }}
    >
      {label}
    </span>
  );
}

/** Resolved xref target ids mentioned by a block (body, items, caption),
 *  in order, deduped — powers the right panel's float cards. */
export function xrefTargetIds(b: IrBlock): string[] {
  const out: string[] = [];
  const push = (segments: IrSegment[] | undefined) => {
    for (const seg of segments ?? []) {
      if (seg.type === "xref" && seg.target.resolved && !out.includes(seg.target.id)) {
        out.push(seg.target.id);
      }
    }
  };
  switch (b.type) {
    case "paragraph":
      push(b.segments);
      break;
    case "list":
      for (const it of b.items) push(it.segments);
      break;
    case "figure":
    case "table":
    case "code":
    case "algorithm":
      push(b.captionSegments);
      break;
    default:
      break;
  }
  return out;
}
