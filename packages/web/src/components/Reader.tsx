import type { IrSection } from "@argelanderspace/contracts";
import { useStore } from "../store";
import { BlockView } from "./Block";
import { MathText } from "../lib/segments";

export function Reader() {
  const store = useStore();
  const { ir } = store;

  return (
    <main className="reader" ref={store.registerReader}>
      <div className="reader-inner">
        {ir.sections.map((sec, i) => (
          <SectionView key={sec.id} sec={sec} first={i === 0} />
        ))}
      </div>
    </main>
  );
}

function SectionView({ sec, first }: { sec: IrSection; first: boolean }) {
  const Heading = headingTag(sec.level);
  return (
    <section>
      {first ? (
        <h1 className="doc-title block" id={sec.id} data-block-id={sec.id}>
          <MathText as="span" text={sec.heading ?? ""} />
        </h1>
      ) : (
        <Heading className="sec block" id={sec.id} data-block-id={sec.id}>
          {sec.number && <span className="sec-num">{sec.number}</span>}
          <MathText as="span" text={sec.heading ?? ""} />
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
