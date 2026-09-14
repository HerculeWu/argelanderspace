import { createContext, useContext } from "react";
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

const Ctx = createContext<Workspace | null>(null);

export const WorkspaceProvider = Ctx.Provider;

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWorkspace outside provider");
  return w;
}
