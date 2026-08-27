import { createContext, useContext } from "react";
import type { Tweaks } from "./theme";

// Shared workspace state, provided by the Shell so any pane (e.g. the Library's
// "open in 文档" action) can drive the document pane.
export interface Workspace {
  papers: string[]; // ingested reader doc ids
  currentDoc: string | null; // doc shown in 文档 panes
  setCurrentDoc: (id: string) => void;
  /** Show a document: set it current and switch the active pane to 文档.
      `anchor` (deep links only) is scrolled to once the doc has rendered. */
  openDoc: (docId?: string, anchor?: string | null) => void;
  /** Anchor from the current `/doc/<id>#<anchor>` URL, consumed by the doc pane. */
  pendingAnchor: string | null;
  clearPendingAnchor: () => void;
  tweaks: Tweaks;
}

const Ctx = createContext<Workspace | null>(null);

export const WorkspaceProvider = Ctx.Provider;

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWorkspace outside provider");
  return w;
}
