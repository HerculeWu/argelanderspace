/**
 * Stage 14 explore state machine (D1/D2/D5/D8/D14) — lives in LibraryBody.
 *
 * - One explicit seed per session; "Explore from here" is the only way to
 *   change it; clicking a node never does.
 * - Only SUCCESSFUL seed transitions push the session stack / URL history;
 *   failures keep the current session (an error banner carries the failure),
 *   cancels are silent. Failed sessions never enter Back/Forward.
 * - Loading is an honest indeterminate overlay with a real AbortController;
 *   a previous successful graph stays put while the next request is in flight.
 * - "Add to Library" patches the node's libraryId in place — the graph is
 *   not recomputed and the viewport/selection/seed stay untouched.
 */

import { useCallback, useRef, useState } from "react";
import type { DiscoveryGraph } from "@argelanderspace/contracts";
import { fetchDiscovery } from "../api/discovery";
import { createWorks } from "../api/library";
import type { GraphCanvasStash } from "../graph/GraphCanvas";
import { clearExploreUrl, pushExploreUrl } from "../lib/explore-route";

export type ExploreFilter = "all" | "related" | "useful";
export type ExploreDisplay = "graph" | "list";
export type ExploreDetailTab = "abstract" | "citations";

export interface ExploreSession {
  key: string;
  seed: string;
  graph: DiscoveryGraph;
  selection: string | null;
  query: string;
  filter: ExploreFilter;
  display: ExploreDisplay;
  detailTab: ExploreDetailTab;
  scrollTop: number;
  /** GraphCanvas persistence bag (layout + viewport), revived on restore. */
  stash: GraphCanvasStash;
}

export interface ExploreError {
  seed: string;
  /** HTTP status; 0 = network-level failure. */
  status: number;
}

export function useExploreStack() {
  const [active, setActive] = useState(false);
  const [stack, setStack] = useState<{ sessions: ExploreSession[]; index: number }>({
    sessions: [],
    index: -1,
  });
  const [loading, setLoading] = useState<{ seed: string } | null>(null);
  const [error, setError] = useState<ExploreError | null>(null);
  /** In-flight add-to-library bibcode (dashed ring; per-candidate). */
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const counter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const current: ExploreSession | null =
    stack.index >= 0 ? (stack.sessions[stack.index] ?? null) : null;

  /**
   * Start (or hash-restore) an exploration. `pushUrl` distinguishes a
   * user-initiated transition (writes history) from a hash-driven navigation
   * (the URL already names the seed — writing again would duplicate entries).
   */
  const startExplore = useCallback(async (seed: string, opts: { pushUrl?: boolean } = {}) => {
    if (loadingRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading({ seed });
    setError(null);
    setActive(true);
    try {
      const out = await fetchDiscovery(seed, controller.signal);
      if (controller.signal.aborted) return;
      if (!out.ok) {
        // stay on the current session (if any); the banner reports the failure
        setError({ seed, status: out.status });
        return;
      }
      const session: ExploreSession = {
        key: `explore-${++counter.current}`,
        seed,
        graph: out.graph,
        selection: seed,
        query: "",
        filter: "all",
        display: "graph",
        detailTab: "abstract",
        scrollTop: 0,
        stash: {},
      };
      setStack((s) => {
        const sessions = [...s.sessions.slice(0, s.index + 1), session];
        return { sessions, index: sessions.length - 1 };
      });
      if (opts.pushUrl !== false) pushExploreUrl(seed); // D14: success only
    } catch (err) {
      if (controller.signal.aborted) return; // cancel: no error, no history
      if ((err as { name?: string })?.name === "AbortError") return;
      setError({ seed, status: 0 });
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  }, []);

  const cancelExplore = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(null);
    // cancelling the very first exploration returns to the library mode
    if (stackRef.current.index < 0) setActive(false);
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (loadingRef.current) return;
      const s = stackRef.current;
      const i = s.index + delta;
      if (i < 0 || i >= s.sessions.length) return;
      setError(null);
      setStack({ sessions: s.sessions, index: i });
      pushExploreUrl(s.sessions[i]!.seed); // URL mirrors the current seed
    },
    []
  );

  /** Leave explore mode (back-to-library / URL no longer names an exploration). */
  const exitExplore = useCallback(() => {
    abortRef.current?.abort();
    setActive(false);
    setLoading(null);
    setError(null);
    clearExploreUrl();
  }, []);

  /** Re-enter explore mode at the current stack position (sessions survive). */
  const resumeExplore = useCallback(() => {
    const s = stackRef.current;
    if (s.index < 0) return;
    setError(null);
    setActive(true);
    pushExploreUrl(s.sessions[s.index]!.seed);
  }, []);

  /** Hash-driven navigation (popstate / boot / manual edit). */
  const exploreFromHash = useCallback(
    (seed: string) => {
      const s = stackRef.current;
      const i = s.sessions.findIndex((x) => x.seed === seed);
      if (i >= 0) {
        // restore the known session; the URL already names it (no push)
        setError(null);
        setActive(true);
        setStack({ sessions: s.sessions, index: i });
        return;
      }
      void startExplore(seed, { pushUrl: false });
    },
    [startExplore]
  );

  /**
   * Add a candidate via the Stage 13 bibcode path — the ONLY mutation route
   * (stage plan §11). On created/exists the node's libraryId updates in
   * place; nothing about the graph/viewport/seed is recomputed.
   */
  const addToLibrary = useCallback(async (bibcode: string) => {
    if (adding) return null;
    setAdding(bibcode);
    setAddError(null);
    try {
      const resp = await createWorks({ mode: "bibcode", bibcode });
      const r = resp?.results[0];
      if (r && (r.status === "created" || r.status === "exists") && r.ref) {
        const workId = r.ref.id;
        setStack((s) => ({
          sessions: s.sessions.map((sess) => ({
            ...sess,
            graph: {
              ...sess.graph,
              nodes: sess.graph.nodes.map((n) =>
                n.bibcode === bibcode ? { ...n, libraryId: workId } : n
              ),
            },
          })),
          index: s.index,
        }));
        return workId;
      }
      setAddError(bibcode);
      return null;
    } finally {
      setAdding(null);
    }
  }, [adding]);

  /** Dismiss the error banner (the current session stays). */
  const dismissError = useCallback(() => setError(null), []);

  return {
    active,
    current,
    sessions: stack.sessions,
    index: stack.index,
    loading,
    error,
    adding,
    addError,
    startExplore,
    cancelExplore,
    step,
    exitExplore,
    resumeExplore,
    exploreFromHash,
    addToLibrary,
    dismissError,
    isExploringRef: activeRef,
  };
}

export type ExploreStack = ReturnType<typeof useExploreStack>;
