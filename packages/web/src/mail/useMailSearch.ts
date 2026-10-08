import type { MailHeader, MailSearchCriteria } from "@argelanderspace/contracts";
import { useCallback, useRef, useState } from "react";
import { MailApiError } from "../api/mail";
import { searchMail } from "../api/mail-manage";
import { parseSearchQuery } from "./search-query";

const PAGE = 50;

export interface SearchTarget {
  accountId: string;
  folder: string;
}
/** Same shape as the folder list sources of MailView, so the list renders either one. */
export interface SearchSource {
  accountId: string;
  folder: string;
  headers: MailHeader[];
  uidValidity: number | null;
  nextBefore: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  stale: boolean;
  /** Messages on the server matching the search (all pages). */
  matches: number;
}
interface SearchState {
  text: string;
  criteria: MailSearchCriteria | null;
  invalid: "date" | null;
  targets: SearchTarget[];
  sources: Record<string, SearchSource>;
}
export interface HeaderRef {
  accountId: string;
  folder: string;
  uid: number;
}

const keyOf = (accountId: string, folder: string) => `${accountId}\u0000${folder}`;
const errorCode = (e: unknown) => (e instanceof MailApiError ? e.code : "unreachable");

/**
 * Server-side search state (Mail ticket 06). Nothing is searched locally: every
 * run asks the IMAP server, results are never cached, and a newer run (or
 * clearing) makes older answers harmless.
 */
export function useMailSearch() {
  const [state, setState] = useState<SearchState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const runSeq = useRef(0);
  const pageSeq = useRef(new Map<string, number>());
  const aborts = useRef(new Set<AbortController>());

  const abortAll = () => {
    for (const a of aborts.current) a.abort();
    aborts.current.clear();
  };

  const fetchSource = useCallback(
    async (run: number, criteria: MailSearchCriteria, target: SearchTarget, more: boolean) => {
      const key = keyOf(target.accountId, target.folder);
      const page = (pageSeq.current.get(key) ?? 0) + 1;
      pageSeq.current.set(key, page);
      const prev = stateRef.current?.sources[key];
      const before = more ? (prev?.nextBefore ?? null) : null;
      const base: SearchSource = {
        accountId: target.accountId,
        folder: target.folder,
        headers: more ? (prev?.headers ?? []) : [],
        uidValidity: prev?.uidValidity ?? null,
        nextBefore: more ? (prev?.nextBefore ?? null) : null,
        loading: !more,
        loadingMore: more,
        error: null,
        stale: false,
        matches: more ? (prev?.matches ?? 0) : 0,
      };
      const put = (s: SearchSource) =>
        setState((cur) => (cur && runSeq.current === run ? { ...cur, sources: { ...cur.sources, [key]: s } } : cur));
      put(base);
      const abort = new AbortController();
      aborts.current.add(abort);
      try {
        const r = await searchMail(
          target.accountId,
          { folder: target.folder, criteria, limit: PAGE, ...(before ? { before } : {}) },
          abort.signal
        );
        if (runSeq.current !== run || pageSeq.current.get(key) !== page) return;
        const seen = new Set<number>();
        const merged = [...base.headers, ...r.headers].filter((h) => !seen.has(h.uid) && seen.add(h.uid));
        put({
          ...base,
          headers: merged,
          uidValidity: r.uidValidity,
          nextBefore: r.nextBefore,
          matches: r.matches,
          loading: false,
          loadingMore: false,
        });
      } catch (e) {
        if ((e as { name?: string } | null)?.name === "AbortError") return;
        if (runSeq.current !== run || pageSeq.current.get(key) !== page) return;
        put({ ...base, loading: false, loadingMore: false, error: errorCode(e) });
      } finally {
        aborts.current.delete(abort);
      }
    },
    []
  );

  /** Start a search over the given folders. Returns false when the text holds nothing to search for. */
  const run = useCallback(
    (text: string, targets: SearchTarget[]): boolean => {
      const parsed = parseSearchQuery(text);
      abortAll();
      const myRun = ++runSeq.current;
      pageSeq.current.clear();
      if (!parsed.ok) {
        if (parsed.reason === "empty") {
          setState(null);
          return false;
        }
        setState({ text, criteria: null, invalid: "date", targets, sources: {} });
        return false;
      }
      setState({ text, criteria: parsed.criteria, invalid: null, targets, sources: {} });
      for (const t of targets) void fetchSource(myRun, parsed.criteria, t, false);
      return true;
    },
    [fetchSource]
  );

  const more = useCallback(() => {
    const cur = stateRef.current;
    if (!cur?.criteria) return;
    for (const t of cur.targets) {
      const s = cur.sources[keyOf(t.accountId, t.folder)];
      if (s && s.nextBefore !== null && !s.loadingMore) void fetchSource(runSeq.current, cur.criteria, t, true);
    }
  }, [fetchSource]);

  const rerun = useCallback(() => {
    const cur = stateRef.current;
    if (cur) run(cur.text, cur.targets);
  }, [run]);

  const clear = useCallback(() => {
    abortAll();
    runSeq.current++;
    pageSeq.current.clear();
    setState(null);
  }, []);

  /** Apply a flag change to a result row (the server confirmed it, or the UI is optimistic / rolling back). */
  const patchHeader = useCallback((ref: HeaderRef, patch: Partial<Pick<MailHeader, "unread" | "starred">>) => {
    const key = keyOf(ref.accountId, ref.folder);
    setState((cur) => {
      const s = cur?.sources[key];
      if (!cur || !s) return cur;
      return {
        ...cur,
        sources: { ...cur.sources, [key]: { ...s, headers: s.headers.map((h) => (h.uid === ref.uid ? { ...h, ...patch } : h)) } },
      };
    });
  }, []);

  /** Take a row out of the results; the returned function puts it back where it was. */
  const removeHeader = useCallback((ref: HeaderRef): (() => void) => {
    const key = keyOf(ref.accountId, ref.folder);
    const s = stateRef.current?.sources[key];
    const index = s ? s.headers.findIndex((h) => h.uid === ref.uid) : -1;
    const header = s?.headers[index];
    if (!s || !header) return () => {};
    setState((cur) => {
      const c = cur?.sources[key];
      if (!cur || !c) return cur;
      return {
        ...cur,
        sources: {
          ...cur.sources,
          [key]: { ...c, headers: c.headers.filter((h) => h.uid !== ref.uid), matches: Math.max(0, c.matches - 1) },
        },
      };
    });
    return () =>
      setState((cur) => {
        const c = cur?.sources[key];
        if (!cur || !c || c.headers.some((h) => h.uid === ref.uid)) return cur;
        const headers = [...c.headers];
        headers.splice(Math.min(index, headers.length), 0, header);
        return { ...cur, sources: { ...cur.sources, [key]: { ...c, headers, matches: c.matches + 1 } } };
      });
  }, []);

  const sources: SearchSource[] = state
    ? state.targets.map((t) => state.sources[keyOf(t.accountId, t.folder)]).filter((s): s is SearchSource => !!s)
    : [];
  return {
    active: state !== null,
    text: state?.text ?? "",
    invalid: state?.invalid ?? null,
    sources,
    matches: sources.reduce((n, s) => n + s.matches, 0),
    settled: state !== null && state.invalid === null && sources.length === state.targets.length && sources.every((s) => !s.loading),
    run,
    more,
    rerun,
    clear,
    patchHeader,
    removeHeader,
    find: (ref: HeaderRef) =>
      stateRef.current?.sources[keyOf(ref.accountId, ref.folder)]?.headers.find((h) => h.uid === ref.uid),
    uidValidity: (ref: HeaderRef) => stateRef.current?.sources[keyOf(ref.accountId, ref.folder)]?.uidValidity ?? undefined,
  };
}
