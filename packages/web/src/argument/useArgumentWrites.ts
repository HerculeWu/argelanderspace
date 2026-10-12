/**
 * Every write the argument graph page makes goes through here (ticket 05): one serial queue over the commit path
 * (`commit.ts`). Each queued write applies its pure operation to the newest graph the page holds (the server's answer to
 * the write before it is adopted at once), so two quick edits never race on a stale `rev`, and a 409 is reported, never
 * overwritten: the page reloads the latest graph and tells the person the change was not written.
 */
import type { ArgumentEditResult, ArgumentGraph } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchArgumentGraph } from "../api/argument-graph";
import { type CommitOutcome, commitArgumentEdit } from "./commit";
import { rejectionMessages, serverInvalidText } from "./editText";

export interface ArgumentNotice {
  id: number;
  tone: "info" | "warning" | "danger";
  text: string;
  /** One button on the notice (Undo). */
  action?: { label: string; busyLabel?: string; run: () => void };
  /** Milliseconds until it goes away by itself; 0 stays until dismissed. */
  ttl: number;
}

export function useArgumentWrites({ workId, graph, adopt, refresh }: { workId: string; graph: ArgumentGraph | null; adopt: (graph: ArgumentGraph) => void; refresh: () => void }) {
  const { t } = useTranslation();
  const latest = useRef<ArgumentGraph | null>(graph);
  latest.current = graph;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [pending, setPending] = useState(0);
  const [notices, setNotices] = useState<ArgumentNotice[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);
  const notify = useCallback(
    (tone: ArgumentNotice["tone"], text: string, extra: Partial<Pick<ArgumentNotice, "action" | "ttl">> = {}): number => {
      const id = ++seq.current;
      const ttl = extra.ttl ?? (tone === "info" ? 5000 : 9000);
      setNotices((list) => [...list.filter((n) => n.text !== text), { id, tone, text, ...extra, ttl }]);
      if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss]
  );
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    []
  );

  /**
   * Applies `edit` to the newest graph and writes it. `base` overrides the graph it is applied to (undo applies to the graph
   * its delete produced, so a graph that moved on in between is a conflict, not a silent overwrite).
   */
  const commit = useCallback(
    <T extends object>(edit: (graph: ArgumentGraph) => ArgumentEditResult<T>, base?: ArgumentGraph): Promise<CommitOutcome<T>> => {
      setPending((n) => n + 1);
      const run = queue.current.then(async (): Promise<CommitOutcome<T>> => {
        const from = base ?? latest.current;
        if (!from) return { kind: "error", unreachable: false };
        const outcome = await commitArgumentEdit(workId, from, edit);
        if (outcome.kind === "ok") {
          latest.current = outcome.graph;
          adopt(outcome.graph);
        } else if (outcome.kind === "conflict") refresh();
        return outcome;
      });
      queue.current = run.then(
        () => undefined,
        () => undefined
      );
      return run.finally(() => setPending((n) => n - 1));
    },
    [workId, adopt, refresh]
  );

  /** What a person is told when a write other than a form save did not go through (null: it did). */
  const failureText = useCallback(
    (outcome: CommitOutcome<object>): string | null => {
      switch (outcome.kind) {
        case "ok":
          return null;
        case "rejected":
          return rejectionMessages(t, outcome.rejection).join(" ");
        case "conflict":
          return t("argument.edit.writeConflict");
        case "invalid":
          return serverInvalidText(t, outcome.detail).join(" ");
        case "not-found":
          return t("argument.edit.writeNotFound");
        case "corrupt":
          return t("argument.edit.writeCorrupt");
        case "error":
          return outcome.unreachable ? t("argument.edit.writeUnreachable") : t("argument.edit.writeError");
      }
    },
    [t]
  );

  /** Writes and, if it did not go through, tells the person why. */
  const perform = useCallback(
    async <T extends object>(edit: (graph: ArgumentGraph) => ArgumentEditResult<T>, base?: ArgumentGraph): Promise<CommitOutcome<T>> => {
      const outcome = await commit(edit, base);
      const failure = failureText(outcome);
      if (failure) notify(outcome.kind === "rejected" ? "warning" : "danger", failure);
      return outcome;
    },
    [commit, failureText, notify]
  );

  /** Reads the graph again for a person who asked for it (the conflict box's Reload); the answer becomes the current graph. */
  const reload = useCallback(async (): Promise<ArgumentGraph | null> => {
    const load = await fetchArgumentGraph(workId);
    if (load.kind !== "ok") {
      notify("danger", load.kind === "error" && load.unreachable ? t("argument.edit.writeUnreachable") : t("argument.edit.writeError"));
      return null;
    }
    latest.current = load.graph;
    adopt(load.graph);
    return load.graph;
  }, [workId, adopt, notify, t]);

  return { commit, perform, reload, failureText, notices, notify, dismiss, writing: pending > 0, latest };
}
