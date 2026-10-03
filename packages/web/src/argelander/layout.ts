import { MIN_PANE_SHARE } from "@argelanderspace/contracts";

/**
 * Divider drag between pane `index` and the next one, moved by `delta` (in the same unit as `sizes`).
 * Each side keeps at least MIN_PANE_SHARE of the total. This is the Shell's drag rule, shared with the
 * Copilot `resize_pane` action so a requested size can never differ from what a drag could reach.
 */
export function resizeDivider(sizes: number[], index: number, delta: number): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const min = total * MIN_PANE_SHARE;
  return sizes.map((size, i) => {
    if (i === index) return Math.max(min, size + delta);
    if (i === index + 1) return Math.max(min, size - delta);
    return size;
  });
}

/**
 * The sizes after giving pane `paneIndex` the width `share` (of the total), taking the space from — or
 * giving it to — its right neighbour (the left one for the last pane): exactly one divider move. Null
 * when there is no neighbour, or the neighbour would fall below the drag minimum.
 */
export function planResize(sizes: number[], paneIndex: number, share: number): number[] | null {
  if (sizes.length < 2 || paneIndex < 0 || paneIndex >= sizes.length) return null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const wanted = share * total;
  const last = paneIndex === sizes.length - 1;
  const divider = last ? paneIndex - 1 : paneIndex;
  const delta = last ? (sizes[paneIndex] as number) - wanted : wanted - (sizes[paneIndex] as number);
  const neighbour = last ? divider : paneIndex + 1;
  const min = total * MIN_PANE_SHARE;
  const moved = (sizes[neighbour] as number) + (last ? delta : -delta);
  if (wanted < min - 1e-9 || moved < min - 1e-9) return null;
  return resizeDivider(sizes, divider, delta);
}

export const shareOf = (sizes: number[], index: number): number => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? Math.round(((sizes[index] as number) / total) * 1000) / 1000 : 0;
};
