/**
 * Stage 14 explore route + navigation bus (D2/D14).
 *
 * The active exploration owns the URL as `/#explore/<url-encoded-bibcode>`.
 * Only SUCCESSFUL seed transitions write history (pushState) — failures and
 * cancels never create entries. The bus links Shell's popstate/hashchange
 * handling to the LibraryView instance hosting the exploration (the one
 * currently exploring, else the first registered); the URL never encodes a
 * pane id. A boot-time `#explore/…` hash is held as `pending` until a
 * LibraryView registers (Shell meanwhile ensures a library pane exists).
 */

export function parseExploreHash(hash: string): string | null {
  const m = /^#explore\/([^/?#]+)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function exploreUrl(seed: string): string {
  return `/#explore/${encodeURIComponent(seed)}`;
}

/** pushState (not replaceState): browser Back/Forward walk the seed history. */
export function pushExploreUrl(seed: string): void {
  try {
    const url = exploreUrl(seed);
    if (window.location.pathname + window.location.hash !== url) {
      window.history.pushState(null, "", url);
    }
  } catch {
    /* sandboxed previews may disallow History — exploration still works */
  }
}

export function clearExploreUrl(): void {
  try {
    if (parseExploreHash(window.location.hash) !== null) {
      window.history.pushState(null, "", window.location.pathname || "/");
    }
  } catch {
    /* ignore */
  }
}

export interface ExploreTarget {
  /** Whether this LibraryView currently hosts the active exploration. */
  isExploring(): boolean;
  /** Navigate to the seed: restore the session when known, else fetch fresh. */
  explore(seed: string): void;
  /** Leave explore mode (the URL no longer points at an exploration). */
  exit(): void;
}

const targets: ExploreTarget[] = [];
let pending: string | null = null;

export const exploreBus = {
  /** Called by Shell on boot / popstate / hashchange for `#explore/…`. */
  request(seed: string): void {
    pending = seed;
    const t = targets.find((x) => x.isExploring()) ?? targets[0];
    if (t) {
      pending = null;
      t.explore(seed);
    }
  },
  /** Called when the URL stops naming an exploration (popstate to a plain URL). */
  exit(): void {
    pending = null;
    targets.find((x) => x.isExploring())?.exit();
  },
  register(t: ExploreTarget): () => void {
    targets.push(t);
    if (pending !== null) {
      const seed = pending;
      pending = null;
      // defer so the registering component finishes mounting first
      queueMicrotask(() => t.explore(seed));
    }
    return () => {
      const i = targets.indexOf(t);
      if (i >= 0) targets.splice(i, 1);
    };
  },
};
