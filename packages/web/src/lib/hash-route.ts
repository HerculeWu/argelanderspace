/**
 * The two Library-page modes that own the URL (exploration, `#explore/<id>`, and the argument graph view,
 * `#argument/<id>`) are routed the same way, so the route and the navigation bus are written once here, each mode
 * giving its prefix and what "open", "exit" and "is open" mean for a Library page (`explore-route.ts`,
 * `argument-route.ts`).
 *
 * Route: the open view owns `/#<prefix>/<url-encoded id>`; `push` writes one history entry, `clear` pushes the plain
 * URL back (Back/Forward walk the entries; the view itself never writes a second entry for the same URL).
 *
 * Bus: links Shell's popstate/hashchange handling (and any entry point outside the Library page) to the Library page
 * hosting the mode: the one that has it open, else the first registered. A request made while no Library page is
 * registered is held as `pending` until one registers (the Shell meanwhile makes sure a Library pane exists).
 */

export function createHashRoute(prefix: string) {
  const pattern = new RegExp(`^#${prefix}/([^/?#]+)`);
  const url = (id: string): string => `/#${prefix}/${encodeURIComponent(id)}`;
  const parse = (hash: string): string | null => {
    const m = pattern.exec(hash);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]) || null;
    } catch {
      return null;
    }
  };
  return {
    parse,
    url,
    /** pushState (not replaceState); a sandboxed preview that disallows History still works without it. */
    push(id: string): void {
      try {
        const target = url(id);
        if (window.location.pathname + window.location.hash !== target) window.history.pushState(null, "", target);
      } catch {
        /* sandboxed previews may disallow History */
      }
    },
    clear(): void {
      try {
        if (parse(window.location.hash) !== null) window.history.pushState(null, "", window.location.pathname || "/");
      } catch {
        /* ignore */
      }
    },
  };
}

export interface RouteBusConfig<T, R> {
  /** Whether this Library page currently hosts the mode. */
  active(target: T): boolean;
  open(target: T, request: R): void;
  exit(target: T): void;
  /** Whether a request may be served by this page (default: any). A request nobody accepts stays pending. */
  accepts?(target: T, request: R): boolean;
}

export function createRouteBus<T, R>(config: RouteBusConfig<T, R>) {
  const targets: T[] = [];
  let pending: R | null = null;
  const accepts = (t: T, r: R) => config.accepts?.(t, r) ?? true;
  return {
    /** Shell on boot / popstate / hashchange, and any entry point outside the Library page. */
    request(request: R): void {
      pending = request;
      const t = targets.find((x) => accepts(x, request) && config.active(x)) ?? targets.find((x) => accepts(x, request));
      if (t) {
        pending = null;
        config.open(t, request);
      }
    },
    /** The URL stopped naming the mode. */
    exit(): void {
      pending = null;
      const t = targets.find((x) => config.active(x));
      if (t) config.exit(t);
    },
    register(t: T): () => void {
      targets.push(t);
      if (pending !== null && accepts(t, pending)) {
        const request = pending;
        pending = null;
        // defer so the registering component finishes mounting first
        queueMicrotask(() => config.open(t, request));
      }
      return () => {
        const i = targets.indexOf(t);
        if (i >= 0) targets.splice(i, 1);
      };
    },
  };
}
