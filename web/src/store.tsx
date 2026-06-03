import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  Block,
  Citation,
  CrossRef,
  Doc,
  Reference,
  Section,
} from "./types";
import { imageUrl as buildImageUrl } from "./api";

// rootMargin defining the "currently reading" band inside the reader viewport.
// Blocks whose box lies in the bottom 38% don't count until they scroll up.
const READING_BAND = "-2% 0px -38% 0px";
const JUMP_PAD = 16;
const FLASH_MS = 1600;
// While a smooth-scroll jump is still animating, scrollTop is a mid-flight value;
// don't overwrite the saved undo origin with it during rapid consecutive jumps.
const JUMP_ANIM_MS = 700;

interface StoreValue {
  doc: Doc;
  docId: string;
  // lookups
  refById: Map<string, Reference>;
  blockById: Map<string, Block>;
  blockOrder: Map<string, number>;
  sectionOfBlock: Map<string, string>;
  citationsByBlock: Map<string, Citation[]>;
  crossrefsByBlock: Map<string, CrossRef[]>;
  imageUrl: (imgPath?: string) => string | null;
  // reader element + viewport observation
  registerReader: (el: HTMLElement | null) => void;
  // viewport (subscribe via hooks below)
  subscribeViewport: (cb: () => void) => () => void;
  getVisibleIds: () => string[];
  getActiveSectionId: () => string | null;
  // jump / single-slot undo
  jumpTo: (targetId: string) => void;
  undo: () => void;
  subscribeUndo: (cb: () => void) => () => void;
  getCanUndo: () => boolean;
  // cross-panel: focus a reference card in the right panel
  focusReference: (refId: string) => void;
  subscribeFocus: (cb: (refId: string) => void) => () => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside provider");
  return v;
}

export function StoreProvider({ doc, children }: { doc: Doc; children: React.ReactNode }) {
  const lookups = useMemo(() => buildLookups(doc), [doc]);

  // --- mutable refs (do not trigger renders) ---
  const readerEl = useRef<HTMLElement | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const visibleSet = useRef<Set<string>>(new Set());
  const visibleArr = useRef<string[]>([]);
  const activeSection = useRef<string | null>(null);
  const viewportSubs = useRef<Set<() => void>>(new Set());
  const rafPending = useRef(false);

  const undoTop = useRef<number | null>(null);
  const canUndo = useRef(false);
  const lastJumpAt = useRef(0);
  const undoSubs = useRef<Set<() => void>>(new Set());

  const focusSubs = useRef<Set<(refId: string) => void>>(new Set());

  const store = useMemo<StoreValue>(() => {
    const notifyViewport = () => viewportSubs.current.forEach((f) => f());
    const notifyUndo = () => undoSubs.current.forEach((f) => f());

    const recompute = () => {
      rafPending.current = false;
      const arr = [...visibleSet.current].sort(
        (a, b) => (lookups.blockOrder.get(a) ?? 0) - (lookups.blockOrder.get(b) ?? 0)
      );
      const same =
        arr.length === visibleArr.current.length &&
        arr.every((v, i) => v === visibleArr.current[i]);
      const top = arr.length ? arr[0] : null;
      const sec = top ? lookups.sectionOfBlock.get(top) ?? null : null;
      let changed = false;
      if (!same) {
        visibleArr.current = arr;
        changed = true;
      }
      if (sec !== activeSection.current) {
        activeSection.current = sec;
        changed = true;
      }
      if (changed) notifyViewport();
    };

    const scheduleRecompute = () => {
      if (rafPending.current) return;
      rafPending.current = true;
      requestAnimationFrame(recompute);
    };

    const attachObserver = () => {
      observer.current?.disconnect();
      visibleSet.current.clear();
      const root = readerEl.current;
      if (!root) return;
      const obs = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.blockId;
            if (!id) continue;
            if (e.isIntersecting) visibleSet.current.add(id);
            else visibleSet.current.delete(id);
          }
          scheduleRecompute();
        },
        { root, rootMargin: READING_BAND, threshold: 0 }
      );
      root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((el) => obs.observe(el));
      observer.current = obs;
      scheduleRecompute();
    };

    return {
      doc,
      docId: doc.doc_id,
      ...lookups,
      imageUrl: (p) => buildImageUrl(doc.doc_id, p),

      registerReader: (el) => {
        readerEl.current = el;
        if (el) {
          // content is static; observe once after it's in the DOM
          requestAnimationFrame(attachObserver);
        } else {
          observer.current?.disconnect();
          observer.current = null;
        }
      },

      subscribeViewport: (cb) => {
        viewportSubs.current.add(cb);
        return () => viewportSubs.current.delete(cb);
      },
      getVisibleIds: () => visibleArr.current,
      getActiveSectionId: () => activeSection.current,

      jumpTo: (targetId) => {
        const root = readerEl.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(
          `[data-block-id="${cssEscape(targetId)}"]`
        );
        if (!el) return;
        // Capture the real pre-jump position only when we're not mid-animation
        // from a previous jump (otherwise scrollTop is a partway value).
        const now = typeof performance !== "undefined" ? performance.now() : 0;
        if (now - lastJumpAt.current > JUMP_ANIM_MS) {
          undoTop.current = root.scrollTop;
        }
        lastJumpAt.current = now;
        canUndo.current = true;
        notifyUndo();
        const delta =
          el.getBoundingClientRect().top -
          root.getBoundingClientRect().top +
          root.scrollTop -
          JUMP_PAD;
        root.scrollTo({ top: Math.max(0, delta), behavior: "smooth" });
        el.classList.remove("flash");
        // force reflow so the animation restarts even on repeated jumps
        void el.offsetWidth;
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), FLASH_MS);
      },

      undo: () => {
        const root = readerEl.current;
        if (!root || undoTop.current === null) return;
        root.scrollTo({ top: undoTop.current, behavior: "smooth" });
        undoTop.current = null;
        canUndo.current = false;
        notifyUndo();
      },
      subscribeUndo: (cb) => {
        undoSubs.current.add(cb);
        return () => undoSubs.current.delete(cb);
      },
      getCanUndo: () => canUndo.current,

      focusReference: (refId) => focusSubs.current.forEach((f) => f(refId)),
      subscribeFocus: (cb) => {
        focusSubs.current.add(cb);
        return () => focusSubs.current.delete(cb);
      },
    };
  }, [doc, lookups]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

// ---- viewport hooks (only the panels that need them re-render on scroll) ----

export function useVisibleIds(): string[] {
  const s = useStore();
  return useSyncExternalStore(s.subscribeViewport, s.getVisibleIds, s.getVisibleIds);
}
export function useActiveSectionId(): string | null {
  const s = useStore();
  return useSyncExternalStore(
    s.subscribeViewport,
    s.getActiveSectionId,
    s.getActiveSectionId
  );
}
export function useCanUndo(): boolean {
  const s = useStore();
  return useSyncExternalStore(s.subscribeUndo, s.getCanUndo, s.getCanUndo);
}

// --------------------------------------------------------------------------
function buildLookups(doc: Doc) {
  const refById = new Map<string, Reference>();
  for (const r of doc.references) refById.set(r.id, r);

  const blockById = new Map<string, Block>();
  const blockOrder = new Map<string, number>();
  const sectionOfBlock = new Map<string, string>();
  let order = 0;

  const walk = (secs: Section[] | undefined) => {
    if (!secs) return;
    for (const sec of secs) {
      // the heading itself is a jump target + ordering anchor; registering it in
      // blockById lets section cross-refs (\ref{sec:..}, "Sect. 3") resolve too.
      blockOrder.set(sec.id, order++);
      sectionOfBlock.set(sec.id, sec.id);
      blockById.set(sec.id, sec as unknown as Block);
      for (const b of sec.blocks ?? []) {
        blockById.set(b.id, b);
        blockOrder.set(b.id, order++);
        sectionOfBlock.set(b.id, sec.id);
      }
      walk(sec.children ?? []);
    }
  };
  walk(doc.structure);

  const citationsByBlock = groupBy(doc.citations, (c) => c.block_id);
  const crossrefsByBlock = groupBy(doc.crossrefs, (c) => c.block_id);

  return {
    refById,
    blockById,
    blockOrder,
    sectionOfBlock,
    citationsByBlock,
    crossrefsByBlock,
  };
}

function groupBy<T>(items: T[], key: (t: T) => string | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
