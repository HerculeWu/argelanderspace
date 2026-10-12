/**
 * The argument graph view's route and navigation bus (ticket 04), the same arrangement as the explore mode
 * (explore-route.ts): the open view owns the URL as `/#argument/<url-encoded work id>`. Entering the view pushes one
 * history entry (Back leaves it); a boot-time or hashchange `#argument/…` is held as `pending` until a Library page
 * registers. The selected argument is not in the URL.
 */

export function parseArgumentHash(hash: string): string | null {
  const m = /^#argument\/([^/?#]+)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

export function argumentUrl(workId: string): string {
  return `/#argument/${encodeURIComponent(workId)}`;
}

/** pushState: browser Back returns to the Library. */
export function pushArgumentUrl(workId: string): void {
  try {
    const url = argumentUrl(workId);
    if (window.location.pathname + window.location.hash !== url) window.history.pushState(null, "", url);
  } catch {
    /* sandboxed previews may disallow History — the view still works */
  }
}

export function clearArgumentUrl(): void {
  try {
    if (parseArgumentHash(window.location.hash) !== null) window.history.pushState(null, "", window.location.pathname || "/");
  } catch {
    /* ignore */
  }
}

export interface ArgumentTarget {
  /** Whether this Library page currently shows an argument graph. */
  isOpen(): boolean;
  /** Show the Work's graph; `push` writes the URL (a UI entry), a hash-driven request leaves it as it is. */
  open(workId: string, opts: { push: boolean }): void;
  /** Leave the view (the URL no longer names a graph). */
  exit(): void;
}

const targets: ArgumentTarget[] = [];
let pending: { workId: string; push: boolean } | null = null;

export const argumentBus = {
  /** Shell on boot / popstate / hashchange (`push: false`), and any entry point outside the Library page (`push: true`). */
  request(workId: string, opts: { push: boolean } = { push: false }): void {
    pending = { workId, push: opts.push };
    const t = targets.find((x) => x.isOpen()) ?? targets[0];
    if (t) {
      pending = null;
      t.open(workId, opts);
    }
  },
  /** The URL stopped naming a graph (popstate to a plain URL). */
  exit(): void {
    pending = null;
    targets.find((x) => x.isOpen())?.exit();
  },
  register(t: ArgumentTarget): () => void {
    targets.push(t);
    if (pending !== null) {
      const request = pending;
      pending = null;
      // defer so the registering component finishes mounting first
      queueMicrotask(() => t.open(request.workId, { push: request.push }));
    }
    return () => {
      const i = targets.indexOf(t);
      if (i >= 0) targets.splice(i, 1);
    };
  },
};
