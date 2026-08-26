import { useMemo, useState } from "react";
import type { Block, IndexFloat } from "../types";
import { useStore, useActiveSectionId } from "../store";
import { captionText } from "./Block";
import { RichText } from "../lib/richtext";

export function TocPanel() {
  const store = useStore();
  const { doc } = store;
  const active = useActiveSectionId();
  const titleId = doc.structure[0]?.id;

  const codeFloats = useMemo<IndexFloat[]>(() => {
    const out: IndexFloat[] = [];
    for (const b of store.blockById.values() as IterableIterator<Block>) {
      if (b.type === "code" || b.type === "algorithm") {
        out.push({
          id: b.id,
          page_idx: b.page_idx,
          number: b.number,
          label: b.label,
          caption: captionText(b.caption),
        });
      }
    }
    return out;
  }, [store]);

  return (
    <div className="toc">
      <div className="panel-title">Contents</div>
      <nav>
        {doc.index.sections
          .filter((s) => s.id !== titleId)
          .map((s) => (
            <button
              key={s.id}
              className={
                "toc-section toc-lvl-" + s.level + (s.id === active ? " active" : "")
              }
              onClick={() => store.jumpTo(s.id)}
              title={s.heading}
            >
              {s.number && <span className="num">{s.number}</span>}
              <RichText as="span" text={s.heading} />
            </button>
          ))}
      </nav>

      <FloatGroup title={`Figures (${doc.index.figures.length})`} items={doc.index.figures} />
      <FloatGroup title={`Tables (${doc.index.tables.length})`} items={doc.index.tables} />
      <FloatGroup
        title={`Equations (${doc.index.equations.length})`}
        items={doc.index.equations}
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
  items: IndexFloat[];
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
          const label = it.label || (fallbackLabel ? `${fallbackLabel} ${i + 1}` : it.id);
          return (
            <button
              key={it.id}
              className="toc-float"
              onClick={() => store.jumpTo(it.id)}
              title={it.caption || label}
            >
              <span className="num">{label}</span>
              {it.caption ? stripMath(it.caption).slice(0, 60) : ""}
            </button>
          );
        })}
    </div>
  );
}

function stripMath(s: string): string {
  return s.replace(/\$[^$]*\$/g, "").replace(/\[\[[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim();
}
