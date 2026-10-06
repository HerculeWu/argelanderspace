import {
  buildReaderReading,
  type PdfPage,
  type ReaderPage,
  type ReaderPanel,
  type ReaderRightTab,
  type ReaderSelection,
} from "@argelanderspace/contracts";
import { createContext, type MutableRefObject, useContext, useEffect, useMemo, useRef } from "react";
import type { ReaderSessionState } from "./ReaderSession";

/**
 * What the Reader tells the Copilot about itself, and the Reader's own controllers the Copilot may drive
 * (copilot ticket 18). The page is built from DATA: the admitted epoch of the ReaderSession (IR, annotations and
 * asset digests of one coherent read), never from mounted DOM, so the whole scrollable document is in it however
 * little of it is rendered. Position and the folds are hints and controls, not content.
 */

/** The pieces the Reader's controls own; the workspace registers them while it is mounted. */
export interface ReaderWorkspaceHandle {
  /** A deep-link anchor: block/section/float id, reference id or `ann-<id>` (the same code the URL hash uses). */
  navigate: (anchor: string) => "ok" | "not_found" | "unavailable";
  jumpBack: () => "ok" | "disabled" | "unavailable";
  /** Returns the other panel when unfolding this one folded it (the article keeps its minimum column). */
  setPanel: (panel: ReaderPanel, collapsed: boolean) => ReaderPanel | null;
  setRightTab: (tab: ReaderRightTab) => void;
}

/** What Shell calls for one pane; answers the same detail words as every other bound-view action. */
export interface ReaderViewController {
  docId: () => string | null;
  apply: (
    action: import("@argelanderspace/contracts").ReaderViewAction
  ) => Promise<{ ok: boolean; detail?: "not_found" | "unavailable" | "disabled"; folded?: ReaderPanel }>;
}

/** What the PDF Reader's own controls answer to the Copilot (copilot ticket 20); pages in the actions are zero-based. */
export interface PdfViewHandle {
  apply: (action: import("@argelanderspace/contracts").ReaderViewAction) => Promise<{
    ok: boolean;
    detail?: "not_found" | "unavailable" | "disabled";
  }>;
}
/** What the PDF Reader tells its pane: its page (identity, position, controls) and the handle that drives it. */
export interface PdfBridge {
  publish: (page: PdfPage | null) => void;
  setHandle: (handle: PdfViewHandle | null) => void;
}
export const PdfBridgeContext = createContext<PdfBridge>({ publish() {}, setHandle() {} });
export const usePdfBridge = () => useContext(PdfBridgeContext);

export interface ReaderLive {
  position: ReaderPage["position"];
  canGoBack: boolean;
  /** The annotation whose popover is open. */
  openAnnotationId?: string | null;
}
export interface ReaderPanels {
  outlineCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: ReaderRightTab;
}

export interface ReaderBridge {
  /** The session's state, published whenever it changes. `null` when no LaTeX session is mounted. */
  setSession: (docId: string, state: ReaderSessionState | null, format?: "latex" | "text") => void;
  /** A text Doc's own tabs (copilot ticket 29): Reader or Markdown source. */
  setTextView: (setView: ((view: "reader" | "source") => void) | null) => void;
  setLive: (live: ReaderLive | null) => void;
  /** The Doc's description could not be loaded: there is no session, and the page says so (an error, with its reason). */
  setFailure: (docId: string | null) => void;
  setPanels: (panels: ReaderPanels | null) => void;
  setHandle: (handle: ReaderWorkspaceHandle | null) => void;
  /** The Retry the page offers right now (sync/error banner, annotations panel, load-error page), if any. */
  setRetry: (retry: (() => void) | null) => void;
}
const NONE: ReaderBridge = {
  setSession() {},
  setTextView() {},
  setLive() {},
  setFailure() {},
  setPanels() {},
  setHandle() {},
  setRetry() {},
};
export const ReaderBridgeContext = createContext<ReaderBridge>(NONE);
export const useReaderBridge = () => useContext(ReaderBridgeContext);

/** The user's selection as the page publishes it: only one made in the epoch being published. */
function selectionOf(state: ReaderSessionState): ReaderSelection | null {
  const fingerprint = state.accepted?.file.content_fingerprint;
  return state.phase === "ready" && state.selection && state.selection.fingerprint === fingerprint
    ? state.selection
    : null;
}

/**
 * Whether the user has annotation text typed and not saved: presence and which annotation, never the text. A write the
 * Copilot makes does not touch these drafts (the page keeps them, and blocks saving one whose annotation changed).
 */
function draftsOf(state: ReaderSessionState): ReaderPage["drafts"] {
  const edit = Object.values(state.editDrafts).map((d) => ({
    annotationId: d.annotationId,
    blocked: d.blocked,
  }));
  const create = state.createDraft.body !== "";
  return create || edit.length > 0 ? { create, edit } : undefined;
}

/** Position changes during a scroll are a hint; they are collapsed, the rest of the page is published at once. */
const POSITION_SETTLE_MS = 250;

/**
 * The publisher behind one Reader pane: collects the pieces, builds the page and hands it to Shell. The reading is
 * rebuilt only when the admitted epoch itself changes.
 */
export function useReaderPublisher(
  paneId: number,
  onContext: ((paneId: number, page: ReaderPage | null) => void) | undefined,
  onController: ((paneId: number, controller: ReaderViewController | null) => void) | undefined,
  docId: () => string | null,
  pdfHandle?: MutableRefObject<PdfViewHandle | null>
) {
  const parts = useRef({
    docId: null as string | null,
    format: "latex" as "latex" | "text",
    textView: null as ((view: "reader" | "source") => void) | null,
    failure: null as string | null,
    state: null as ReaderSessionState | null,
    live: null as ReaderLive | null,
    panels: null as ReaderPanels | null,
    handle: null as ReaderWorkspaceHandle | null,
    retry: null as (() => void) | null,
    reading: null as { accepted: unknown; value: ReaderPage["reading"] } | null,
    timer: 0,
    published: undefined as ReaderPage | null | undefined,
  });
  const out = useRef({ onContext, onController, docId });
  out.current = { onContext, onController, docId };

  const bridge = useMemo<ReaderBridge>(() => {
    const p = parts.current;
    const publish = () => {
      let page: ReaderPage | null = null;
      const state = p.state;
      if (!state && p.failure) {
        page = {
          docId: p.failure,
          format: "latex",
          sync: { phase: "error", reason: "read" },
          reading: null,
          position: null,
          selection: null,
          panels: p.panels ?? { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
          canGoBack: false,
        };
      }
      if (state && p.docId) {
        // Rebuilt only for a new admitted epoch (the accepted read is replaced on every sync).
        // The whole-reading representation of the admitted epoch: LaTeX or text (copilot ticket 29), by what was admitted.
        if (state.phase === "ready" && state.accepted) {
          const ir = state.accepted.ir;
          if (p.reading?.accepted !== state.accepted)
            p.reading = {
              accepted: state.accepted,
              value: buildReaderReading({
                ir,
                file: state.accepted.file,
                assets: state.accepted.assets,
              }),
            };
        }
        const reading = state.phase === "ready" && p.reading ? p.reading.value : null;
        const drafts = draftsOf(state);
        page = {
          docId: p.docId,
          format: p.format,
          sync: {
            phase: state.phase === "initial" ? "syncing" : state.phase,
            ...(state.phase !== "ready" && state.reason ? { reason: state.reason } : {}),
          },
          reading,
          position: reading ? (p.live?.position ?? null) : null,
          selection: reading ? selectionOf(state) : null,
          panels: p.panels ?? { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
          openAnnotationId: reading ? (p.live?.openAnnotationId ?? null) : null,
          canGoBack: reading ? (p.live?.canGoBack ?? false) : false,
          ...(drafts ? { drafts } : {}),
        };
      }
      const before = p.published;
      if (
        before &&
        page &&
        before.docId === page.docId &&
        before.reading === page.reading &&
        before.canGoBack === page.canGoBack &&
        JSON.stringify([before.sync, before.position, before.selection, before.panels, before.openAnnotationId, before.drafts]) ===
          JSON.stringify([page.sync, page.position, page.selection, page.panels, page.openAnnotationId, page.drafts])
      )
        return;
      if (before === null && page === null) return;
      p.published = page;
      out.current.onContext?.(paneId, page);
    };
    const now = () => {
      window.clearTimeout(p.timer);
      p.timer = 0;
      publish();
    };
    return {
      setSession: (id, state, format = "latex") => {
        p.docId = state ? id : null;
        p.format = format;
        p.state = state;
        now();
      },
      setTextView: (setView) => {
        p.textView = setView;
      },
      setLive: (live) => {
        const before = p.live;
        p.live = live;
        const same =
          before?.canGoBack === live?.canGoBack &&
          before?.openAnnotationId === live?.openAnnotationId &&
          JSON.stringify(before?.position) === JSON.stringify(live?.position);
        if (same) return;
        // Only the position is a hint worth waiting for; the back button and the open annotation are published at once.
        if (before?.canGoBack !== live?.canGoBack || before?.openAnnotationId !== live?.openAnnotationId) now();
        else if (!p.timer) p.timer = window.setTimeout(now, POSITION_SETTLE_MS);
      },
      setFailure: (id) => {
        p.failure = id;
        now();
      },
      setPanels: (panels) => {
        p.panels = panels;
        now();
      },
      setHandle: (handle) => {
        p.handle = handle;
      },
      setRetry: (retry) => {
        p.retry = retry;
      },
    };
  }, [paneId]);

  useEffect(() => {
    const p = parts.current;
    const controller: ReaderViewController = {
      docId: () => out.current.docId(),
      apply: async (action) => {
        if (action.docId !== out.current.docId()) return { ok: false, detail: "unavailable" };
        // A PDF Doc is shown: its own Reader answers every action (its controls are not the LaTeX Reader's).
        if (pdfHandle?.current) return pdfHandle.current.apply(action);
        if (action.action === "retry_sync") {
          if (!p.retry) return { ok: false, detail: "disabled" };
          p.retry();
          return { ok: true };
        }
        if (action.action === "set_text_view") {
          if (!p.textView) return { ok: false, detail: "unavailable" };
          p.textView(action.view);
          return { ok: true };
        }
        const handle = p.handle;
        if (!handle) return { ok: false, detail: "unavailable" };
        switch (action.action) {
          case "navigate": {
            // a text Doc's Reader may be behind its source tab: showing the place means showing the reading
            p.textView?.("reader");
            const result = handle.navigate(action.anchor);
            return result === "ok" ? { ok: true } : { ok: false, detail: result };
          }
          case "jump_back": {
            const result = handle.jumpBack();
            return result === "ok" ? { ok: true } : { ok: false, detail: result };
          }
          case "set_panel": {
            const folded = handle.setPanel(action.panel, action.collapsed);
            return folded ? { ok: true, folded } : { ok: true };
          }
          case "set_right_tab":
            handle.setRightTab(action.tab);
            return { ok: true };
          default:
            // A PDF control while a LaTeX Doc is shown: there is no such control here.
            return { ok: false, detail: "unavailable" };
        }
      },
    };
    out.current.onController?.(paneId, controller);
    return () => {
      window.clearTimeout(p.timer);
      out.current.onController?.(paneId, null);
      out.current.onContext?.(paneId, null);
      p.published = undefined;
    };
  }, [paneId]);
  return bridge;
}
