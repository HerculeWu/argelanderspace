/**
 * Reading a Work's argument graph for the view (ticket 04): the latest read, refreshed whenever the server says this
 * Work's graph changed (`argument-graph.changed`, from its own write or an external edit of the file). A refresh keeps
 * showing the graph it has until the new read arrives; the selection is the view's, not the read's. A reconnect of the
 * socket reads once more (an event may have been missed). A refresh that fails for a transient reason (no answer, a server
 * failure) keeps the graph on screen and reports `refreshFailed`; only a missing Work (404) or an unreadable file replaces
 * it, as before. The first read has no graph to keep, so its failure is the error state.
 *
 * The page never goes back to an older version of what it has seen: a graph the page adopts (the answer to its own write,
 * a reload) replaces the shown one only when its `rev` is not lower, and a read that was already under way when something
 * was adopted is ignored if it turns out older than what is shown (it may have started before that write), while a read
 * that started after the last adopt is the server's current word and wins whatever its `rev` (a file restored by hand).
 */
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ArgumentGraphLoad, fetchArgumentGraph } from "../api/argument-graph";
import { onArgumentGraphChanged } from "../api/ws";

export type ArgumentGraphState = { phase: "loading" } | { phase: "ready"; graph: ArgumentGraph } | { phase: "not-found" } | { phase: "corrupt" } | { phase: "error"; unreachable: boolean };

const fromLoad = (load: ArgumentGraphLoad): ArgumentGraphState => (load.kind === "ok" ? { phase: "ready", graph: load.graph } : load.kind === "error" ? { phase: "error", unreachable: load.unreachable } : { phase: load.kind });

/** Equal reads keep the same object, so an idempotent refresh (the server's own write fires two events) re-renders nothing. */
const sameGraph = (a: ArgumentGraph, b: ArgumentGraph) => JSON.stringify(a) === JSON.stringify(b);

export function useArgumentGraph(
  workId: string,
  enabled = true
): { state: ArgumentGraphState; reload: () => void; refresh: () => void; refreshFailed: boolean; refreshing: boolean; adopt: (graph: ArgumentGraph) => void } {
  const [state, setState] = useState<ArgumentGraphState>({ phase: "loading" });
  const [refreshFailed, setRefreshFailed] = useState(false);
  /** A read that keeps the graph on screen is under way (the notice's Retry shows it). */
  const [refreshing, setRefreshing] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  /** Counts the graphs adopted; a read compares it with the count at its start. */
  const adopted = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const read = useCallback(
    (initial: boolean) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const mine = ++generation.current;
      const adoptedAtStart = adopted.current;
      if (initial) {
        setState({ phase: "loading" });
        setRefreshFailed(false);
      }
      setRefreshing(!initial);
      void fetchArgumentGraph(workId, controller.signal).then(
        (load) => {
          // a later read (or another Work) owns the state now
          if (mine !== generation.current) return;
          setRefreshing(false);
          // a graph that is on screen survives a failed refresh; the failure is reported beside it
          if (!initial && load.kind === "error" && stateRef.current.phase === "ready") {
            setRefreshFailed(true);
            return;
          }
          setRefreshFailed(false);
          const next = fromLoad(load);
          setState((current) => {
            if (current.phase !== "ready" || next.phase !== "ready") return next;
            if (sameGraph(current.graph, next.graph)) return current;
            // something was adopted while this read was under way and it is older than that: it started before the write
            if (!initial && adopted.current !== adoptedAtStart && next.graph.rev < current.graph.rev) return current;
            return next;
          });
        },
        () => undefined // aborted
      );
    },
    [workId]
  );

  /**
   * Takes a graph the page itself just wrote or read (the server's answer to its PUT, or a reload the person asked for) as
   * the current one without waiting for the broadcast; never over a newer `rev` already shown. A read in flight is not
   * dropped: it may have started after a change from elsewhere that this answer does not know of (see the header).
   */
  const adopt = useCallback((graph: ArgumentGraph) => {
    adopted.current++;
    setRefreshFailed(false);
    setState((current) => {
      if (current.phase !== "ready") return { phase: "ready", graph };
      if (sameGraph(current.graph, graph) || graph.rev < current.graph.rev) return current;
      return { phase: "ready", graph };
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    read(true);
    const off = onArgumentGraphChanged(
      (msg) => {
        if (msg.work_id === workId) read(false);
      },
      () => read(false)
    );
    return () => {
      off();
      generation.current++;
      abort.current?.abort();
    };
  }, [enabled, workId, read]);

  return { state, reload: () => read(true), refresh: () => read(false), refreshFailed, refreshing, adopt };
}
