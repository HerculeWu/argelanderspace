// Deep links (Stage 2, decision 8): `/doc/<docId>#<anchor>` with four anchor
// levels — doc (no hash) / section (sec-N) / floats (fig-N, tab-N, eq-N, also
// code-N / alg-N) / references (ref-N). Hand-rolled: this is the SPA's only
// route, so no router library. The M4 server already falls back to index.html
// for non-API paths, so these URLs load the app directly.

import type { useStore } from "../store";

type Store = ReturnType<typeof useStore>;

export interface DocRoute {
  docId: string;
  anchor: string | null;
}

/** Parse `/doc/<docId>[#<anchor>]`; anything else (incl. `/`) is not a doc route. */
export function parseDocRoute(pathname: string, hash: string): DocRoute | null {
  const m = /^\/doc\/([^/]+?)\/?$/.exec(pathname);
  if (!m) return null;
  let docId: string;
  let anchor: string | null = null;
  try {
    docId = decodeURIComponent(m[1]);
    anchor = hash.startsWith("#") ? decodeURIComponent(hash.slice(1)) : null;
  } catch {
    return null; // malformed percent-encoding
  }
  if (!docId) return null;
  return { docId, anchor: anchor || null };
}

/** `/doc/<docId>[#<anchor>]` for the address bar (query string dropped). */
export function docRouteUrl(docId: string, anchor?: string | null): string {
  return "/doc/" + encodeURIComponent(docId) + (anchor ? "#" + encodeURIComponent(anchor) : "");
}

/** Keep the address bar a valid deep link for whatever doc is open. */
export function replaceDocUrl(docId: string, anchor?: string | null): void {
  window.history.replaceState(null, "", docRouteUrl(docId, anchor));
}

// Give the rail a beat after the jump: a citation card only renders once its
// citing block scrolls into the reading band (the jump animation is ~700ms).
const REF_FOCUS_DELAY_MS = 850;

/**
 * Land on a deep-link anchor, reusing the in-app chip mechanisms: xref chips
 * jumpTo() a block (scroll + flash); cite chips focusReference() a rail card.
 * For ref anchors we first jump to the ref's first citing block so its card
 * appears in the rail, then focus it. Returns false for unknown anchors —
 * callers still leave the doc open in that case.
 */
export function applyAnchor(store: Store, anchor: string): boolean {
  if (store.blockById.has(anchor)) {
    store.jumpTo(anchor);
    return true;
  }
  if (store.refById.has(anchor)) {
    const citing = firstCitingBlockId(store, anchor);
    if (citing) store.jumpTo(citing);
    window.setTimeout(() => store.focusReference(anchor), REF_FOCUS_DELAY_MS);
    return true;
  }
  return false;
}

function firstCitingBlockId(store: Store, refId: string): string | null {
  let best: string | null = null;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const [blockId, refIds] of store.citationsByBlock) {
    if (!refIds.includes(refId)) continue;
    const order = store.blockOrder.get(blockId) ?? Number.POSITIVE_INFINITY;
    if (order < bestOrder) {
      bestOrder = order;
      best = blockId;
    }
  }
  return best;
}
