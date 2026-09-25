import { forwardRef } from "react";
import type {
  IrAlgorithmBlock,
  IrCodeBlock,
  IrEquationBlock,
  IrFigureBlock,
  IrTableBlock,
  Reference,
} from "@argelanderspace/contracts";
import { useReaderSession } from "../doc/ReaderSession";
import { useStore } from "../store";
import { Segments } from "../lib/segments";
import { Math, htmlWithMath, flattenLatex } from "../lib/math";
import { FigureImage } from "./FigureImage";
import { limitTable, parseTable, type ParsedTable } from "../lib/tableparse";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";

export type CardKind = "figure" | "table" | "equation" | "code" | "citation";

export interface Card {
  key: string;
  kind: CardKind;
  block?: IrFigureBlock | IrTableBlock | IrEquationBlock | IrCodeBlock | IrAlgorithmBlock;
  ref?: Reference;
}

const KIND_LABEL: Record<CardKind, string> = {
  figure: "Figure",
  table: "Table",
  equation: "Equation",
  code: "Code",
  citation: "Citation",
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
  const { t } = useTranslation();
  const { canAnnotate } = useReaderSession();
  const canGoto = card.kind !== "citation";
  const canExpand = card.kind !== "citation";

  const gotoId = card.block?.id;

  return (
    // Like body blocks, reference cards must not be native fragment targets
    // while the retained document is unavailable.
    <div
      className={"refcard" + (focused ? " focused" : "")}
      ref={ref}
      data-ui="latex-reference-card" data-ui-key={card.ref?.id ?? card.block?.id}
      id={canAnnotate && card.kind === "citation" ? card.ref!.id : undefined}
    >
      <div className="refcard-head">
        <span className={"refcard-kind k-" + card.kind}>{badge(card)}</span>
        <div className="refcard-main">{cardMain(card, store)}</div>
        {(canGoto || canExpand) && (
          <div className="refcard-actions">
            {canExpand && (
              <ActionButton
                mode="icon"
                unstyled
                iconName={expanded ? "minus" : "plus"}
                label={t(expanded ? "components.referenceCard.collapse" : "components.referenceCard.expand")}
                tooltip={t(expanded ? "components.referenceCard.collapse" : "components.referenceCard.expand")}
                className={"icon-btn" + (expanded ? " on" : "")}
                data-ui="expand-reference-card"
                onClick={onToggleExpand}
              />
            )}
            {canGoto && gotoId && (
              <ActionButton
                mode="icon"
                unstyled
                iconName="corner-up-right"
                label={t("components.referenceCard.jump")}
                tooltip={t("components.referenceCard.jump")}
                className="icon-btn"
                data-ui="jump-to-reference-target"
                onClick={() => store.jumpTo(gotoId)}
              />
            )}
          </div>
        )}
      </div>
      {expanded && canExpand && (
        <div className="refcard-expand">{cardExpand(card)}</div>
      )}
    </div>
  );
});

function badge(card: Card): string {
  const lbl = KIND_LABEL[card.kind];
  if (card.kind === "figure" || card.kind === "table") {
    const b = card.block as IrFigureBlock | IrTableBlock;
    return b?.number ? `${lbl} ${b.number}` : lbl;
  }
  return lbl;
}

function cardMain(card: Card, store: ReturnType<typeof useStore>) {
  switch (card.kind) {
    case "figure": {
      const f = card.block as IrFigureBlock;
      return f.imgPath ? <FigureImage imgPath={f.imgPath} width={f.imgWidth} height={f.imgHeight} alt={f.label || "figure"} /> : <em>(no image)</em>;
    }
    case "equation": {
      const e = card.block as IrEquationBlock;
      return (
        <div className="one-line" style={{ overflowX: "auto" }}>
          <Math latex={flattenLatex(e.latex)} />
        </div>
      );
    }
    case "table": {
      const t = card.block as IrTableBlock;
      if (!t.tableBody && t.imgPath) return <FigureImage imgPath={t.imgPath} alt={t.label || "table"} />;
      const parsed = parseTable(t.tableBody ?? "");
      const small = parsed.totalRows <= 3 && parsed.totalCols <= 4;
      const prev = small ? parsed : limitTable(parsed, 3, parsed.totalCols);
      return (
        <div className={small ? "" : "refcard-clip"}>
          <MiniTable t={prev} />
        </div>
      );
    }
    case "code": {
      const c = card.block as IrCodeBlock | IrAlgorithmBlock;
      const code = c.body ?? "";
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
      return <CitationLine r={r} short={store.bibById.get(r.id)?.short} />;
    }
  }
}

function cardExpand(card: Card) {
  switch (card.kind) {
    case "figure": {
      const f = card.block as IrFigureBlock;
      const cap = f.captionSegments;
      return cap !== undefined && cap.length > 0 ? (
        <div className="fig-cap">
          {f.label && <span className="cap-label">{f.label}. </span>}
          <Segments segments={cap} />
        </div>
      ) : (
        <em>(no caption)</em>
      );
    }
    case "equation": {
      const e = card.block as IrEquationBlock;
      return (
        <div style={{ overflowX: "auto", textAlign: "center" }}>
          <Math display latex={e.latex} />
        </div>
      );
    }
    case "table": {
      const t = card.block as IrTableBlock;
      if (!t.tableBody && t.imgPath) return <FigureImage imgPath={t.imgPath} alt={t.label || "table"} />;
      const parsed = parseTable(t.tableBody ?? "");
      const limited = limitTable(parsed, 8, 4);
      const shownCols = parsed.totalCols > 4 ? 4 : parsed.totalCols;
      const clipped = parsed.totalRows > 8 || parsed.totalCols > 4;
      return (
        <div>
          <MiniTable t={limited} />
          {clipped && (
            <div className="card-meta" style={{ marginTop: 4 }}>
              showing {limited.rows.length}×{shownCols} of {parsed.totalRows}×
              {parsed.totalCols}
            </div>
          )}
        </div>
      );
    }
    case "code": {
      const c = card.block as IrCodeBlock | IrAlgorithmBlock;
      const code = c.body ?? "";
      const lines = code.split("\n");
      return (
        <div>
          <pre className="code">{lines.slice(0, 5).join("\n")}</pre>
          {lines.length > 5 && (
            <div className="card-meta">showing 5 of {lines.length} lines</div>
          )}
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

function CitationLine({ r, short }: { r: Reference; short?: string }) {
  return (
    <div>
      {short && <span className="title-line">{short}. </span>}
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
