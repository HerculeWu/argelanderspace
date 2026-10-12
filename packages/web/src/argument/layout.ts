/**
 * The argument graph view's layout rule for a narrow pane (ticket 04, user decision 2026-10-12), the Library's rule
 * (library/layout.ts) applied to the outline: the outline (300) and the reading panel (392) keep the prototype's width
 * at every pane width. When the canvas beside outline + panel would be too small (OUTLINE_FOLD_CANVAS), opening the panel folds the outline
 * to its rail on its own (the user can unfold it and that wins while the panel stays open); when even the folded
 * outline leaves the canvas under its minimum, the panel floats over the canvas's right edge instead.
 * The numbers are the stylesheet's (`.lib-side.wide`, `.ag-panel`, `.lib-rail` in argelander.css).
 */
import { MIN_GRAPH_COLUMN } from "../library/layout";

export const OUTLINE_WIDTH = 300;
export const PANEL_WIDTH = 392;
/** A folded outline's rail (the Library's `.lib-rail`). */
export const OUTLINE_RAIL = 34;

/**
 * The canvas beside an open outline and an open panel should keep at least this much for the outline to stay open on
 * its own. The Library folds its list only at the bare 240 (library/layout.ts), but a graph needs room to be read: at
 * 1024 (pane 962) that rule would leave a 270 px canvas and a 30% fit, worse than the old narrowed panel (382 px, 36%),
 * while the folded outline leaves 536. 480 is the one number that is not the user's: change it here (the folds at
 * 1024 and in a split 1440 pane do not depend on it anywhere between 271 and 686).
 */
export const OUTLINE_FOLD_CANVAS = 480;

/** Whether the outline folds on its own: only while the panel is open and the canvas beside both would be under OUTLINE_FOLD_CANVAS. */
export function outlineAutoFold(width: number | null, panelOpen: boolean): boolean {
  if (!width || !panelOpen) return false;
  return width - OUTLINE_WIDTH - PANEL_WIDTH < OUTLINE_FOLD_CANVAS;
}

export interface ArgumentLayoutInput {
  /** The view's width; null until measured (nothing folds, the panel sits beside). */
  width: number | null;
  panelOpen: boolean;
  /** The user folded the outline by hand. */
  userFolded: boolean;
  /** The user unfolded the outline by hand while the automatic fold applied. */
  userUnfolded: boolean;
}
export interface ArgumentLayout {
  outlineFolded: boolean;
  /** The automatic fold applies at this width with this panel state (the user may still have overridden it). */
  autoFolded: boolean;
  /** `side`: beside the canvas; `overlay`: over the canvas's right edge; `none`: no panel. */
  panel: "none" | "side" | "overlay";
}

export function argumentLayout({ width, panelOpen, userFolded, userUnfolded }: ArgumentLayoutInput): ArgumentLayout {
  const autoFolded = outlineAutoFold(width, panelOpen);
  const outlineFolded = userFolded || (autoFolded && !userUnfolded);
  if (!panelOpen) return { outlineFolded, autoFolded, panel: "none" };
  const rest = width ? width - (outlineFolded ? OUTLINE_RAIL : OUTLINE_WIDTH) - PANEL_WIDTH : Infinity;
  return { outlineFolded, autoFolded, panel: rest < MIN_GRAPH_COLUMN ? "overlay" : "side" };
}
