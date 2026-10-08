import {
  type MailUnreadAccount,
  type MailWatchState,
  mailUnreadTotal,
  type WsMailChanged,
} from "@argelanderspace/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { fetchMailUnread } from "../api/mail-live";
import { onMailChanged } from "../api/ws";

/**
 * Live Mail state shared by the Shell badge and the Mail page (ticket 08).
 *
 * The server pushes `mail.changed` (INBOX counts and watch state per account) and answers
 * `GET /api/mail/unread` for a full picture. This module keeps ONE copy of that picture for the
 * whole page: the badge number is derived from it, and the Mail page reports what its own, fresh
 * folder fetches say about INBOX so the two cannot disagree. Counts are hints; the remote mailbox
 * stays the authority. Nothing here is persisted.
 */

interface Entry {
  unread: number | null;
  watch: MailWatchState;
}
export interface MailLiveSnapshot {
  accounts: Readonly<Record<string, Entry>>;
  /** The sidebar badge: INBOX unread over accounts that can log in. */
  total: number;
}
/** What the Mail page is told: a change on one account, or "reconnected, everything may have changed". */
export type MailLiveEvent =
  | { kind: "changed"; accountId: string; cause: WsMailChanged["cause"]; watch: MailWatchState }
  | { kind: "resync" };

const EMPTY: MailLiveSnapshot = { accounts: {}, total: 0 };
let snapshot: MailLiveSnapshot = EMPTY;
const storeListeners = new Set<() => void>();
const eventListeners = new Set<(event: MailLiveEvent) => void>();
let users = 0;
let stop: (() => void) | null = null;
let seq = 0;
/** The first server picture is still on its way (a hello during it only repeats that fetch). */
let initialPending = false;
/** Accounts a push touched since the latest resync began: that newer word beats the fetched summary. */
let pushed = new Set<string>();

function publish(accounts: Record<string, Entry>): void {
  const list: MailUnreadAccount[] = Object.entries(accounts).map(([accountId, e]) => ({
    accountId,
    unread: e.unread,
    watch: e.watch,
  }));
  snapshot = { accounts, total: mailUnreadTotal(list) };
  for (const l of storeListeners) l();
}

async function resync(): Promise<void> {
  const mine = ++seq;
  pushed = new Set();
  try {
    const summary = await fetchMailUnread();
    if (mine !== seq) return; // a newer fetch superseded this one
    const next: Record<string, Entry> = Object.fromEntries(
      summary.accounts.map((a) => [a.accountId, { unread: a.unread, watch: a.watch }])
    );
    // Merge: a push that arrived while this fetch was in flight only overrides the account it names.
    for (const id of pushed) {
      const fresh = snapshot.accounts[id];
      if (fresh) next[id] = fresh;
    }
    publish(next);
  } catch {
    /* no server picture yet: the badge simply stays as it was */
  } finally {
    if (mine === seq) initialPending = false;
  }
}

function onPush(msg: WsMailChanged): void {
  pushed.add(msg.accountId);
  const prev = snapshot.accounts[msg.accountId];
  publish({ ...snapshot.accounts, [msg.accountId]: { unread: msg.unread ?? prev?.unread ?? null, watch: msg.watch } });
  for (const l of eventListeners) l({ kind: "changed", accountId: msg.accountId, cause: msg.cause, watch: msg.watch });
}

function begin(): void {
  initialPending = true;
  void resync();
  const onVisible = () => {
    if (document.visibilityState === "visible") void resync();
  };
  document.addEventListener("visibilitychange", onVisible);
  let off: (() => void) | null = null;
  try {
    off = onMailChanged(onPush, () => {
      // A hello is a (re)connect: refetch the picture. While the first fetch is still on its way the
      // Mail page has nothing stale yet, so only later ones tell it to reload.
      const first = initialPending;
      void resync();
      if (!first) for (const l of eventListeners) l({ kind: "resync" });
    });
  } catch {
    /* no live channel: the picture is refetched on focus and when the Mail page reports */
  }
  stop = () => {
    document.removeEventListener("visibilitychange", onVisible);
    off?.();
  };
}

function retain(): () => void {
  if (users++ === 0) begin();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      stop?.();
      stop = null;
      seq++;
    }
  };
}

const subscribeStore = (cb: () => void) => {
  storeListeners.add(cb);
  const release = retain();
  return () => {
    storeListeners.delete(cb);
    release();
  };
};
const getSnapshot = () => snapshot;

/** The live picture (and the badge number) for whoever renders it; keeps the live channel open while mounted. */
export function useMailLive(): MailLiveSnapshot {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** Be told about pushes and reconnects (the Mail page reloads its folder tree and visible list). */
export function useMailLiveEvents(handler: (event: MailLiveEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l = (e: MailLiveEvent) => ref.current(e);
    eventListeners.add(l);
    const release = retain();
    return () => {
      eventListeners.delete(l);
      release();
    };
  }, []);
}

/**
 * The Mail page's own fresh view of the accounts, so the badge matches the folder tree exactly:
 * `inbox` is INBOX unread from a folder fetch that just succeeded (null = not known), `blocked`
 * marks accounts the server refused to log in (they do not count), and accounts that no longer
 * exist are dropped.
 */
export function reportMailAccounts(
  views: readonly { accountId: string; inbox: number | null; blocked: boolean }[]
): void {
  const next: Record<string, Entry> = {};
  let changed = views.length !== Object.keys(snapshot.accounts).length;
  for (const v of views) {
    const prev = snapshot.accounts[v.accountId];
    const unread = v.inbox ?? prev?.unread ?? null;
    const watch: MailWatchState = v.blocked
      ? "auth_failed"
      : prev && (prev.watch === "auth_failed" || prev.watch === "credential_missing")
        ? "connecting" // it logs in again: the server's next push says how
        : (prev?.watch ?? "connecting");
    next[v.accountId] = { unread, watch };
    if (!prev || prev.unread !== unread || prev.watch !== watch) changed = true;
  }
  if (changed) publish(next);
}

/** Test seam: forget everything (module state outlives a test file's renders). */
export function resetMailLive(): void {
  snapshot = EMPTY;
  seq++;
  initialPending = false;
  pushed = new Set();
}
