/**
 * The Library's layout rule for a narrow pane (copilot ticket 33 follow-up, finding D6): the detail panel sits beside
 * the graph, never over it, and the work list folds to its rail to make room, like the Reader's side panels
 * (doc/auto-fold.ts). The numbers are the stylesheet's (`.lib-side`, `.ref-detail` in argelander.css).
 */

/** The graph never gets less than this next to an open detail (the Reader's minimum reading column). */
export const MIN_GRAPH_COLUMN = 240;
/** The work list's width: 250, 198 in a pane up to 780 px. */
const sideWidth = (width: number) => (width <= 780 ? 198 : 250);
/** The detail's width: 392 (360 in a window up to 1100 px, counted as 392 here: the safe side), 300 in a pane up to 820 px. */
const detailWidth = (width: number) => (width <= 820 ? 300 : 392);

/**
 * Whether the work list folds on its own: only while a detail is open and the pane is too narrow to keep the graph's
 * minimum column beside the open list. Nothing else folds by itself.
 */
export function libraryAutoFold(width: number | null, detailOpen: boolean): boolean {
  if (!width || !detailOpen) return false;
  return width - sideWidth(width) - detailWidth(width) < MIN_GRAPH_COLUMN;
}
