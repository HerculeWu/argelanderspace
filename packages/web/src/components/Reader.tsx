import type { IrSection } from "@argelanderspace/contracts";
import { useReaderSession } from "../doc/ReaderSession";
import { useStore } from "../store";
import { AnnBlockEdge } from "../annotations/AnnBlockEdge";
import { AnnotationPopover } from "../annotations/AnnotationPopover";
import { TextAnnotations } from "../annotations/TextAnnotations";
import { AuthorBlock } from "./AuthorBlock";
import { BlockView } from "./Block";
import { MathText } from "../lib/segments";

export function Reader() {
  const store = useStore();
  const { ir } = store;

  return (
    <main className="reader" data-ui="latex-document" ref={store.registerReader}>
      <div className="reader-inner">
        <AuthorBlock />
        {ir.sections.map((sec, i) => (
          <SectionView key={sec.id} sec={sec} first={i === 0} />
        ))}
      </div>
      {/* Stage 8: the annotation popover lives inside <main class="reader"> so
          its block lookups stay scoped to this pane in split-view. */}
      <AnnotationPopover />
      {/* Stage 8 MS4: text selection capture, highlight painting, chooser. */}
      <TextAnnotations />
    </main>
  );
}

function SectionView({ sec, first }: { sec: IrSection; first: boolean }) {
  const Heading = headingTag(sec.level);
  const { canAnnotate } = useReaderSession();
  return (
    <section>
      {first ? (
        <h1 className="doc-title block" id={canAnnotate ? sec.id : undefined} data-block-id={sec.id} data-ui="latex-section" data-ui-key={sec.id}>
          <MathText as="span" text={sec.heading ?? ""} />
          <AnnBlockEdge id={sec.id} />
        </h1>
      ) : (
        <Heading className="sec block" id={canAnnotate ? sec.id : undefined} data-block-id={sec.id} data-ui="latex-section" data-ui-key={sec.id}>
          {sec.number && <span className="sec-num">{sec.number}</span>}
          <MathText as="span" text={sec.heading ?? ""} />
          <AnnBlockEdge id={sec.id} />
        </Heading>
      )}
      {sec.blocks.map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
      {sec.children.map((c) => (
        <SectionView key={c.id} sec={c} first={false} />
      ))}
    </section>
  );
}

function headingTag(level: number): "h2" | "h3" | "h4" {
  if (level <= 1) return "h2";
  if (level === 2) return "h3";
  return "h4";
}
