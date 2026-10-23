/**
 * Browser semantics for `history.pushState` / `replaceState` in happy-dom: a browser fires no event for them, but
 * happy-dom queues a `hashchange` (a timer later) whenever the fragment changed. In a Shell test that made the page's
 * own navigation come back to it as if the person had edited the address: an exploration that pushed `#explore/<seed>`
 * was handed to the explore bus again and, when that late event beat React's render, fetched a second time
 * (shelf-followups 07). Installed by tests/setup.ts; a real `hashchange` (assigning `location.hash`, a traversal) is
 * left alone.
 */
export function installBrowserHistorySemantics(): void {
  if (typeof window === "undefined" || typeof History === "undefined") return; // a `node` environment file
  /** `oldURL → newURL` of each fragment change a pushState / replaceState made, not yet swallowed. */
  const own: string[] = [];
  const key = (from: string, to: string) => `${from}\n${to}`;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = History.prototype[name];
    History.prototype[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const before = window.location.href;
      const result = original.apply(this, args);
      const after = window.location.href;
      if (new URL(before).hash !== new URL(after).hash) own.push(key(before, after));
      return result;
    };
  }
  window.addEventListener(
    "hashchange",
    (event) => {
      const i = own.indexOf(key(event.oldURL, event.newURL));
      if (i < 0) return;
      own.splice(i, 1);
      event.stopImmediatePropagation();
    },
    { capture: true }
  );
}
