import { createContext, useContext } from "react";
import type { SettingsGroup } from "@argelanderspace/contracts";
import type { IntakeKind } from "../copilot/intake";
import type { Tweaks } from "./theme";

// Shared workspace state, provided by the Shell so any pane (e.g. the Library's
// "open in Doc" action) can drive the document pane.
export interface Workspace {
  papers: string[]; // ingested reader doc ids
  currentDoc: string | null; // doc shown in doc panes
  setCurrentDoc: (id: string) => void;
  /** Show a document: set it current and switch the active pane to the doc view.
      `anchor` (deep links only) is scrolled to once the doc has rendered. */
  openDoc: (docId?: string, anchor?: string | null) => void;
  /** Anchor from the current `/doc/<id>#<anchor>` URL, consumed by the doc pane. */
  pendingAnchor: string | null;
  clearPendingAnchor: () => void;
  /** Stage 8 §8: a doc was physically deleted via DELETE /api/paper/:id.
      `remaining` is the deleting work's doc_ids after the deletion (its new
      main doc is remaining[0]). Drops the doc from the local papers list (the
      Shell only fetches it once at boot) and migrates currentDoc per the
      three-state rule (see applyDocDeletion). */
  docDeleted: (docId: string, remaining: string[]) => void;
  /** Show the work's argument graph on a Library page (the Reader's "argument graph" entry; absent where it cannot). */
  openArgumentGraph?: (workId: string) => void;
  /**
   * The settings page's entries (desktop-app ticket 11): open the Copilot panel and its model/provider settings dialog,
   * as the panel's own settings button does; switch the active pane to Mail, where accounts are managed.
   */
  openCopilotSettings?: () => void;
  openMailAccounts?: () => void;
  /**
   * The Library's intake entries (project-intake ticket 06): open the Copilot panel and move in an existing project
   * there — a new conversation and one fixed, visible message in the user's name (`resume` when a checklist exists).
   */
  startIntake?: (kind: IntakeKind) => void;
  /**
   * Show the settings page on one group (the intake card's "Open settings" for the Copilot's file permission). The page
   * takes the group once it is shown and clears the request.
   */
  openSettingsGroup?: (group: SettingsGroup) => void;
  pendingSettingsGroup?: SettingsGroup | null;
  clearPendingSettingsGroup?: () => void;
  /**
   * What each Library page had selected (a library graph node id, not a Work id), by pane id, for the length of the session
   * (an entry goes when its pane closes). A Doc pane replaces the page (and
   * unmounts it); Back to the Library address brings it back with the Work the Doc was opened from still selected.
   */
  librarySelection?: {
    /** `undefined`: nothing remembered; `null`: the detail was closed. */
    get: (paneId: number) => string | null | undefined;
    set: (paneId: number, node: string | null) => void;
  };
  tweaks: Tweaks;
}

/**
 * The §8 three-state transition after a doc is deleted, as a pure function:
 * - deleted ≠ currentDoc → only the papers list loses the id;
 * - deleted == currentDoc and the work has docs left → current becomes the
 *   work's new main (remaining[0]);
 * - deleted == currentDoc and none left → currentDoc = null (empty state).
 */
export function applyDocDeletion(
  state: { papers: string[]; currentDoc: string | null },
  docId: string,
  remaining: string[]
): { papers: string[]; currentDoc: string | null } {
  const papers = state.papers.filter((p) => p !== docId);
  if (state.currentDoc !== docId) return { papers, currentDoc: state.currentDoc };
  return { papers, currentDoc: remaining[0] ?? null };
}

/**
 * A leave guard answers at once (`true` leave / `false` stay) or later: a `Promise` is a decision still pending (the
 * guard asks with the app's own dialog: the argument graph page, the PDF Reader, the text source editor, a Reader's
 * annotation drafts), and the change it guards waits for it. No caller treats a late answer as a refusal: every
 * change that a guard can hold back (a pane switch, a Doc switch, deleting the open Doc) waits for the answer.
 */
export type LeaveVerdict = boolean | Promise<boolean>;

/**
 * Who asked to leave: the person (`user`, the default: a dialog may be shown) or the Copilot acting on the view (`agent`: the
 * model is waiting for an answer and the person has not chosen to leave, so a guard that would need a dialog refuses
 * instead, for every view: the Copilot's request is `leave_blocked` whenever unsaved work is at stake).
 */
export type LeaveOrigin = "user" | "agent";
type LeaveGuard = (origin: LeaveOrigin) => LeaveVerdict;

interface GuardScope {
  /** The view whose pane this guard speaks for; absent: the Doc views (the Reader, the text editor). */
  view?: string;
  /** The pane that holds the guarded page; absent: any pane of `view`. */
  paneId?: number;
}
const leaveGuards = new Map<LeaveGuard, GuardScope>();

/**
 * Register a transient user-data leave guard for workspace navigation. A guard with a `view` (the Library page's
 * unsaved argument draft) only speaks when its page is being left or unmounted: a pane of that view is switched or
 * closed (`scope.paneId` narrows it to that one pane), never when a Doc is switched.
 */
export function registerWorkspaceLeaveGuard(guard: LeaveGuard, scope: string | GuardScope = {}): () => void {
  leaveGuards.set(guard, typeof scope === "string" ? { view: scope } : scope);
  return () => leaveGuards.delete(guard);
}

/**
 * Ask the guards that speak for leaving `view` (a pane's view; none: changing the open Doc, the Doc views' own guards) and,
 * of those, the ones of pane `paneId`. `true`/`false` at once, or a promise when a guard decides later; the guards are
 * asked one after the other and the first refusal ends it.
 */
export function askWorkspaceLeave(view?: string, paneId?: number, origin: LeaveOrigin = "user"): LeaveVerdict {
  const guards = [...leaveGuards]
    .filter(([, scope]) => (scope.view ?? "doc") === (view ?? "doc") && (scope.paneId === undefined || paneId === undefined || scope.paneId === paneId))
    .map(([guard]) => guard);
  const from = (index: number): LeaveVerdict => {
    for (let i = index; i < guards.length; i++) {
      const verdict = guards[i]!(origin);
      if (verdict === true) continue;
      if (verdict === false) return false;
      return verdict.then((ok) => (ok ? from(i + 1) : false));
    }
    return true;
  };
  return from(0);
}

/** Runs `proceed` once the guards for leaving `view` allow it (at once, or when a pending decision says yes); false: not yet or never. */
export function whenWorkspaceMayLeave(proceed: () => void, view?: string, paneId?: number): boolean {
  const verdict = askWorkspaceLeave(view, paneId);
  if (verdict === true) {
    proceed();
    return true;
  }
  if (verdict !== false) void verdict.then((ok) => ok && proceed());
  return false;
}

const Ctx = createContext<Workspace | null>(null);

export const WorkspaceProvider = Ctx.Provider;

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWorkspace outside provider");
  return w;
}
