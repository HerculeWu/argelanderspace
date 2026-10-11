/**
 * One adapter per pane page (copilot ticket 37): what the Shell needs from a page for the Copilot — its status and
 * page fields for the published PageContext, and how a view action reaches it — so the Shell itself no longer knows
 * any page's shape. The page's own controller (PlanViewController, LibraryViewController, ...) stays an
 * implementation detail of its adapter.
 *
 * `handles`, `needsPane`, `noPaneResult`, `refused`, `shows`, `open` and `timeouts` depend on the action only: the
 * pane manager asks them of a detached instance when no pane shows the page.
 */
import type { CopilotViewAction, CopilotViewActionResult, PageContext } from "@argelanderspace/contracts";

export type PanePage = "plan" | "library" | "doc" | "write" | "mail";
/** What a view action answers; the detail words are the contract's own. */
export type ViewActionOutcome = Pick<CopilotViewActionResult, "ok" | "detail" | "http" | "folded">;
export type PaneStatus = PageContext["status"];
/** The page fields of a PageContext; an adapter fills only its own. */
export type PageFields = Partial<Pick<PageContext, "plan" | "library" | "discovery" | "reader" | "pdf" | "textSource" | "writer" | "mail">>;

/**
 * any: with no pane of this page the active pane is switched to it (or `open` shows it);
 * active-only: only the active pane, never switched to or from (the exploration controls);
 * existing-only: with no pane of this page the action is `unavailable` and nothing is switched for it.
 */
export type NeedsPane = "any" | "active-only" | "existing-only";

export interface PaneTimeouts {
  /** After a pane was switched to this page: how long to wait for its controls (0 = no separate wait). */
  readyMs: number;
  /** How long an `unavailable` answer is retried (0 = tried once). */
  applyMs: number;
  /** `applyMs` after `open` showed the page (a Doc that has to load first). */
  openedApplyMs?: number;
}
export const DEFAULT_TIMEOUTS: PaneTimeouts = { readyMs: 2000, applyMs: 2000 };

export interface PaneAdapter {
  page: PanePage;
  status(): PaneStatus;
  context(): PageFields;
  handles(action: CopilotViewAction): boolean;
  needsPane(action: CopilotViewAction): NeedsPane;
  /** The answer when no pane shows the page, instead of opening one (Writer: closing nothing is done). */
  noPaneResult?(action: CopilotViewAction): ViewActionOutcome | null;
  /** Whether this pane can do an active-only/existing-only action now, decided without changing anything. */
  available?(action: CopilotViewAction): boolean;
  /** The answer when panes of this page exist but none is `available` (default `unavailable`). */
  refused?(action: CopilotViewAction): ViewActionOutcome;
  /** Pages tied to one object (the Doc pane shows the current Doc): whether a pane of this page shows the action's. */
  shows?(action: CopilotViewAction): boolean;
  /** Shows the action's object instead of switching the active pane (the Doc pane: the Shell's own openDoc). */
  open?(action: CopilotViewAction): Promise<ViewActionOutcome>;
  /** Whether the page's controls are mounted (its controller registered); default ready once registered. */
  ready?(): boolean;
  apply?(action: CopilotViewAction): Promise<ViewActionOutcome>;
  timeouts?: PaneTimeouts;
}

/** A value a page reports for its pane; setting the same value again is not a change. */
export function reported<T>(notify: () => void) {
  let value: T | null = null;
  return {
    get: () => value,
    set: (_paneId: number, next: T | null) => {
      if (value === next) return;
      value = next;
      notify();
    },
  };
}

/** A controller a page registers for its pane (no re-render: only a view action looks at it). */
export function registered<T>() {
  let value: T | null = null;
  return {
    get: () => value,
    set: (_paneId: number, next: T | null) => {
      value = next;
    },
  };
}

export const unavailable = (): ViewActionOutcome => ({ ok: false, detail: "unavailable" });
