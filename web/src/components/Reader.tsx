import { useMemo } from "react";
import type { Section } from "../types";
import { useStore } from "../store";
import { BlockView } from "./Block";

export function Reader() {
  const store = useStore();
  const { doc } = store;
  const numberById = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const s of doc.index.sections) m.set(s.id, s.number);
    return m;
  }, [doc]);

  return (
    <main className="reader" ref={store.registerReader}>
      <div className="reader-inner">
        {doc.structure.map((sec, i) => (
          <SectionView key={sec.id} sec={sec} first={i === 0} numberById={numberById} />
        ))}
      </div>
    </main>
  );
}

function SectionView({
  sec,
  first,
  numberById,
}: {
  sec: Section;
  first: boolean;
  numberById: Map<string, string | undefined>;
}) {
  const num = numberById.get(sec.id);
  const Heading = headingTag(sec.level);
  return (
    <section>
      {first ? (
        <h1 className="doc-title block" id={sec.id} data-block-id={sec.id}>
          {sec.heading}
        </h1>
      ) : (
        <Heading className="sec block" id={sec.id} data-block-id={sec.id}>
          {num && <span className="sec-num">{num}</span>}
          {sec.heading}
        </Heading>
      )}
      {sec.blocks.map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
      {sec.children?.map((c) => (
        <SectionView key={c.id} sec={c} first={false} numberById={numberById} />
      ))}
    </section>
  );
}

function headingTag(level: number): "h2" | "h3" | "h4" {
  if (level <= 1) return "h2";
  if (level === 2) return "h3";
  return "h4";
}
