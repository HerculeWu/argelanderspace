import { useMemo, useState, type ReactNode } from "react";
import type { IrSection, RefManifestRow } from "@argelanderspace/contracts";
import { useStore, useActiveSectionId } from "../store";
import { MathText } from "../lib/segments";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";

const KIND_TITLE: Record<string, string> = {
  figure: "Figure",
  table: "Table",
  equation: "Equation",
  code: "Listing",
  algorithm: "Listing",
};

export interface OutlineEntry {
  id: string;
  title: string;
  level: number;
  number?: string;
  disabled?: boolean;
}

/** Shared outline list presentation for LaTeX sections and native PDF bookmarks. */
export function OutlineList({ items, onSelect, activeId, renderTitle }: { items: OutlineEntry[]; onSelect: (id: string) => void; activeId?: string | null; renderTitle?: (item: OutlineEntry) => ReactNode }) {
  return <nav data-ui="outline-list">{items.map((item) => <button key={item.id} data-ui="outline-item" data-ui-key={item.id} className={"toc-section toc-lvl-" + Math.min(6, Math.max(1, item.level)) + (item.id === activeId ? " active" : "")} onClick={() => onSelect(item.id)} disabled={item.disabled} title={item.title}>
    {item.number && <span className="num">{item.number}</span>}{renderTitle ? renderTitle(item) : item.title}
  </button>)}</nav>;
}

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
  const { t } = useTranslation();
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
    <div className="toc" data-ui="latex-outline">
      <div className="panel-title">{t("components.outline.contents")}</div>
      <OutlineList items={sections.filter((s) => s.id !== titleId).map((s) => ({ id: s.id, title: s.heading ?? "", level: s.level, ...(s.number ? { number: s.number } : {}) }))} onSelect={store.jumpTo} activeId={active} renderTitle={(item) => <MathText as="span" text={item.title} />} />

      <FloatGroup id="figure" title={t("components.outline.figures")} items={figures} />
      <FloatGroup id="table" title={t("components.outline.tables")} items={tables} />
      <FloatGroup id="equation" title={t("components.outline.equations")} items={equations} fallbackLabel="Equation" />
      {codeFloats.length > 0 && (
        <FloatGroup id="code" title={t("components.outline.code")} items={codeFloats} fallbackLabel="Listing" />
      )}
    </div>
  );
}

function FloatGroup({
  id,
  title,
  items,
  fallbackLabel,
}: {
  id: string;
  title: string;
  items: RefManifestRow[];
  fallbackLabel?: string;
}) {
  const store = useStore();
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <div className="toc-group" data-ui="outline-group" data-ui-key={id}>
      <ActionButton
        unstyled
        mode="text"
        label={`${title} (${items.length})`}
        tooltip={open ? t("doc.actions.collapseOutline") : t("doc.actions.expandOutline")}
        className="toc-group-title"
        data-ui="toggle-outline-group"
        data-ui-key={id}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {title} ({items.length})
      </ActionButton>
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
              data-ui="outline-float" data-ui-key={it.id}
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

/**
 * Plain-text cleanup of a caption's token-expanded markdown (core
 * `segmentsMarkdown` output) for the TOC float preview/tooltip — display
 * only. Cite tokens keep their readable short label (`[cite: ref-1 | Bok
 * 1934 | title: …]` → "Bok 1934"; unresolved/short-less ones drop), xref
 * tokens keep their printed number (`[ref: f | figure | number: 3 | …]` →
 * "3"; resolved but unnumbered falls back to the trailing heading/preview
 * text), math and `[[…]]` links are stripped, whitespace collapses. Kept
 * fragments carry a leading space so adjacent tokens (`\citep{a,b}`) don't
 * fuse into one word. Tokens truncated mid-way by core's ingest-time preview
 * truncation (`refsManifest` cuts `short` at ~60 chars, possibly inside an
 * xref token whose embedded target preview makes it longer) never close, so
 * a dangling `[cite:`/`[ref:` tail is dropped outright — nothing readable
 * follows the cut.
 */
export function stripMath(s: string): string {
  return s
    .replace(/\[(cite|ref): [^\]]*$/g, "")
    .replace(/\[cite: ([^\]]+)\]/g, (_m, inner: string) => {
      const short = inner.split(" | ")[1];
      return short && short !== "unresolved" ? ` ${short}` : "";
    })
    .replace(/\[ref: ([^\]]+)\]/g, (_m, inner: string) => {
      const parts = inner.split(" | ");
      const num = parts.find((p) => p.startsWith("number: "));
      if (num !== undefined) return ` ${num.slice("number: ".length)}`;
      // resolved but unnumbered: the trailing part is the heading/preview text
      if (parts[1] !== "unresolved" && parts[2]) return ` ${parts[2]}`;
      return "";
    })
    .replace(/\$[^$]*\$/g, "")
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
