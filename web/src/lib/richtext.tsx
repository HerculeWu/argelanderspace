import React from "react";
import type { Citation, CrossRef } from "../types";
import { useStore } from "../store";
import { Math } from "./math";

// One combined scanner for: inline math $...$, cite tokens, xref tokens.
const SCAN =
  /\$(?!\$)([^$]+?)\$|\[\[cite:([^\]]+)\]\]|\[\[xref:([^\]]+)\]\]/g;

const KIND_LABEL: Record<string, string> = {
  equation: "Eq.",
  figure: "Fig.",
  table: "Table",
  section: "Sec.",
  algorithm: "Alg.",
  code: "Listing",
};

function prettifyXref(payload: string): string {
  const clean = payload.replace(/\?$/, "");
  const m = clean.match(/^([a-z]+)-(.+)$/i);
  if (m && KIND_LABEL[m[1].toLowerCase()]) {
    return `${KIND_LABEL[m[1].toLowerCase()]} ${m[2]}`;
  }
  return clean;
}

interface Opts {
  citations?: Citation[];
  crossrefs?: CrossRef[];
}

/** Render body text / caption / table-cell text with inline math + ref chips. */
export function RichText({
  text,
  citations,
  crossrefs,
  as: Tag = "span",
  className,
  ...rest
}: Opts & {
  text: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
} & Record<string, unknown>) {
  const store = useStore();
  const nodes = React.useMemo(
    () => renderNodes(text ?? "", { citations, crossrefs }, store),
    [text, citations, crossrefs, store]
  );
  return (
    <Tag className={className} {...(rest as Record<string, unknown>)}>
      {nodes}
    </Tag>
  );
}

function renderNodes(
  text: string,
  opts: Opts,
  store: ReturnType<typeof useStore>
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const cites = [...(opts.citations ?? [])];
  const xrefs = [...(opts.crossrefs ?? [])];
  let last = 0;
  let key = 0;
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = SCAN.lastIndex;
    if (m[1] !== undefined) {
      out.push(<Math key={key++} latex={m[1]} />);
    } else if (m[2] !== undefined) {
      out.push(citeChip(m[2], cites.shift(), key++, store));
    } else if (m[3] !== undefined) {
      out.push(xrefChip(m[3], xrefs.shift(), key++, store));
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function citeChip(
  payload: string,
  occ: Citation | undefined,
  key: number,
  store: ReturnType<typeof useStore>
): React.ReactNode {
  const refIds =
    occ?.ref_ids?.length
      ? occ.ref_ids
      : payload === "?"
      ? []
      : payload.split(";").map((s) => s.trim());
  const resolved = (occ ? occ.resolved : refIds.length > 0) && refIds.length > 0;
  const label = occ?.raw || refIds.map((id) => citeShort(id, store)).join("; ") || "?";
  const title = refIds
    .map((id) => store.refById.get(id)?.raw)
    .filter(Boolean)
    .join("\n");
  return (
    <span
      key={key}
      className={"chip cite-chip" + (resolved ? "" : " chip-unresolved")}
      title={title || "unresolved citation"}
      onClick={resolved ? () => store.focusReference(refIds[0]) : undefined}
      role={resolved ? "button" : undefined}
      tabIndex={resolved ? 0 : undefined}
      onKeyDown={
        resolved
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                store.focusReference(refIds[0]);
              }
            }
          : undefined
      }
    >
      {label}
    </span>
  );
}

function citeShort(refId: string, store: ReturnType<typeof useStore>): string {
  const r = store.refById.get(refId);
  if (!r) return refId;
  const a = r.authors ?? [];
  const yr = r.year ? ` ${r.year}` : "";
  if (a.length === 0) return refId + yr;
  if (a.length === 1) return `${a[0]}${yr}`;
  if (a.length === 2) return `${a[0]} & ${a[1]}${yr}`;
  return `${a[0]} et al.${yr}`;
}

function xrefChip(
  payload: string,
  occ: CrossRef | undefined,
  key: number,
  store: ReturnType<typeof useStore>
): React.ReactNode {
  const unresolved = payload.endsWith("?") || occ?.resolved === false;
  const targetId = occ?.target_id || (unresolved ? undefined : payload);
  const label = occ?.raw || prettifyXref(payload);
  if (unresolved || !targetId || !store.blockById.has(targetId)) {
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
