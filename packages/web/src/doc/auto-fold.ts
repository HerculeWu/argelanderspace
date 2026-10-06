import { type RefObject, useEffect, useState } from "react";

/**
 * A Reader's two side panels fold on their own when the pane is too narrow to keep a reading column (user ruling
 * 2026-10-05, extended to the PDF Reader the same day): the left panel first, then the right one; what the user (or the
 * Copilot) sets by hand wins until the pane's width class changes; a pane that is wide enough is untouched.
 * Shared by the LaTeX Reader and the PDF Reader, with the same threshold.
 */

/**
 * The reading column never gets less than this; the side panels fold before it does. 480 px is the LaTeX article's
 * 40 px side padding twice plus a ~400 px measure (about 45 characters at the 18 px body size, the lower edge of a
 * readable line), and it keeps a PDF page at least ~440 px wide. Ticket 32 raised it from 240 (user rulings "PDF 1024:
 * same auto-fold as LaTeX"): at 1440 with Copilot open the article was 326 px, the PDF page 340 px and cropped.
 */
export const MIN_READING_COLUMN = 480;
export interface PanelSizes {
  left: number;
  right: number;
  /** A folded panel's rail. */
  rail: number;
}
export const LATEX_PANEL_SIZES: PanelSizes = { left: 290, right: 380, rail: 34 };

/**
 * Which panels fold for a Reader pane of this width: none while the column keeps its minimum with both open; else
 * the left one; else both. The same folded state the toggles show, so the user can unfold either at will.
 */
export function autoFold(width: number | null, panels: PanelSizes = LATEX_PANEL_SIZES): { left: boolean; right: boolean } {
  if (!width) return { left: false, right: false };
  if (width - panels.left - panels.right >= MIN_READING_COLUMN) return { left: false, right: false };
  if (width - panels.rail - panels.right >= MIN_READING_COLUMN) return { left: true, right: false };
  return { left: true, right: true };
}

export function useElementWidth(ref: RefObject<HTMLElement>, enabled = true): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(Math.round(el.getBoundingClientRect().width) || null);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}

type Manual = { left: boolean | null; right: boolean | null; auto: { left: boolean; right: boolean } };

/** The effective folds of one Reader pane: automatic from the pane's width, overridden by hand until the width class changes. */
export function useAutoFoldedPanels(ref: RefObject<HTMLElement>, panels: PanelSizes = LATEX_PANEL_SIZES, enabled = true) {
  const width = useElementWidth(ref, enabled);
  const auto = autoFold(width, panels);
  const [manual, setManual] = useState<Manual>({ left: null, right: null, auto });
  const sameAuto = manual.auto.left === auto.left && manual.auto.right === auto.right;
  useEffect(() => {
    // a new width class gives the layout back to the automatic choice
    if (!sameAuto) setManual({ left: null, right: null, auto });
  }, [sameAuto, auto.left, auto.right]);
  const collapsedLeft = manual.left ?? auto.left;
  const collapsedRight = manual.right ?? auto.right;
  // Unfolding one panel while the other is open and the column would drop below its minimum folds the other one
  // (the article is never squeezed out; one panel always opens when asked, the column then keeps what is left).
  const squeezed = width !== null && width - panels.left - panels.right < MIN_READING_COLUMN;
  const setCollapsedLeft = (value: boolean | ((previous: boolean) => boolean)) => setManual((m) => {
    const left = typeof value === "function" ? value(m.left ?? m.auto.left) : value;
    return { ...m, left, ...(!left && squeezed && !(m.right ?? m.auto.right) ? { right: true } : {}) };
  });
  const setCollapsedRight = (value: boolean | ((previous: boolean) => boolean)) => setManual((m) => {
    const right = typeof value === "function" ? value(m.right ?? m.auto.right) : value;
    return { ...m, right, ...(!right && squeezed && !(m.left ?? m.auto.left) ? { left: true } : {}) };
  });
  return { collapsedLeft, collapsedRight, setCollapsedLeft, setCollapsedRight };
}
