import { forwardRef } from "react";
import type {
  CodeBlock,
  Equation,
  Figure,
  Reference,
  Symbol as Sym,
  TableBlock,
} from "../types";
import { useStore } from "../store";
import { RichText } from "../lib/richtext";
import { Math, htmlWithMath, flattenLatex } from "../lib/math";
import { captionText } from "./Block";
import { limitTable, parseTable, type ParsedTable } from "../lib/tableparse";

export type CardKind = "figure" | "table" | "equation" | "code" | "citation" | "symbol";

export interface Card {
  key: string;
  kind: CardKind;
  block?: Figure | TableBlock | Equation | CodeBlock;
  ref?: Reference;
  sym?: Sym;
}

const KIND_LABEL: Record<CardKind, string> = {
  figure: "Figure",
  table: "Table",
  equation: "Equation",
  code: "Code",
  citation: "Citation",
  symbol: "Symbol",
};

interface Props {
  card: Card;
  expanded: boolean;
  focused: boolean;
  onToggleExpand: () => void;
}

export const RefCard = forwardRef<HTMLDivElement, Props>(function RefCard(
  { card, expanded, focused, onToggleExpand },
  ref
) {
  const store = useStore();
  const canGoto = card.kind !== "citation";
  const canExpand = card.kind !== "citation";

  const gotoId =
    card.kind === "symbol" ? card.sym?.first_block_id ?? undefined : card.block?.id;

  return (
    <div className={"refcard" + (focused ? " focused" : "")} ref={ref}>
      <div className="refcard-head">
        <span className={"refcard-kind k-" + card.kind}>{badge(card)}</span>
        <div className="refcard-main">{cardMain(card, store)}</div>
        {(canGoto || canExpand) && (
          <div className="refcard-actions">
            {canExpand && (
              <button
                className={"icon-btn" + (expanded ? " on" : "")}
                onClick={onToggleExpand}
                title={expanded ? "Collapse" : "Expand inline"}
              >
                {expanded ? "−" : "+"}
              </button>
            )}
            {canGoto && gotoId && (
              <button
                className="icon-btn"
                onClick={() => store.jumpTo(gotoId)}
                title="Go to in document"
              >
                ⤴
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && canExpand && (
        <div className="refcard-expand">{cardExpand(card, store)}</div>
      )}
    </div>
  );
});

function badge(card: Card): string {
  const lbl = KIND_LABEL[card.kind];
  if (card.kind === "figure" || card.kind === "table") {
    const b = card.block as Figure | TableBlock;
    return b?.number ? `${lbl} ${b.number}` : lbl;
  }
  return lbl;
}

function cardMain(card: Card, store: ReturnType<typeof useStore>) {
  switch (card.kind) {
    case "figure": {
      const f = card.block as Figure;
      const src = store.imageUrl(f.img_path);
      return src ? <img src={src} alt={f.label || "figure"} /> : <em>(no image)</em>;
    }
    case "equation": {
      const e = card.block as Equation;
      return (
        <div className="one-line" style={{ overflowX: "auto" }}>
          <Math latex={flattenLatex(e.latex)} />
        </div>
      );
    }
    case "table": {
      const t = card.block as TableBlock;
      const parsed = parseTable(t.table_body);
      const small = parsed.totalRows <= 3 && parsed.totalCols <= 4;
      const prev = small ? parsed : limitTable(parsed, 3, parsed.totalCols);
      return (
        <div className={small ? "" : "refcard-clip"}>
          <MiniTable t={prev} />
        </div>
      );
    }
    case "code": {
      const c = card.block as CodeBlock;
      const code = c.code ?? c.text ?? "";
      const lines = code.split("\n");
      const small = lines.length <= 3;
      return (
        <pre className="code" style={{ maxHeight: small ? undefined : 60, overflow: "hidden" }}>
          {lines.slice(0, 3).join("\n")}
        </pre>
      );
    }
    case "citation": {
      const r = card.ref!;
      return <CitationLine r={r} />;
    }
    case "symbol": {
      const s = card.sym!;
      const desc = s.def_guess || s.context || null;
      return (
        <div>
          <span className="sym-glyph">
            <Math latex={s.symbol} />
          </span>{" "}
          {desc ? <span className="sym-def">{desc}</span> : <span className="sym-meta">(no description)</span>}
        </div>
      );
    }
  }
}

function cardExpand(card: Card, store: ReturnType<typeof useStore>) {
  switch (card.kind) {
    case "figure": {
      const f = card.block as Figure;
      const cap = captionText(f.caption);
      return cap ? (
        <div className="fig-cap">
          {f.label && <span className="cap-label">{f.label}. </span>}
          <RichText
            text={cap}
            citations={store.citationsByBlock.get(f.id)}
            crossrefs={store.crossrefsByBlock.get(f.id)}
          />
        </div>
      ) : (
        <em>(no caption)</em>
      );
    }
    case "equation": {
      const e = card.block as Equation;
      return (
        <div style={{ overflowX: "auto", textAlign: "center" }}>
          <Math display latex={e.latex} />
        </div>
      );
    }
    case "table": {
      const t = card.block as TableBlock;
      const parsed = parseTable(t.table_body);
      const limited = limitTable(parsed, 8, 4);
      const shownCols = parsed.totalCols > 4 ? 4 : parsed.totalCols;
      const clipped = parsed.totalRows > 8 || parsed.totalCols > 4;
      return (
        <div>
          <MiniTable t={limited} />
          {clipped && (
            <div className="sym-meta" style={{ marginTop: 4 }}>
              showing {limited.rows.length}×{shownCols} of {parsed.totalRows}×
              {parsed.totalCols}
            </div>
          )}
        </div>
      );
    }
    case "code": {
      const c = card.block as CodeBlock;
      const code = c.code ?? c.text ?? "";
      const lines = code.split("\n");
      return (
        <div>
          <pre className="code">{lines.slice(0, 5).join("\n")}</pre>
          {lines.length > 5 && (
            <div className="sym-meta">showing 5 of {lines.length} lines</div>
          )}
        </div>
      );
    }
    case "symbol": {
      const s = card.sym!;
      return (
        <div>
          <div className="sym-meta">
            used {s.count}×
            {s.first_page != null ? ` · first on p.${s.first_page + 1}` : ""}
          </div>
          {s.context ? <RichText text={s.context} /> : <em>(no context found)</em>}
        </div>
      );
    }
    default:
      return null;
  }
}

function MiniTable({ t }: { t: ParsedTable }) {
  return (
    <table>
      <tbody>
        {t.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} dangerouslySetInnerHTML={{ __html: htmlWithMath(cell) }} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CitationLine({ r }: { r: Reference }) {
  const authors = r.authors ?? [];
  let who = "";
  if (authors.length === 1) who = authors[0];
  else if (authors.length === 2) who = `${authors[0]} & ${authors[1]}`;
  else if (authors.length > 2) who = `${authors[0]} et al.`;
  const head = [who, r.year].filter(Boolean).join(" ");
  return (
    <div>
      {head && <span className="title-line">{head}. </span>}
      <span>{r.raw}</span>
      {r.doi && (
        <>
          {" "}
          <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
            doi
          </a>
        </>
      )}
    </div>
  );
}
