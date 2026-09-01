import { useMemo, useState } from "react";
import type { IrSection, RefManifestRow } from "@argelanderspace/contracts";
import { useStore, useActiveSectionId } from "../store";
import { MathText } from "../lib/segments";

const KIND_TITLE: Record<string, string> = {
  figure: "Figure",
  table: "Table",
  equation: "Equation",
  code: "Listing",
  algorithm: "Listing",
};

/** In-order flattening of the IR section tree (the TOC is a flat list). */
function flattenSections(secs: IrSection[]): IrSection[] {
  const out: IrSection[] = [];
  const walk = (ss: IrSection[]) => {
    for (const s of ss) {
      out.push(s);
      walk(s.children);
    }
  };
  walk(secs);
  return out;
}

export function TocPanel() {
  const store = useStore();
  const { ir } = store;
  const active = useActiveSectionId();
  const titleId = ir.sections[0]?.id;

  const sections = useMemo(() => flattenSections(ir.sections), [ir]);
  const floatRows = useMemo(
    () => ir.refsManifest.filter((r) => r.kind !== "section"),
    [ir]
  );
  const figures = floatRows.filter((r) => r.kind === "figure");
  const tables = floatRows.filter((r) => r.kind === "table");
  const equations = floatRows.filter((r) => r.kind === "equation");
  const codeFloats = floatRows.filter((r) => r.kind === "code" || r.kind === "algorithm");

  return (
    <div className="toc">
      <div className="panel-title">Contents</div>
      <nav>
        {sections
          .filter((s) => s.id !== titleId)
          .map((s) => (
            <button
              key={s.id}
              className={
                "toc-section toc-lvl-" + s.level + (s.id === active ? " active" : "")
              }
              onClick={() => store.jumpTo(s.id)}
              title={s.heading ?? ""}
            >
              {s.number && <span className="num">{s.number}</span>}
              <MathText as="span" text={s.heading ?? ""} />
            </button>
          ))}
      </nav>

      <FloatGroup title={`Figures (${figures.length})`} items={figures} />
      <FloatGroup title={`Tables (${tables.length})`} items={tables} />
      <FloatGroup
        title={`Equations (${equations.length})`}
        items={equations}
        fallbackLabel="Equation"
      />
      {codeFloats.length > 0 && (
        <FloatGroup title={`Code (${codeFloats.length})`} items={codeFloats} fallbackLabel="Listing" />
      )}
    </div>
  );
}

function FloatGroup({
  title,
  items,
  fallbackLabel,
}: {
  title: string;
  items: RefManifestRow[];
  fallbackLabel?: string;
}) {
  const store = useStore();
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <div className="toc-group">
      <div className="toc-group-title" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"}</span>
        {title}
      </div>
      {open &&
        items.map((it, i) => {
          const label =
            it.number !== undefined
              ? `${KIND_TITLE[it.kind] ?? it.kind} ${it.number}`
              : fallbackLabel
              ? `${fallbackLabel} ${i + 1}`
              : it.id;
          const preview = stripMath(it.short).slice(0, 60);
          return (
            <button
              key={it.id}
              className="toc-float"
              onClick={() => store.jumpTo(it.id)}
              title={stripMath(it.content) || label}
            >
              <span className="num">{label}</span>
              {preview}
            </button>
          );
        })}
    </div>
  );
}

function stripMath(s: string): string {
  return s.replace(/\$[^$]*\$/g, "").replace(/\[\[[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim();
}
