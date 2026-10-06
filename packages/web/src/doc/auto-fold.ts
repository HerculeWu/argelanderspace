import { type RefObject, useEffect, useState } from "react";

/**
 * A Reader's two side panels fold on their own when the pane is too narrow to keep a reading column (user ruling
 * 2026-10-05, extended to the PDF Reader the same day): the left panel first, then the right one; what the user (or the
 * Copilot) sets by hand wins until the pane's width class changes; a pane that is wide enough is untouched.
 * Shared by the LaTeX Reader and the PDF Reader, with the same threshold.
 *
 * One exception to "manual wins", the floor (ticket 32, user decision "floor only"): unfolding a panel whose
 * opening would push the reading column below MIN_READING_COLUMN folds the other open panel (foldedByUnfold), so the
 * article is never squeezed out. Nothing else folds by itself, so with room for both (1440 with Copilot: article 326)
 * both panels may be open.
 */

/** The reading column never gets less than this: the side panels fold before it does, and an unfold that would break it folds the other panel. */
export const MIN_READING_COLUMN = 240;
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

export type FoldSide = "left" | "right";

/** The panel an unfold of `side` folds: the other one, when it is open and both open would leave less than the minimum column. */
export function foldedByUnfold(width: number | null, panels: PanelSizes, side: FoldSide, otherCollapsed: boolean): FoldSide | null {
  if (width === null || otherCollapsed) return null;
  return width - panels.left - panels.right < MIN_READING_COLUMN ? (side === "left" ? "right" : "left") : null;
}

/**
 * The effective folds of one Reader pane: automatic from the pane's width, overridden by hand until the width class
 * changes (and by the floor rule above). `unfold` reports which panel the unfolding folded, for the Copilot's answer.
 */
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
  const setSide = (side: FoldSide, value: boolean | ((previous: boolean) => boolean)) => setManual((m) => {
    const next = typeof value === "function" ? value(m[side] ?? m.auto[side]) : value;
    const other: FoldSide = side === "left" ? "right" : "left";
    const folds = !next ? foldedByUnfold(width, panels, side, m[other] ?? m.auto[other]) : null;
    return { ...m, [side]: next, ...(folds ? { [folds]: true } : {}) };
  });
  const setCollapsedLeft = (value: boolean | ((previous: boolean) => boolean)) => setSide("left", value);
  const setCollapsedRight = (value: boolean | ((previous: boolean) => boolean)) => setSide("right", value);
  /** Fold or unfold one panel; returns the other panel when unfolding folded it. */
  const setPanelCollapsed = (side: FoldSide, collapsed: boolean): FoldSide | null => {
    const folds = !collapsed ? foldedByUnfold(width, panels, side, side === "left" ? collapsedRight : collapsedLeft) : null;
    setSide(side, collapsed);
    return folds;
  };
  return { collapsedLeft, collapsedRight, setCollapsedLeft, setCollapsedRight, setPanelCollapsed };
}
