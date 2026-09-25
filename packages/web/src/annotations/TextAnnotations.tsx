import { useReaderSession } from "../doc/ReaderSession";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnnotationTextTarget } from "@argelanderspace/contracts";
import { useStore } from "../store";
import i18n from "../i18n";
import { useAnnotations } from "./AnnotationStore";
import { createHighlightPainter, type HighlightPainter, type PaintEntry } from "./highlights";
import { targetSummary } from "./model";
import { ActionButton } from "../ui";
import {
  buildContainerMap,
  caretFromPoint,
  containerElementFor,
  offsetForPoint,
  offsetsForRange,
  rangeForOffsets,
  resolveContainerAt,
  sameContainer,
  segmentsForContainer,
  type ContainerMap,
} from "./textmap";

/**
 * Text-annotation engine wiring (Stage 8 MS4), mounted inside the reader's
 * `<main>` next to the popover:
 *
 * - SELECTION CAPTURE: document `selectionchange` + mouse tracking. A finished
 *   (debounced, mouse-up) non-collapsed selection inside one logical container
 *   becomes a pending text target (canonical offsets via the textmap primitive,
 *   atom interiors expanded, quote = canonical slice) and shows the floating
 *   "add annotation" toolbar near the selection. Cross-container/cross-block →
 *   the cross-paragraph toast; positions with no text container (equation/code/
 *   table bodies, section headings) → the unsupported-position toast;
 *   selections fully outside blocks are ignored silently. The toolbar
 *   dismisses on selection collapse, reader scroll, window resize, Escape, or
 *   an outside mousedown.
 * - PAINTING: every text annotation resolves its stored offsets to a live DOM
 *   Range (NO quote re-search — the fingerprint guarantees the content) and
 *   repaints through the Custom Highlight painter; the active annotation paints
 *   stronger. Without `CSS.highlights` the painter no-ops and everything else
 *   keeps working.
 * - CLICK HIT-TESTING: a click in the reader with a collapsed selection maps
 *   the caret point to a canonical offset and opens the covering annotation's
 *   popover; multiple hits open the chooser (shared store state, also used by
 *   the gutter count marker). Clicks on chips / annotation UI / links / buttons
 *   keep their own behavior.
 */

/** Debounce so the toolbar appears only once the selection has settled (and
 *  never mid-drag — mouse state gates scheduling too). */
const SEL_SETTLE_MS = 140;
const AFTER_MOUSEUP_MS = 30;

/** Floating-UI viewport clamping: the SAME 8px margin on both axes for the
 *  selection toolbar and the chooser (N3 — x was clamped, y was not). */
const FLOAT_MARGIN = 8;
const SELBAR_W = 140;
const SELBAR_H = 44;
const CHOOSER_W = 250;

function clampFloatX(x: number, width: number): number {
  return Math.max(FLOAT_MARGIN, Math.min(x, window.innerWidth - width - FLOAT_MARGIN));
}

function clampFloatY(y: number, height: number): number {
  return Math.max(FLOAT_MARGIN, Math.min(y, window.innerHeight - height - FLOAT_MARGIN));
}

let paintInstanceCounter = 0;

export function TextAnnotations() {
  const store = useStore();
  const ann = useAnnotations();
  const { controller, state } = useReaderSession();
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pending, setPending] = useState<{
    target: AnnotationTextTarget;
    x: number;
    y: number;
  } | null>(null);
  const [instanceKey] = useState(() => `i${++paintInstanceCounter}`);
  const painterRef = useRef<HighlightPainter | null>(null);
  const mouseDownRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  // Listeners are registered once; they read the latest store/annotations
  // through refs (both contexts mint fresh identities on every state change).
  const storeRef = useRef(store);
  storeRef.current = store;
  const annRef = useRef(ann);
  annRef.current = ann;

  const getRoot = () =>
    (anchorRef.current?.closest("main.reader") as HTMLElement | null) ?? null;

  // ---- selection capture + floating toolbar ------------------------------ //
  useEffect(() => {
    const root = getRoot();
    if (!root) return;

    const finalize = () => {
      if (!controller.canAnnotate()) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const a = resolveContainerAt(range.startContainer, root, storeRef.current.blockById);
      const b = resolveContainerAt(range.endContainer, root, storeRef.current.blockById);
      if (!a || !b) {
        if (a || b) {
          // one endpoint in a legal container, the other outside it
          annRef.current.notify(i18n.t("annotation.selection.crossParagraph"));
        } else if (touchesBlock(range.startContainer, root) || touchesBlock(range.endContainer, root)) {
          // both inside blocks but neither in a text-anchorable container
          annRef.current.notify(i18n.t("annotation.selection.unsupported"));
        }
        return; // fully outside blocks: silent
      }
      if (a.blockId !== b.blockId || !sameContainer(a.container, b.container) || a.el !== b.el) {
        annRef.current.notify(i18n.t("annotation.selection.crossParagraph"));
        return;
      }
      // A selection anchored in caption chrome (the cap-label) is not in
      // canonical space at all — reject like other unsupported positions
      // (offsetsForRange would return null for it anyway, silently).
      const startHost =
        range.startContainer.nodeType === 1
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      if (startHost?.closest(".cap-label")) {
        annRef.current.notify(i18n.t("annotation.selection.unsupported"));
        return;
      }
      let map: ContainerMap;
      try {
        map = buildContainerMap(a.el, a.segments);
      } catch {
        return; // renderer misalignment: bail (impossible under the fingerprint)
      }
      const off = offsetsForRange(map, range);
      if (!off || off.start >= off.end) return;
      const quote = map.canonical.slice(off.start, off.end);
      const rect = range.getBoundingClientRect();
      // the bar is centered on the selection with translateX(-50%), so clamp
      // the center x by the bar's half-width; y clamped with the same margin
      setPending({
        target: {
          type: "text",
          block: a.blockId,
          container: a.container,
          start: off.start,
          end: off.end,
          quote,
        },
        x: clampFloatX(rect.left + rect.width / 2 - SELBAR_W / 2, SELBAR_W) + SELBAR_W / 2,
        y: clampFloatY(rect.bottom + 8, SELBAR_H),
      });
    };

    const schedule = (ms: number) => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(finalize, ms);
    };

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        window.clearTimeout(timerRef.current);
        setPending(null);
        return;
      }
      if (mouseDownRef.current) {
        window.clearTimeout(timerRef.current); // mid-drag: wait for mouseup
        return;
      }
      schedule(SEL_SETTLE_MS);
    };
    const onMouseDown = (e: MouseEvent) => {
      mouseDownRef.current = true;
      const t = e.target as Element | null;
      if (t && typeof t.closest === "function" && t.closest(".ann-selbar, .ann-chooser")) return;
      setPending(null);
      annRef.current.closeChooser();
    };
    const onMouseUp = () => {
      mouseDownRef.current = false;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) schedule(AFTER_MOUSEUP_MS);
    };
    const onScrollOrResize = () => {
      setPending(null);
      annRef.current.closeChooser();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPending(null);
        annRef.current.closeChooser();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    root.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      root.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // ---- click hit-testing -------------------------------------------------- //
  useEffect(() => {
    const root = getRoot();
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      if (!controller.canAnnotate()) return;
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      // chips / annotation UI / interactive elements keep their own behavior
      if (t.closest(".chip, .ann-edge, .ann-popover, .ann-selbar, .ann-chooser, button, a")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // don't fight text selection
      const pt = caretFromPoint(document, e.clientX, e.clientY);
      if (!pt) return; // unsupported (happy-dom): hit-testing silently off
      const rc = resolveContainerAt(pt.node, root, storeRef.current.blockById);
      if (!rc) return;
      let map: ContainerMap;
      try {
        map = buildContainerMap(rc.el, rc.segments);
      } catch {
        return;
      }
      const off = offsetForPoint(map, pt.node, pt.offset);
      if (off === null) return;
      const hits = annRef.current.annotations.filter((x) => {
        if (x.target.type !== "text") return false;
        if (x.target.block !== rc.blockId) return false;
        if (!sameContainer(x.target.container, rc.container)) return false;
        return x.target.start <= off && off < x.target.end;
      });
      if (hits.length === 1) annRef.current.openView(hits[0]!.id);
      else if (hits.length > 1) {
        annRef.current.openChooser(hits.map((h) => h.id), e.clientX, e.clientY);
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  useLayoutEffect(() => controller.onInvalidate(() => {
    window.clearTimeout(timerRef.current); setPending(null);
    painterRef.current?.paint([]);
    window.getSelection()?.removeAllRanges();
  }), [controller]);

  // ---- painting (CSS Custom Highlight API) -------------------------------- //
  useLayoutEffect(() => {
    const root = getRoot();
    if (!root) return;
    const painter = (painterRef.current ??= createHighlightPainter(document, instanceKey));
    if (!painter.supported) return; // degrade: list/popover/gutter keep working
    if (!ann.canAnnotate) { painter.paint([]); return; }
    const entries: PaintEntry[] = [];
    for (const a of ann.annotations) {
      if (a.target.type !== "text") continue;
      const irNode = store.blockById.get(a.target.block);
      const blockEl = root.querySelector<HTMLElement>(
        `[data-block-id="${cssEscape(a.target.block)}"]`
      );
      if (!irNode || !blockEl) continue;
      const el = containerElementFor(blockEl, irNode, a.target.container);
      const segments = segmentsForContainer(irNode, a.target.container);
      if (!el || !segments) continue;
      let map: ContainerMap;
      try {
        map = buildContainerMap(el, segments);
      } catch {
        continue; // defensive: fingerprint guarantee makes this unreachable
      }
      const range = rangeForOffsets(map, a.target.start, a.target.end);
      if (!range) continue;
      entries.push({ id: a.id, range, active: a.id === ann.activeId });
    }
    painter.paint(entries);
  }, [ann.annotations, ann.activeId, ann.canAnnotate, store, instanceKey, state.generation]);

  // dispose the painter (registry entries + managed style element) on unmount
  useEffect(
    () => () => {
      painterRef.current?.dispose();
      painterRef.current = null;
    },
    []
  );

  const chooser = ann.chooser;

  return (
    <>
      <span ref={anchorRef} hidden />
      {pending && ann.canAnnotate && (
        <div
          className="ann-selbar view-in" data-ui="latex-selection-tools"
          style={{ top: pending.y, left: pending.x }}
          role="toolbar"
          aria-label={t("annotation.summary.text")}
        >
          <ActionButton
            unstyled
            mode="icon"
            iconName="highlighter"
            label={t("annotation.action.add")}
            tooltip={t("annotation.action.addTooltip")}
            className="ann-editor-btn primary"
            data-ui="annotate-selected-text"
            // keep the selection alive until the click lands the create flow
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              ann.openCreate(pending.target);
              setPending(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        </div>
      )}
      {chooser && (
        <div
          className="ann-chooser view-in" data-ui="latex-annotation-chooser"
          style={{
            top: clampFloatY(
              chooser.y,
              // entries are ~76px; the CSS caps the box at 40vh + padding
              Math.min(chooser.ids.length * 76 + 16, window.innerHeight * 0.4 + 16)
            ),
            left: clampFloatX(chooser.x, CHOOSER_W),
          }}
          role="listbox"
          aria-label={t("annotation.selection.chooserAria")}
        >
          {chooser.ids.map((id) => {
            const a = ann.annotations.find((x) => x.id === id);
            if (!a) return null;
            const sum = targetSummary(a, store);
            return (
              <button
                key={id}
                type="button"
                className="ann-chooser-entry" data-ui="latex-annotation-choice" data-ui-key={a.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  ann.openView(id);
                  ann.closeChooser();
                }}
              >
                <span className="ann-entry-head">
                  <span className="ann-entry-kind">{sum.label}</span>
                  {sum.path && <span className="ann-entry-path">{sum.path}</span>}
                </span>
                {sum.snippet && <span className="ann-entry-quote">{sum.snippet}</span>}
                <span className="ann-entry-preview">{a.body}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Is this DOM point inside any `[data-block-id]` of this reader? */
function touchesBlock(node: Node, root: Element): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const block = el?.closest("[data-block-id]");
  return !!block && root.contains(block);
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
