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
// pairing. Chip behavior mirrors the retired richtext.tsx, with one Stage 6
// deviation: multi-ref cite groups render as per-ref chips (wrapped text can
// break between chips) instead of one indivisible group chip.

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

/** Render an IR segment run with inline math + ref chips. `children`, when
 *  given, render AFTER the segment nodes inside the same element (Stage 8: the
 *  per-block annotation affordance rides along without touching the text). */
export function Segments({
  segments,
  as: Tag = "span",
  className,
  children,
  ...rest
}: {
  segments: IrSegment[];
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  children?: React.ReactNode;
} & Record<string, unknown>) {
  const store = useStore();
  const nodes = React.useMemo(() => renderSegments(segments ?? [], store), [segments, store]);
  return (
    <Tag className={className} {...(rest as Record<string, unknown>)}>
      {nodes}
      {children}
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

/** Split a multi-cite raw into its outer wrapper + per-ref visible fragments
 *  on the group separator ("; " in every form the fuser reconstructs —
 *  NormalCitation "(A 1934; B 1940)", AuthorInText "A (1934); B (1940)",
 *  aliases). Returns undefined for single refs, and for raws that won't split
 *  into exactly the ref count (pathological keys keep the legacy one-chip
 *  shape so the visible text survives verbatim). */
function splitCiteRaw(
  raw: string | undefined,
  refs: IrCiteSegment["refs"]
): { open: string; parts: string[]; close: string } | undefined {
  if (refs.length < 2) return undefined;
  if (raw === undefined) {
    return {
      open: "",
      parts: refs.map((r) => (r.resolved && r.short !== undefined ? r.short : r.id)),
      close: "",
    };
  }
  let s = raw;
  let open = "";
  let close = "";
  const closeFor: Record<string, string> = { "(": ")", "[": "]" };
  const closer = closeFor[s.charAt(0)];
  if (closer !== undefined && s.endsWith(closer)) {
    open = s.charAt(0);
    close = closer;
    s = s.slice(1, -1);
  }
  const parts = s.split("; ");
  if (parts.length !== refs.length) return undefined;
  return { open, parts, close };
}

function citeChip(
  seg: IrCiteSegment,
  key: number,
  store: ReturnType<typeof useStore>
): React.ReactNode {
  const refs = seg.refs;
  const group = splitCiteRaw(seg.raw, refs);
  if (group !== undefined) {
    // per-ref chips: wrapper and "; " separators stay plain text so the run
    // can wrap between chips (a chip itself never breaks — .chip nowrap)
    return (
      <React.Fragment key={key}>
        {group.open}
        {group.parts.map((part, i) => {
          const r = refs[i]!;
          const resolved = r.resolved;
          const raw = store.refById.get(r.id)?.raw;
          return (
            <React.Fragment key={`${r.id}:${i}`}>
              {i > 0 ? "; " : null}
              <span
                className={"chip cite-chip" + (resolved ? "" : " chip-unresolved")}
                title={raw ?? (resolved ? undefined : "unresolved citation")}
                onClick={resolved ? () => store.focusReference(r.id) : undefined}
                role={resolved ? "button" : undefined}
                tabIndex={resolved ? 0 : undefined}
                onKeyDown={
                  resolved
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          store.focusReference(r.id);
                        }
                      }
                    : undefined
                }
              >
                {part}
              </span>
            </React.Fragment>
          );
        })}
        {group.close}
      </React.Fragment>
    );
  }
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
