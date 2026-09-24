/** Cell layout adapter for shared IR: no LaTeX parsing or citation formatting here. */
import { useTranslation } from "react-i18next";
import { currentWriterCellPreview, serializeCell, type IrSegment, type WriterCell, type WriterNumberingResponse } from "@argelanderspace/contracts";
import { Math as TexMath, htmlWithMath } from "../lib/math";
import { MathText, renderIrSegments } from "../lib/segments";
import { assetUrl } from "../api/writer";

export function WriterCellPreview({ cell, cells, docId, numbering, onJump, onCite }: {
  cell: WriterCell;
  cells: WriterCell[];
  docId: string;
  numbering?: WriterNumberingResponse | null;
  onJump?: (id: string) => void;
  onCite?: () => void;
}) {
  const { t } = useTranslation();
  const preview = numbering?.preview;
  const projected = currentWriterCellPreview(preview, cell);
  if (cell.type === "appendix") return <div className="w-appendix-marker">{t("writer.appendixMarker")}</div>;
  if (!projected) return <div className="w-render w-preview-pending" data-ui="cell-preview-pending">
    <div className="w-note" role="status">{t("writer.preview.pending")}</div>
    {cell.type === "figure" && cell.data.image && <img className="w-pending-image" src={assetUrl(docId, cell.data.image)} alt={cell.data.caption} />}
    <pre className="w-source-preview">{serializeCell(cell)}</pre>
  </div>;
  const refs = new Map(preview?.references.map((r) => [r.id, r]));
  const run = (segments: IrSegment[]) => renderIrSegments(segments, {
    cite: (seg, key) => <span key={key} className="w-cite" title={seg.refs.map((r) => refs.get(r.id)?.raw ?? r.id).join("\n")} onClick={onCite}>
      <MathText text={seg.raw ?? "?"} />
    </span>,
    xref: (seg, key) => {
      const owner = preview?.targetCells[seg.target.id];
      const target = cells.find((c) => c.id === owner);
      const valid = target && currentWriterCellPreview(preview, target);
      const text = valid ? seg.raw ?? seg.target.number ?? "?" : seg.raw?.startsWith("(") ? "(?)" : "?";
      return valid && owner ? <button key={key} type="button" className="w-xref w-inline-link" data-ui="preview-crossref" data-ui-key={key} onClick={() => onJump?.(owner)}><MathText text={text} /></button>
        : <span key={key} className="w-xref w-unresolved" title={t("writer.preview.unresolved")}><MathText text={text} /></span>;
    },
  });
  const stale = numbering?.status !== "ok";
  return <div className={`w-render${stale ? " w-preview-stale" : ""}`} data-preview-state={stale ? "stale" : "ok"} data-ui="cell-preview">
    {stale && <div className="w-note" role="status">{t("writer.preview.stale")}</div>}
    {projected.items.map((item) => {
      if (item.kind === "heading") {
        const Tag = `h${Math.min(6, Math.max(2, item.level + 2))}` as "h2" | "h3" | "h4" | "h5" | "h6";
        return <Tag key={item.id}>{item.number && <span className="w-compiled-number">{item.number} </span>}<MathText text={item.heading} /></Tag>;
      }
      const b = item.block;
      if (b.type === "paragraph") return <p key={b.id}>{run(b.segments)}</p>;
      if (b.type === "list") {
        const List = b.ordered ? "ol" : "ul";
        return <List key={b.id}>{b.items.map((v, i) => <li key={i}>{run(v.segments)}</li>)}</List>;
      }
      if (b.type === "equation") return <div className="w-math" key={b.id}>
        {(item.rows ?? [{ latex: b.latex, number: b.number }]).map((row, i) => <div className="w-equation-row" key={i}>
          <TexMath latex={row.latex} display />
          <span className="w-equation-number">{row.number !== undefined && <MathText text={row.tagStar ? row.number : `(${row.number})`} />}</span>
        </div>)}
      </div>;
      const kind = b.type === "figure" ? "writer.figure.figure" : b.type === "table" ? "writer.figure.table" : "writer.figure.listing";
      const caption = <div className="w-caption">{b.number !== undefined && <strong>{t(kind)} {b.number}. </strong>}{run(b.captionSegments ?? [])}</div>;
      if (b.type === "figure") return <figure key={b.id} className="w-ir-figure" data-ui="preview-figure">
        {b.imgPath ? <img src={`/api/writer/manuscripts/${encodeURIComponent(docId)}/preview-assets/${encodeURIComponent(b.imgPath)}`} alt={b.label ?? ""} /> : <div className="w-note">{t("writer.figure.noImage")}</div>}
        {caption}
      </figure>;
      if (b.type === "table") return <div key={b.id} className="w-table-preview" data-ui="preview-table">
        {caption}
        {b.tableBody && <div dangerouslySetInnerHTML={{ __html: htmlWithMath(b.tableBody) }} />}
      </div>;
      return <div key={b.id}>{caption}<pre className="w-code-render">{b.body ?? ""}</pre></div>;
    })}
  </div>;
}
