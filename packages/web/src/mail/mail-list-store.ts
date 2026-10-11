import type {
  MailAccount,
  MailAccountsResponse,
  MailFolder,
  MailFolderRole,
  MailFoldersResponse,
  MailHeader,
  MailHeadersResponse,
} from "@argelanderspace/contracts";
import { mailErrorCode } from "../api/mail";
import type { MailLiveEvent } from "./mailLive";

/**
 * The Mail page's lists outside React (ticket 47): the accounts, each account's folder tree with its health and
 * unread counts, and every loaded message list with its paging cursor and UIDVALIDITY epoch. It owns how those
 * are loaded (version numbers against stale answers, silent reloads that never preempt what the user asked for),
 * the live reloads a server push causes, what the page tells the shared live picture, and the optimistic
 * changes the message actions make and roll back. The remote mailbox stays the authority (ADR 0008): every list
 * here is what the server last said plus the optimistic changes still waiting for its answer.
 *
 * All I/O goes through `deps`; MailView renders the snapshot with `useSyncExternalStore`.
 */

const PAGE = 50;
const LIVE_DEBOUNCE_MS = 250;
const AUTH_CODES = new Set(["auth_failed", "credential_missing"]);

export type Health = "loading" | "ok" | "auth" | "offline";
export interface AccountState {
  health: Health;
  code: string | null;
  stale: boolean;
  folders: MailFolder[];
}
export interface Source {
  accountId: string;
  folder: string;
  headers: MailHeader[];
  uidValidity: number | null;
  nextBefore: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  stale: boolean;
}
export type Scope = { kind: "unified" } | { kind: "folder"; accountId: string; path: string };
export interface HeaderRef {
  accountId: string;
  folder: string;
  uid: number;
}
export interface SourceRef {
  accountId: string;
  folder: string;
}
export type HeaderPatch = Partial<Pick<MailHeader, "unread" | "starred">>;

export interface MailListSnapshot {
  accounts: MailAccount[] | null;
  rev: number;
  accountsError: string | null;
  states: Readonly<Record<string, AccountState>>;
  sources: Readonly<Record<string, Source>>;
}

export interface MailListStoreDeps {
  api: {
    fetchMailAccounts(): Promise<Pick<MailAccountsResponse, "accounts" | "rev">>;
    fetchMailFolders(accountId: string): Promise<Pick<MailFoldersResponse, "folders" | "stale">>;
    fetchMailHeaders(
      accountId: string,
      folder: string,
      opts: { before: number | null; limit: number }
    ): Promise<Pick<MailHeadersResponse, "headers" | "uidValidity" | "nextBefore" | "stale">>;
  };
  /**
   * The shared live picture (mailLive): its pushes, and what this page knows from its own folder fetches. The pushes
   * do not come from the mailLive singleton directly: MailView receives them with `useMailLiveEvents` (which keeps
   * the live channel open while the page is mounted) and forwards them into `subscribe`.
   */
  live: {
    subscribe(handler: (event: MailLiveEvent) => void): () => void;
    report(views: readonly { accountId: string; inbox: number | null; blocked: boolean }[]): void;
  };
  clock: MailListClock;
  /**
   * The search results (useMailSearch), which show rows of the same messages: an optimistic change is made there
   * as well, and a row only the search shows is still found.
   */
  mirror?: {
    patch(ref: HeaderRef, patch: HeaderPatch): void;
    remove(ref: HeaderRef): () => void;
    find(ref: HeaderRef): MailHeader | undefined;
    uidValidity(ref: HeaderRef): number | undefined;
  };
}

export interface MailListClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MailListStore = ReturnType<typeof createMailListStore>;

export const sourceKey = (accountId: string, folder: string) => `${accountId}\u0000${folder}`;

/** The browser's clock. */
export const browserMailClock: MailListClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const inboxOf = (st: AccountState | undefined) => st?.folders.find((f) => f.role === "inbox");

/** The lists a scope shows: one folder, or the INBOX of every account that can be read. */
export function scopeSourcesOf(
  scope: Scope,
  accounts: readonly MailAccount[] | null,
  states: Readonly<Record<string, AccountState>>
): SourceRef[] {
  if (scope.kind === "folder") return [{ accountId: scope.accountId, folder: scope.path }];
  return (accounts ?? [])
    .filter((a) => states[a.id]?.health === "ok")
    .map((a) => ({ accountId: a.id, folder: inboxOf(states[a.id])?.path ?? "INBOX" }));
}

/** INBOX unread over the accounts that can be read (the unified inbox count). */
export function totalInboxUnread(
  accounts: readonly MailAccount[] | null,
  states: Readonly<Record<string, AccountState>>
): number {
  return (accounts ?? []).reduce(
    (n, a) => n + (states[a.id]?.health === "ok" ? (inboxOf(states[a.id])?.unread ?? 0) : 0),
    0
  );
}

/** Every row of the given lists, newest first. */
export function sortedRows(lists: readonly Source[]) {
  const all = lists.flatMap((s) => s.headers.map((h) => ({ h, accountId: s.accountId, folder: s.folder })));
  return all.sort((a, b) => (b.h.date ?? "").localeCompare(a.h.date ?? "") || b.h.uid - a.h.uid);
}

export function createMailListStore(deps: MailListStoreDeps) {
  const { api, live, clock, mirror } = deps;
  let snap: MailListSnapshot = { accounts: null, rev: 0, accountsError: null, states: {}, sources: {} };
  const listeners = new Set<() => void>();
  let disposed = false;

  const requested = new Set<string>();
  const folderSeq = new Map<string, number>();
  const sourceSeq = new Map<string, number>();
  const userSeq = new Map<string, number>();
  const userLoads = new Map<string, number>();
  const deferredSilent = new Set<string>();
  const liveTimers = new Map<string, unknown>();
  const liveRunning = new Set<string>();
  const liveAgain = new Set<string>();
  const detachers = new Set<() => void>();

  // What this page knows from its own folder fetches goes to the shared live picture, so the Shell badge
  // is the very number the folder tree shows (INBOX unread of accounts that can log in). It is told once per
  // burst of changes, after them (as the page's render used to): an in-between state of the same tick (a list
  // refused as auth, then the tree fetched fine) must not reach the live picture, where it would leave the
  // account's watch state behind.
  let reportQueued = false;
  const queueReport = () => {
    if (reportQueued) return;
    reportQueued = true;
    queueMicrotask(() => {
      reportQueued = false;
      if (!disposed) report();
    });
  };
  const report = () => {
    const { accounts, states } = snap;
    if (!accounts) return;
    live.report(
      accounts.map((a) => {
        const st = states[a.id];
        return {
          accountId: a.id,
          inbox: st?.health === "ok" ? (inboxOf(st)?.unread ?? 0) : null,
          blocked: st?.health === "auth",
        };
      })
    );
  };
  const commit = (next: MailListSnapshot) => {
    if (disposed || next === snap) return;
    const prev = snap;
    snap = next;
    if (prev.accounts !== next.accounts || prev.states !== next.states) queueReport();
    for (const l of [...listeners]) l();
  };
  const setStates = (fn: (s: MailListSnapshot["states"]) => MailListSnapshot["states"]) => {
    const states = fn(snap.states);
    if (states !== snap.states) commit({ ...snap, states });
  };
  const setSources = (fn: (s: MailListSnapshot["sources"]) => MailListSnapshot["sources"]) => {
    const sources = fn(snap.sources);
    if (sources !== snap.sources) commit({ ...snap, sources });
  };

  // ---- accounts and folders ------------------------------------------------
  const loadAccounts = async () => {
    if (disposed) return;
    try {
      const r = await api.fetchMailAccounts();
      if (disposed) return;
      commit({ ...snap, accounts: r.accounts, rev: r.rev, accountsError: null });
    } catch (e) {
      if (!disposed) commit({ ...snap, accountsError: mailErrorCode(e) });
    }
  };

  /**
   * `silent` is a reload that only wants the server's truth (a live push, or an unknown outcome after a
   * management action). It neither flips the account to "loading" (which would make its rows vanish from the
   * unified inbox) nor throws away what is shown when it fails (except a refused login, which is shown).
   * Resolves `ok: false` when the server could not be asked, and `folders: null` when it failed or was
   * superseded by a newer request (which then carries the truth).
   */
  const loadFolders = async (accountId: string, silent = false): Promise<{ ok: boolean; folders: MailFolder[] | null }> => {
    if (disposed) return { ok: true, folders: null };
    const seq = (folderSeq.get(accountId) ?? 0) + 1;
    folderSeq.set(accountId, seq);
    if (!silent)
      setStates((s) => ({
        ...s,
        [accountId]: { health: "loading", code: null, stale: false, folders: s[accountId]?.folders ?? [] },
      }));
    try {
      const r = await api.fetchMailFolders(accountId);
      // An older response must not overwrite the tree a newer request already produced.
      if (disposed || folderSeq.get(accountId) !== seq) return { ok: true, folders: null };
      setStates((s) => ({ ...s, [accountId]: { health: "ok", code: null, stale: r.stale, folders: r.folders } }));
      return { ok: true, folders: r.folders };
    } catch (e) {
      if (disposed || folderSeq.get(accountId) !== seq) return { ok: false, folders: null };
      const code = mailErrorCode(e);
      if (AUTH_CODES.has(code) || !silent)
        setStates((s) => ({
          ...s,
          [accountId]: { health: AUTH_CODES.has(code) ? "auth" : "offline", code, stale: false, folders: [] },
        }));
      return { ok: false, folders: null };
    }
  };

  /** Ask for the tree of every account not asked for yet (each account once, until `forgetRequested`). */
  const ensureFolders = () => {
    if (disposed) return;
    for (const a of snap.accounts ?? []) {
      const key = `folders\u0000${a.id}`;
      if (requested.has(key)) continue;
      requested.add(key);
      void loadFolders(a.id);
    }
  };

  // ---- message lists ---------------------------------------------------------
  // A silent reload that a user load (e.g. "load more") overtook was discarded: do it again once that load is done.
  const rerunSilent = (key: string, accountId: string, folder: string) => {
    if ((userLoads.get(key) ?? 0) > 0) deferredSilent.add(key);
    else void loadSource(accountId, folder, false, true);
  };
  /**
   * Every write back to `sources` is a functional update on the CURRENT entry. A `base` captured when the load
   * started would be the state of that moment, and writing it back after a failed reload would undo whatever
   * happened meanwhile (a rolled-back row, a rolled-back star).
   *
   * `silent` refreshes the newest page for the server's truth: no spinner, the older pages already loaded stay
   * (only within the same UIDVALIDITY epoch: UIDs of another epoch mean other messages), and what is shown
   * stays if it fails. Resolves false when the server could not be asked.
   */
  const loadSourceNow = async (accountId: string, folder: string, more: boolean, silent: boolean): Promise<boolean> => {
    const key = sourceKey(accountId, folder);
    const seq = (sourceSeq.get(key) ?? 0) + 1;
    sourceSeq.set(key, seq);
    if (!silent) userSeq.set(key, seq);
    const before = more ? (snap.sources[key]?.nextBefore ?? null) : null;
    const blank: Source = {
      accountId,
      folder,
      headers: [],
      uidValidity: null,
      nextBefore: null,
      loading: false,
      loadingMore: false,
      error: null,
      stale: false,
    };
    if (!silent)
      setSources((s) => {
        const cur = s[key] ?? blank;
        return { ...s, [key]: { ...cur, stale: false, loading: !more, loadingMore: more, error: null } };
      });
    // Superseded by a user load: redo once it is done. Superseded by another silent reload: that one carries the truth.
    const overtaken = () => {
      if (!disposed && (userSeq.get(key) ?? 0) > seq) rerunSilent(key, accountId, folder);
    };
    const dedupe = (list: MailHeader[]) => {
      const seen = new Set<number>();
      return list.filter((h) => !seen.has(h.uid) && seen.add(h.uid));
    };
    try {
      const r = await api.fetchMailHeaders(accountId, folder, { before, limit: PAGE });
      if (disposed || sourceSeq.get(key) !== seq) {
        if (silent) overtaken();
        return true;
      }
      const shown = snap.sources[key];
      if (more && shown && shown.uidValidity !== null && r.uidValidity !== shown.uidValidity) {
        // The cursor belongs to an older UIDVALIDITY epoch: start this folder over rather than mix UIDs.
        void loadSource(accountId, folder);
        return true;
      }
      setSources((s) => {
        const cur = s[key] ?? blank;
        const sameEpoch = cur.uidValidity === null || r.uidValidity === cur.uidValidity;
        let headers: MailHeader[];
        let nextBefore: number | null = r.nextBefore;
        if (more && sameEpoch) headers = dedupe([...cur.headers, ...r.headers]);
        else if (silent && sameEpoch && r.headers.length > 0) {
          // the fresh first page, plus the older pages that were already loaded below it
          const oldest = Math.min(...r.headers.map((h) => h.uid));
          const older = cur.headers.filter((h) => h.uid < oldest);
          headers = dedupe([...r.headers, ...older]);
          if (older.length > 0) nextBefore = cur.nextBefore;
        } else headers = dedupe(r.headers);
        return {
          ...s,
          [key]: {
            accountId,
            folder,
            headers,
            uidValidity: r.uidValidity,
            nextBefore,
            loading: false,
            loadingMore: false,
            error: null,
            stale: r.stale,
          },
        };
      });
      return true;
    } catch (e) {
      if (disposed || sourceSeq.get(key) !== seq) {
        if (silent) overtaken();
        return false;
      }
      const code = mailErrorCode(e);
      const auth = AUTH_CODES.has(code);
      if (auth) setStates((s) => ({ ...s, [accountId]: { health: "auth", code, stale: false, folders: [] } }));
      setSources((s) => {
        const cur = s[key] ?? blank;
        return { ...s, [key]: { ...cur, loading: false, loadingMore: false, error: silent && !auth ? cur.error : code } };
      });
      return false;
    }
  };
  // A silent reload never preempts a load the user asked for (it would discard that page): it waits for it.
  const loadSource = async (accountId: string, folder: string, more = false, silent = false): Promise<boolean> => {
    if (disposed) return true;
    const key = sourceKey(accountId, folder);
    if (silent && (userLoads.get(key) ?? 0) > 0) {
      deferredSilent.add(key);
      return true;
    }
    if (!silent) userLoads.set(key, (userLoads.get(key) ?? 0) + 1);
    try {
      return await loadSourceNow(accountId, folder, more, silent);
    } finally {
      if (!silent) {
        const left = (userLoads.get(key) ?? 1) - 1;
        userLoads.set(key, left);
        if (left === 0 && deferredSilent.delete(key)) void loadSource(accountId, folder, false, true);
      }
    }
  };

  /** Load each list the first time it is shown; a list visited before is not reloaded by showing it again. */
  const ensureLoaded = (lists: readonly SourceRef[]) => {
    if (disposed) return;
    for (const s of lists) {
      const key = `list\u0000${sourceKey(s.accountId, s.folder)}`;
      if (requested.has(key)) continue;
      requested.add(key);
      void loadSource(s.accountId, s.folder);
    }
  };

  /** The refresh button: every tree and the visible lists, with spinners. */
  const refreshAll = (visible: readonly SourceRef[]) => {
    for (const a of snap.accounts ?? []) void loadFolders(a.id);
    for (const s of visible) void loadSource(s.accountId, s.folder);
  };

  /**
   * The quiet reload for "something changed on the server" (the compose layer closed a window, a send ended):
   * the same path as a live push (ticket 08) and a management action (ticket 06). Nothing flips to "loading",
   * loaded older pages stay, a failure keeps what is shown, and an account whose login was refused is not
   * asked again (the explicit refresh button is the way back).
   */
  const reloadQuiet = (visible: readonly SourceRef[]) => {
    const { accounts, states } = snap;
    for (const a of accounts ?? []) {
      if (states[a.id]?.health === "auth") continue;
      void loadFolders(a.id, true);
    }
    for (const s of visible) {
      if (states[s.accountId]?.health === "auth") continue;
      void loadSource(s.accountId, s.folder, false, true);
    }
  };

  // ---- live updates (ticket 08) ------------------------------------------------
  // A burst of pushes (many arrivals, a read, an expunge) is one reload of the tree and the visible INBOX list,
  // and only one reload per account runs at a time: pushes during it cause exactly one more afterwards.
  const reloadLive = (accountId: string, getScope: () => Scope) => {
    if (liveRunning.has(accountId)) {
      liveAgain.add(accountId);
      return;
    }
    if (liveTimers.has(accountId)) return;
    liveTimers.set(
      accountId,
      clock.setTimeout(async () => {
        liveTimers.delete(accountId);
        if (disposed || !snap.accounts?.some((a) => a.id === accountId)) return;
        liveRunning.add(accountId);
        try {
          const { folders } = await loadFolders(accountId, true);
          if (!folders || disposed) return;
          const inbox = folders.find((f) => f.role === "inbox")?.path ?? "INBOX";
          const sc = getScope();
          const visible = sc.kind === "unified" || (sc.accountId === accountId && sc.path === inbox);
          if (visible) await loadSource(accountId, inbox, false, true);
        } finally {
          liveRunning.delete(accountId);
          if (liveAgain.delete(accountId) && !disposed) reloadLive(accountId, getScope);
        }
      }, LIVE_DEBOUNCE_MS)
    );
  };
  const onLive = (event: MailLiveEvent, getScope: () => Scope) => {
    if (disposed) return;
    if (event.kind === "resync") {
      // An account whose login was refused is not logged into again just because the socket reconnected.
      for (const a of snap.accounts ?? []) if (snap.states[a.id]?.health !== "auth") reloadLive(a.id, getScope);
    } else if (event.watch === "auth_failed" || event.watch === "credential_missing") {
      // The server says this account cannot log in: show it like a refused folder fetch (tree and unified list).
      setStates((s) =>
        s[event.accountId]?.health === "auth"
          ? s
          : { ...s, [event.accountId]: { health: "auth", code: event.watch === "auth_failed" ? "auth_failed" : "credential_missing", stale: false, folders: [] } }
      );
    } else {
      const refused = snap.states[event.accountId]?.health === "auth";
      const loggedIn = event.watch === "idle" || event.watch === "polling";
      // A push for an account shown as refused that is watched again means it works now: reload to show it.
      if (refused ? loggedIn : event.cause !== "state") reloadLive(event.accountId, getScope);
    }
  };
  const clearLiveTimers = () => {
    for (const timer of liveTimers.values()) clock.clearTimeout(timer);
    liveTimers.clear();
  };
  /** Follow the live pushes; `getScope` says what the page shows when a reload is due. */
  const attachLive = (getScope: () => Scope): (() => void) => {
    if (disposed) return () => {};
    const off = live.subscribe((e) => onLive(e, getScope));
    const detach = () => {
      if (!detachers.delete(detach)) return;
      off();
      clearLiveTimers();
    };
    detachers.add(detach);
    return detach;
  };

  // ---- optimistic changes (opening, managing, rolling back) ---------------------
  /** Flags on a row, in the folder list and in the search results alike. */
  const patch = (r: HeaderRef, p: HeaderPatch) => {
    const key = sourceKey(r.accountId, r.folder);
    setSources((s) => {
      const cur = s[key];
      if (!cur) return s;
      return { ...s, [key]: { ...cur, headers: cur.headers.map((h) => (h.uid === r.uid ? { ...h, ...p } : h)) } };
    });
    mirror?.patch(r, p);
  };
  /** Take a row out of the folder list and the search results; the returned function puts it back in place. */
  const remove = (r: HeaderRef): (() => void) => {
    const key = sourceKey(r.accountId, r.folder);
    const cur = snap.sources[key];
    const index = cur ? cur.headers.findIndex((h) => h.uid === r.uid) : -1;
    const header = cur?.headers[index];
    if (cur && header)
      setSources((s) => {
        const c = s[key];
        return c ? { ...s, [key]: { ...c, headers: c.headers.filter((h) => h.uid !== r.uid) } } : s;
      });
    const restoreSearch = mirror ? mirror.remove(r) : () => {};
    return () => {
      if (header)
        setSources((s) => {
          const c = s[key];
          if (!c || c.headers.some((h) => h.uid === r.uid)) return s;
          const headers = [...c.headers];
          headers.splice(Math.min(index, headers.length), 0, header);
          return { ...s, [key]: { ...c, headers } };
        });
      restoreSearch();
    };
  };
  /** Shift a folder's unread count in the tree (never below 0; a folder without a count stays without). */
  const bumpUnread = (accountId: string, folder: string, delta: number) =>
    setStates((s) => {
      const st = s[accountId];
      if (!st) return s;
      return {
        ...s,
        [accountId]: {
          ...st,
          folders: st.folders.map((f) =>
            f.path === folder && f.unread !== null ? { ...f, unread: Math.max(0, f.unread + delta) } : f
          ),
        },
      };
    });

  // ---- lookups ------------------------------------------------------------------
  const folder = (accountId: string, path: string): MailFolder | undefined =>
    snap.states[accountId]?.folders.find((f) => f.path === path);

  return {
    getSnapshot: (): MailListSnapshot => snap,
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    /** The row as the folder list shows it, else as the search results show it. */
    header: (r: HeaderRef): MailHeader | undefined =>
      snap.sources[sourceKey(r.accountId, r.folder)]?.headers.find((h) => h.uid === r.uid) ?? mirror?.find(r),
    /** The UIDVALIDITY of the folder list showing the row, else of the search results. */
    uidValidity: (r: HeaderRef): number | undefined =>
      snap.sources[sourceKey(r.accountId, r.folder)]?.uidValidity ?? mirror?.uidValidity(r) ?? undefined,
    /** The UIDVALIDITY of the loaded folder list only (opening a message never takes the search's). */
    listUidValidity: (r: HeaderRef): number | undefined =>
      snap.sources[sourceKey(r.accountId, r.folder)]?.uidValidity ?? undefined,
    folder,
    folderRole: (accountId: string, path: string): MailFolderRole | undefined => folder(accountId, path)?.role,
    inboxPath: (accountId: string): string => inboxOf(snap.states[accountId])?.path ?? "INBOX",
    trashFolder: (accountId: string): string | undefined =>
      snap.states[accountId]?.folders.find((f) => f.role === "trash")?.path,
    isLoaded: (accountId: string, folderPath: string): boolean => !!snap.sources[sourceKey(accountId, folderPath)],

    loadAccounts,
    loadFolders,
    loadSource,
    ensureFolders,
    ensureLoaded,
    refreshAll,
    reloadQuiet,
    /** An account edited in a dialog: the server's new account and rev. */
    accountSaved: (account: MailAccount, rev: number) => {
      commit({ ...snap, rev, accounts: (snap.accounts ?? []).map((x) => (x.id === account.id ? account : x)) });
    },
    /** Forget that this account's tree and lists were asked for (they are asked again when shown). */
    forgetRequested: (accountId: string) => {
      for (const key of [...requested]) if (key.includes(accountId)) requested.delete(key);
    },

    patch,
    remove,
    bumpUnread,

    attachLive,
    dispose: () => {
      for (const detach of [...detachers]) detach();
      clearLiveTimers();
      disposed = true;
      listeners.clear();
    },
  };
}
