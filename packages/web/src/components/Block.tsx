import type {
  IrAlgorithmBlock,
  IrBlock,
  IrCodeBlock,
  IrEquationBlock,
  IrFigureBlock,
  IrListBlock,
  IrParagraphBlock,
  IrSegment,
  IrTableBlock,
} from "@argelanderspace/contracts";
import { useStore } from "../store";
import { AnnBlockEdge } from "../annotations/AnnBlockEdge";
import { Segments } from "../lib/segments";
import { Math, htmlWithMath } from "../lib/math";
import { FigureImage } from "./FigureImage";

/** True when a caption/body segment run carries any visible content. */
function hasContent(segments: IrSegment[] | undefined): segments is IrSegment[] {
  return (
    segments !== undefined &&
    segments.some((s) => s.type !== "text" || s.text.trim() !== "")
  );
}

export function BlockView({ block }: { block: IrBlock }) {
  switch (block.type) {
    case "paragraph":
      return <ParagraphView b={block} />;
    case "equation":
      return <EquationView b={block} />;
    case "figure":
      return <FigureView b={block} />;
    case "table":
      return <TableView b={block} />;
    case "list":
      return <ListView b={block} />;
    case "code":
    case "algorithm":
      return <CodeView b={block} />;
    default:
      return null;
  }
}

function ParagraphView({ b }: { b: IrParagraphBlock }) {
  if (!hasContent(b.segments)) return null;
  return (
    <Segments
      as="p"
      className="block para"
      segments={b.segments}
      {...({ id: b.id, "data-block-id": b.id } as Record<string, string>)}
    >
      <AnnBlockEdge id={b.id} />
    </Segments>
  );
}

function EquationView({ b }: { b: IrEquationBlock }) {
  return (
    <div className="block eqn" id={b.id} data-block-id={b.id}>
      <div className="eqn-body">
        <Math display latex={b.latex} />
      </div>
      {b.number && <span className="eqn-num">({b.number})</span>}
      <AnnBlockEdge id={b.id} />
    </div>
  );
}

function FigureView({ b }: { b: IrFigureBlock }) {
  const store = useStore();
  const src = store.imageUrl(b.imgPath);
  return (
    <figure className="block fig" id={b.id} data-block-id={b.id}>
      {src && (
        <FigureImage
          src={src}
          alt={b.label || "figure"}
          controls
          width={b.imgWidth}
          height={b.imgHeight}
        />
      )}
      {hasContent(b.captionSegments) && (
        <figcaption className="fig-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          <Segments segments={b.captionSegments} />
        </figcaption>
      )}
      <AnnBlockEdge id={b.id} />
    </figure>
  );
}

function TableView({ b }: { b: IrTableBlock }) {
  const store = useStore();
  return (
    <div className="block tableblock" id={b.id} data-block-id={b.id}>
      {hasContent(b.captionSegments) && (
        <div className="tab-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          <Segments segments={b.captionSegments} />
        </div>
      )}
      {b.tableBody ? (
        <div
          className="tbl-scroll"
          dangerouslySetInnerHTML={{ __html: htmlWithMath(b.tableBody) }}
        />
      ) : (
        store.imageUrl(b.imgPath) && (
          <FigureImage src={store.imageUrl(b.imgPath)!} alt="table" />
        )
      )}
      <AnnBlockEdge id={b.id} />
    </div>
  );
}

function ListView({ b }: { b: IrListBlock }) {
  const Tag = b.ordered ? "ol" : "ul";
  // The annotation edge affordance can't ride inside <ol>/<ul> (only <li> is
  // a valid list child), so the block wrapper is a plain div; the visual
  // result is identical (the list keeps its own margins).
  return (
    <div className="block listblock" id={b.id} data-block-id={b.id}>
      <Tag className="doc-list">
        {b.items.map((it, i) => (
          <li key={i}>
            <Segments segments={it.segments} />
          </li>
        ))}
      </Tag>
      <AnnBlockEdge id={b.id} />
    </div>
  );
}

function CodeView({ b }: { b: IrCodeBlock | IrAlgorithmBlock }) {
  const code = b.body ?? "";
  return (
    <div className="block codeblock" id={b.id} data-block-id={b.id}>
      {hasContent(b.captionSegments) && (
        <div className="tab-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          <Segments segments={b.captionSegments} />
        </div>
      )}
      <pre className="code">{code}</pre>
      <AnnBlockEdge id={b.id} />
    </div>
  );
}
