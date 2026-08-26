import type {
  Block,
  Caption,
  CodeBlock,
  Equation,
  Figure,
  ListBlock,
  Paragraph,
  TableBlock,
} from "../types";
import { useStore } from "../store";
import { RichText } from "../lib/richtext";
import { Math, htmlWithMath } from "../lib/math";
import { FigureImage } from "./FigureImage";

export function captionText(cap: Caption | undefined): string {
  if (!cap) return "";
  return typeof cap === "string" ? cap : cap.text ?? "";
}

export function BlockView({ block }: { block: Block }) {
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

function ParagraphView({ b }: { b: Paragraph }) {
  const store = useStore();
  if (!b.text?.trim()) return null;
  return (
    <RichText
      as="p"
      className="block para"
      text={b.text}
      citations={store.citationsByBlock.get(b.id)}
      crossrefs={store.crossrefsByBlock.get(b.id)}
      {...({ id: b.id, "data-block-id": b.id } as Record<string, string>)}
    />
  );
}

function EquationView({ b }: { b: Equation }) {
  return (
    <div className="block eqn" id={b.id} data-block-id={b.id}>
      <div className="eqn-body">
        <Math display latex={b.latex} />
      </div>
      {b.number && <span className="eqn-num">({b.number})</span>}
    </div>
  );
}

function FigureView({ b }: { b: Figure }) {
  const store = useStore();
  const src = store.imageUrl(b.img_path);
  const cap = captionText(b.caption);
  return (
    <figure className="block fig" id={b.id} data-block-id={b.id}>
      {src && <FigureImage src={src} alt={b.label || "figure"} controls />}
      {cap && (
        <figcaption className="fig-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          <RichText
            text={cap}
            citations={store.citationsByBlock.get(b.id)}
            crossrefs={store.crossrefsByBlock.get(b.id)}
          />
        </figcaption>
      )}
    </figure>
  );
}

function TableView({ b }: { b: TableBlock }) {
  const store = useStore();
  const cap = captionText(b.caption);
  return (
    <div className="block tableblock" id={b.id} data-block-id={b.id}>
      {cap && (
        <div className="tab-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          <RichText
            text={cap}
            citations={store.citationsByBlock.get(b.id)}
            crossrefs={store.crossrefsByBlock.get(b.id)}
          />
        </div>
      )}
      {b.table_body ? (
        <div
          className="tbl-scroll"
          dangerouslySetInnerHTML={{ __html: htmlWithMath(b.table_body) }}
        />
      ) : (
        store.imageUrl(b.img_path) && (
          <FigureImage src={store.imageUrl(b.img_path)!} alt="table" />
        )
      )}
    </div>
  );
}

function ListView({ b }: { b: ListBlock }) {
  const Tag = b.ordered ? "ol" : "ul";
  return (
    <Tag className="doc-list block" id={b.id} data-block-id={b.id}>
      {b.items.map((it, i) => (
        <li key={i}>
          <RichText text={it.text} citations={it.citations} crossrefs={it.crossrefs} />
        </li>
      ))}
    </Tag>
  );
}

function CodeView({ b }: { b: CodeBlock }) {
  const cap = captionText(b.caption);
  const code = b.body ?? "";
  return (
    <div className="block codeblock" id={b.id} data-block-id={b.id}>
      {cap && (
        <div className="tab-cap">
          {b.label && <span className="cap-label">{b.label}. </span>}
          {cap}
        </div>
      )}
      <pre className="code">{code}</pre>
    </div>
  );
}
