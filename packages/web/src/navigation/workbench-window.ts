import type { CopilotViewAction, NavigationTarget } from "@argelanderspace/contracts";
import { useEffect, useRef } from "react";
import { bus } from "../api/ws-instance";

/**
 * This window as the workbench's navigation target (release-0.2 ticket 05; `docs/operation-catalog.md` "Navigation").
 *
 * A window names itself once per page load and tells the server when the user gave it their attention: when it gains
 * focus, becomes visible, connects while visible, or is used (a click or key press, reported at most once a second) (`window.active`), and when it is hidden (`window.hidden`). It
 * reports again on every (re)connect of the socket, because the server forgets a window with its socket. The server picks
 * the most recently active one for a CLI "open somewhere" and sends it a `workbench.navigate` frame; this window does
 * what the user's own click would do, through the same Shell actions the Copilot uses, and answers what it really
 * showed. It never focuses or raises anything.
 */

const randomId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};
export const WINDOW_ID = randomId();
/** The least time between two input-driven attention reports. */
const INPUT_REPORT_MS = 1000;

/** What the Shell reports for an action: shown, or the page's own reason. */
export interface NavigationOutcome {
  ok: boolean;
  detail?: string | undefined;
}
type RunViewAction = (action: CopilotViewAction) => Promise<NavigationOutcome>;

/** Show the place; the Doc is opened first, then the anchor is applied with the Reader's own navigate. */
export async function runNavigation(target: NavigationTarget, run: RunViewAction): Promise<NavigationOutcome> {
  if (target.op === "workspace.open_doc") {
    const { docId, anchor } = target.params;
    const opened = await run({ action: "open_doc", docId });
    if (!opened.ok || anchor === undefined) return opened;
    const placed = await run({ action: "navigate", docId, anchor });
    // The Doc is open either way; only the position is missing.
    return placed.ok ? placed : { ok: false, detail: placed.detail === "not_found" ? "anchor_not_found" : placed.detail };
  }
  if (target.op === "library.open_work") return run({ action: "select_work", refId: target.params.refId });
  return run({ action: "open_argument_graph", workId: target.params.workId });
}

function report(frame: object): void {
  try {
    bus.send(frame);
  } catch {
    /* the next (re)connect reports again */
  }
}

export function useWorkbenchWindow(runViewAction: RunViewAction): void {
  const run = useRef(runViewAction);
  run.current = runViewAction;
  useEffect(() => {
    const state = () => {
      const visible = document.visibilityState !== "hidden";
      report({ type: visible ? "window.active" : "window.hidden", windowId: WINDOW_ID });
    };
    const offs = [
      bus.onResync(state),
      bus.on("workbench.navigate", (msg) => {
        if (msg.windowId !== WINDOW_ID) return;
        void (async () => {
          const outcome = await runNavigation(msg.target, (action) => run.current(action)).catch((): NavigationOutcome => ({ ok: false, detail: "unavailable" }));
          report({ type: "window.navigated", windowId: WINDOW_ID, navId: msg.navId, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail.slice(0, 60) } : {}) });
        })();
      }),
    ];
    const onFocus = () => report({ type: "window.active", windowId: WINDOW_ID });
    const onVisibility = () => state();
    // Using the window counts too (a click or a key), at most once a second: focus and visibility events do not fire when
    // the user moves between two windows that are both on screen, or between tabs of a host that does not report it.
    let lastInput = 0;
    const onInput = () => {
      const now = Date.now();
      if (now - lastInput < INPUT_REPORT_MS) return;
      lastInput = now;
      onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pointerdown", onInput, { capture: true, passive: true });
    document.addEventListener("keydown", onInput, { capture: true, passive: true });
    state();
    return () => {
      for (const off of offs) off();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onInput, { capture: true });
      document.removeEventListener("keydown", onInput, { capture: true });
    };
  }, []);
}
