import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  BibManifestRow,
  DocIr,
  IrBlock,
  IrSection,
  Reference,
} from "@argelanderspace/contracts";
import { imageUrl as buildImageUrl } from "./api";

// rootMargin defining the "currently reading" band inside the reader viewport.
// Blocks whose box lies in the bottom 38% don't count until they scroll up.
const READING_BAND = "-2% 0px -38% 0px";
const FLASH_MS = 1600;
// While a smooth-scroll jump is still animating, scrollTop is a mid-flight value;
// don't overwrite the saved undo origin with it during rapid consecutive jumps.
const JUMP_ANIM_MS = 700;
// Post-jump landing correction: images lazy-loading en route (and side-panel
// width transitions) can push the target off the landing spot mid-scroll, so
// re-measure after the animation settles and correct — bounded (first check
// after the animation + settle slack, one quick re-check after a correction,
// then stop) so it can't oscillate.
const JUMP_CORRECT_MS = 900;
const JUMP_RECHECK_MS = 400;
const JUMP_CORRECT_MAX = 2;
const JUMP_CORRECT_TOLERANCE = 4;

interface StoreValue {
  ir: DocIr;
  docId: string;
  // lookups
  refById: Map<string, Reference>;
  bibById: Map<string, BibManifestRow>;
  blockById: Map<string, IrBlock>;
  blockOrder: Map<string, number>;
  sectionOfBlock: Map<string, string>;
  citationsByBlock: Map<string, string[]>;
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

export function StoreProvider({ ir, children }: { ir: DocIr; children: React.ReactNode }) {
  const lookups = useMemo(() => buildLookups(ir), [ir]);

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
  const pendingCorrect = useRef<{ timer: number } | null>(null);
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

    const cancelJumpCorrect = () => {
      if (pendingCorrect.current !== null) {
        window.clearTimeout(pendingCorrect.current.timer);
        pendingCorrect.current = null;
      }
    };

    const scheduleJumpCorrect = (el: HTMLElement, attempt: number) => {
      cancelJumpCorrect();
      const delay = attempt === 1 ? JUMP_CORRECT_MS : JUMP_RECHECK_MS;
      const timer = window.setTimeout(() => {
        pendingCorrect.current = null;
        const root = readerEl.current;
        if (root === null || !el.isConnected) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // no layout (test envs)
        const margin = Number.parseFloat(window.getComputedStyle(el).scrollMarginTop) || 0;
        const off = rect.top - (root.getBoundingClientRect().top + margin);
        if (Math.abs(off) <= JUMP_CORRECT_TOLERANCE || attempt > JUMP_CORRECT_MAX) return;
        el.scrollIntoView({ block: "start", behavior: "auto" });
        scheduleJumpCorrect(el, attempt + 1);
      }, delay);
      pendingCorrect.current = { timer };
    };

    return {
      ir,
      docId: ir.docId,
      ...lookups,
      imageUrl: (p) => buildImageUrl(ir.docId, p),

      registerReader: (el) => {
        readerEl.current = el;
        if (el) {
          // content is static; observe once after it's in the DOM
          requestAnimationFrame(attachObserver);
          // a pending landing correction must never yank the page once the
          // user takes over scrolling
          for (const type of ["wheel", "touchstart", "keydown"] as const) {
            el.addEventListener(type, cancelJumpCorrect, { passive: true });
          }
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
        // scroll-margin-top on .block/.sec supplies the pad under the top edge
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        scheduleJumpCorrect(el, 1);
        el.classList.remove("flash");
        // force reflow so the animation restarts even on repeated jumps
        void el.offsetWidth;
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), FLASH_MS);
      },

      undo: () => {
        const root = readerEl.current;
        cancelJumpCorrect();
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
  }, [ir, lookups]);

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
function buildLookups(ir: DocIr) {
  const refById = new Map<string, Reference>();
  for (const r of ir.references ?? []) refById.set(r.id, r);

  const bibById = new Map<string, BibManifestRow>();
  for (const b of ir.bib) bibById.set(b.id, b);

  const blockById = new Map<string, IrBlock>();
  const blockOrder = new Map<string, number>();
  const sectionOfBlock = new Map<string, string>();
  let order = 0;

  const walk = (secs: IrSection[] | undefined) => {
    if (!secs) return;
    for (const sec of secs) {
      // the heading itself is a jump target + ordering anchor; registering it in
      // blockById lets section cross-refs (\ref{sec:..}, "Sect. 3") resolve too.
      blockOrder.set(sec.id, order++);
      sectionOfBlock.set(sec.id, sec.id);
      blockById.set(sec.id, sec as unknown as IrBlock);
      for (const b of sec.blocks ?? []) {
        blockById.set(b.id, b);
        blockOrder.set(b.id, order++);
        sectionOfBlock.set(b.id, sec.id);
      }
      walk(sec.children ?? []);
    }
  };
  walk(ir.sections);

  // core precomputes the per-block citation ref-id groups (order preserved,
  // deduped) — includes hyperlink-found occurrences without an inline token.
  const citationsByBlock = new Map<string, string[]>(Object.entries(ir.citationsByBlock));

  return {
    refById,
    bibById,
    blockById,
    blockOrder,
    sectionOfBlock,
    citationsByBlock,
  };
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
