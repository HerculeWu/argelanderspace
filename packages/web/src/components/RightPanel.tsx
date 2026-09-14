import { useReaderSession } from "../doc/ReaderSession";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore, useVisibleIds } from "../store";
import { useAnnotations } from "../annotations/AnnotationStore";
import { AnnotationsPanel } from "../annotations/AnnotationsPanel";
import { xrefTargetIds } from "../lib/segments";
import { RefCard, type Card, type CardKind } from "./RefCard";

function floatKind(t: string): CardKind | null {
  if (t === "figure") return "figure";
  if (t === "table") return "table";
  if (t === "equation") return "equation";
  if (t === "code" || t === "algorithm") return "code";
  return null; // sections etc. are not shown as cards
}

// Right-panel tabs (Stage 8 MS3): 引用 (the pre-existing in-view cards, still
// the default) | 标注 (the doc's annotations, with a count badge). Creating an
// annotation never auto-switches the tab — feedback is the block marker, the
// popover's saved state, and the badge count.
export function RightPanel() {
  const { state } = useReaderSession();
  const [tab, setTab] = useState<"refs" | "annotations">("refs");
  const annCount = useAnnotations().annotations.length;
  return (
    <div className="right">
      <div className="right-tabs">
        <button
          className={"right-tab" + (tab === "refs" ? " on" : "")}
          onClick={() => setTab("refs")}
        >
          引用
        </button>
        <button
          className={"right-tab" + (tab === "annotations" ? " on" : "")}
          onClick={() => setTab("annotations")}
        >
          标注
          {annCount > 0 && <span className="ann-badge">{annCount}</span>}
        </button>
      </div>
      {tab === "refs" ? <RefsView key={state.generation} /> : <AnnotationsPanel />}
    </div>
  );
}

function RefsView() {
  const store = useStore();
  const visibleIds = useVisibleIds();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());

  const cards = useMemo<Card[]>(() => {
    const seen = new Set<string>();
    const out: Card[] = [];
    for (const bid of visibleIds) {
      // core pre-grouped the citing ref ids per block; refById doubles as the
      // resolved check (unknown ids are simply absent)
      for (const rid of store.citationsByBlock.get(bid) ?? []) {
        const key = "cite:" + rid;
        if (seen.has(key)) continue;
        const ref = store.refById.get(rid);
        if (!ref) continue;
        seen.add(key);
        out.push({ key, kind: "citation", ref });
      }
      const block = store.blockById.get(bid);
      if (!block) continue;
      for (const tid of xrefTargetIds(block)) {
        const t = store.blockById.get(tid);
        if (!t) continue;
        const kind = floatKind(t.type);
        if (!kind) continue;
        const key = kind + ":" + tid;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, kind, block: t as Card["block"] });
      }
    }
    return out;
  }, [visibleIds, store]);

  // Pin the expanded card: keep a reference to its Card object so it stays
  // rendered even after its source text scrolls out of the reading band. Per the
  // spec, an expanded card persists until IT leaves the (right-panel) viewport.
  const expandedCardRef = useRef<Card | null>(null);
  const expandedInList = expandedKey
    ? cards.find((c) => c.key === expandedKey) ?? null
    : null;
  if (expandedInList) expandedCardRef.current = expandedInList;

  const displayCards = useMemo<Card[]>(() => {
    if (
      expandedKey &&
      expandedCardRef.current &&
      !cards.some((c) => c.key === expandedKey)
    ) {
      return [...cards, expandedCardRef.current];
    }
    return cards;
  }, [cards, expandedKey]);

  // Collapse the expanded card only when the card element itself leaves the
  // right-panel's scroll viewport (not when its source text leaves the reader).
  useEffect(() => {
    if (!expandedKey) return;
    const el = cardEls.current.get(expandedKey);
    if (!el) return;
    const root = el.closest(".panel-body") as HTMLElement | null;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (!e.isIntersecting) setExpandedKey(null);
      },
      { root, threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [expandedKey, displayCards]);

  // Cross-panel: a cite chip in the body focuses its reference card here.
  useEffect(() => {
    let timer: number | undefined;
    const off = store.subscribeFocus((refId) => {
      const key = "cite:" + refId;
      setFocusedKey(key);
      const el = cardEls.current.get(key);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFocusedKey((k) => (k === key ? null : k)), 1600);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [store]);

  return (
    <>
      <div className="panel-title">In view · {cards.length}</div>
      {cards.length === 0 && (
        <div className="right-empty">
          Nothing referenced in the current view. Scroll the article — figures,
          equations, tables and citations mentioned nearby appear here.
        </div>
      )}
      <AnimatePresence initial={false}>
        {displayCards.map((card) => (
          <motion.div
            key={card.key}
            layout
            initial={{ y: -6 }}
            animate={{ y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            ref={(el) => {
              if (el) cardEls.current.set(card.key, el);
              else cardEls.current.delete(card.key);
            }}
          >
            <RefCard
              card={card}
              expanded={expandedKey === card.key}
              focused={focusedKey === card.key}
              onToggleExpand={() =>
                setExpandedKey((k) => (k === card.key ? null : card.key))
              }
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </>
  );
}
