import type { MailAccount, MailFolder, MailHeader } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MailApiError } from "../src/api/mail";
import type { MailLiveEvent } from "../src/mail/mailLive";
import { createMailListStore, type MailListStore, type MailListStoreDeps, type Scope } from "../src/mail/mail-list-store";

// ---- fakes ---------------------------------------------------------------------------
// Every api call waits until the test answers it, so the order of answers is in the test's hand.

interface Call {
  kind: "accounts" | "folders" | "headers";
  accountId?: string;
  folder?: string;
  before?: number | null;
  resolve(value: unknown): void;
  reject(e: unknown): void;
}

const A1 = "acc-aaaaaaaaaaaa";
const A2 = "acc-bbbbbbbbbbbb";
const acct = (id: string): MailAccount =>
  ({ id, displayName: id, address: `${id}@example.test`, credentialProtection: "keychain" }) as unknown as MailAccount;
const folder = (path: string, role: MailFolder["role"], unread: number | null = 0): MailFolder => ({
  path,
  name: path,
  role,
  depth: 0,
  selectable: true,
  unread,
  total: unread,
});
const header = (uid: number, extra: Partial<MailHeader> = {}): MailHeader => ({
  uid,
  date: `2026-10-01T10:00:${String(uid % 60).padStart(2, "0")}.000Z`,
  from: { name: `S${uid}`, address: `s${uid}@example.test` },
  to: [],
  subject: `Subject ${uid}`,
  unread: false,
  starred: false,
  hasAttachments: false,
  size: 1,
  ...extra,
});
const page = (uids: number[], opts: { uidValidity?: number; nextBefore?: number | null; stale?: boolean } = {}) => ({
  headers: uids.map((u) => header(u)),
  uidValidity: opts.uidValidity ?? 7,
  nextBefore: opts.nextBefore ?? null,
  stale: opts.stale ?? false,
});
const authError = () => new MailApiError("auth_failed", 502);
const offlineError = () => new MailApiError("imap_unreachable", 502);

let calls: Call[];
let liveHandlers: Set<(e: MailLiveEvent) => void>;
let reports: { accountId: string; inbox: number | null; blocked: boolean }[][];
let mirror: {
  patched: unknown[];
  removed: unknown[];
  restored: number;
  found: MailHeader | undefined;
  validity: number | undefined;
};
let store: MailListStore;

/** A hand-driven clock: `advance` fires every timer that is due, then lets the promises it started settle. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    pending: () => timers.size,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}
let clock: ReturnType<typeof fakeClock>;

const pending = (c: Omit<Call, "resolve" | "reject">) =>
  new Promise<never>((resolve, reject) => {
    calls.push({ ...c, resolve: resolve as (v: unknown) => void, reject });
  });

function deps(): MailListStoreDeps {
  return {
    api: {
      fetchMailAccounts: () => pending({ kind: "accounts" }),
      fetchMailFolders: (accountId: string) => pending({ kind: "folders", accountId }),
      fetchMailHeaders: (accountId: string, f: string, opts: { before?: number | null }) =>
        pending({ kind: "headers", accountId, folder: f, before: opts.before ?? null }),
    },
    live: {
      subscribe: (h) => {
        liveHandlers.add(h);
        return () => liveHandlers.delete(h);
      },
      report: (views) => reports.push([...views]),
    },
    clock,
    mirror: {
      patch: (ref, p) => mirror.patched.push({ ref, p }),
      remove: (ref) => {
        mirror.removed.push(ref);
        return () => mirror.restored++;
      },
      find: () => mirror.found,
      uidValidity: () => mirror.validity,
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const open = (kind: Call["kind"], accountId?: string, f?: string) =>
  calls.filter((c) => c.kind === kind && (!accountId || c.accountId === accountId) && (!f || c.folder === f));
const last = (kind: Call["kind"], accountId?: string, f?: string) => {
  const list = open(kind, accountId, f);
  const c = list[list.length - 1];
  if (!c) throw new Error(`no ${kind} call`);
  return c;
};
const answer = async (c: Call, value: unknown) => {
  calls.splice(calls.indexOf(c), 1);
  c.resolve(value);
  await flush();
};
const refuse = async (c: Call, e: unknown) => {
  calls.splice(calls.indexOf(c), 1);
  c.reject(e);
  await flush();
};
const snap = () => store.getSnapshot();
const src = (accountId: string, f: string) => snap().sources[`${accountId}\u0000${f}`];
const uids = (accountId: string, f: string) => src(accountId, f)?.headers.map((h) => h.uid);

/** Two accounts with their folder trees loaded. */
async function withAccounts(trees: Record<string, MailFolder[]> = {
  [A1]: [folder("INBOX", "inbox", 2), folder("Trash", "trash", null), folder("Work", "custom", 1)],
  [A2]: [folder("INBOX", "inbox", 1)],
}) {
  void store.loadAccounts();
  await answer(last("accounts"), { rev: 3, accounts: Object.keys(trees).map(acct) });
  store.ensureFolders();
  for (const [id, folders] of Object.entries(trees)) await answer(last("folders", id), { folders, stale: false });
}

beforeEach(() => {
  calls = [];
  liveHandlers = new Set();
  reports = [];
  mirror = { patched: [], removed: [], restored: 0, found: undefined, validity: undefined };
  clock = fakeClock();
  store = createMailListStore(deps());
});
afterEach(() => {
  store.dispose();
});

// ---- accounts and folders -------------------------------------------------------------------

describe("accounts and folder trees", () => {
  test("loadAccounts fills accounts and rev; a failure records the code", async () => {
    void store.loadAccounts();
    await refuse(last("accounts"), offlineError());
    expect(snap().accountsError).toBe("imap_unreachable");
    void store.loadAccounts();
    await answer(last("accounts"), { rev: 4, accounts: [acct(A1)] });
    expect(snap()).toMatchObject({ rev: 4, accountsError: null });
    expect(snap().accounts?.map((a) => a.id)).toEqual([A1]);
  });

  test("ensureFolders asks for each account's tree once", async () => {
    void store.loadAccounts();
    await answer(last("accounts"), { rev: 1, accounts: [acct(A1), acct(A2)] });
    store.ensureFolders();
    store.ensureFolders();
    expect(open("folders").map((c) => c.accountId)).toEqual([A1, A2]);
  });

  test("a non-silent load shows loading but keeps the old folders; an older answer never overwrites a newer one", async () => {
    await withAccounts();
    void store.loadFolders(A1);
    expect(snap().states[A1]).toMatchObject({ health: "loading" });
    expect(snap().states[A1]?.folders.map((f) => f.path)).toEqual(["INBOX", "Trash", "Work"]);
    const older = last("folders", A1);
    const second = store.loadFolders(A1, true);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 9)], stale: true });
    expect(await second).toEqual({ ok: true, folders: [folder("INBOX", "inbox", 9)] });
    const late = store.loadFolders(A1); // a third so the first one's answer is two behind
    void late;
    const third = last("folders", A1);
    await answer(older, { folders: [folder("OLD", "inbox")], stale: false });
    await answer(third, { folders: [folder("INBOX", "inbox", 4)], stale: false });
    expect(snap().states[A1]).toMatchObject({ health: "ok", stale: false });
    expect(snap().states[A1]?.folders[0]?.unread).toBe(4);
  });

  test("a superseded answer resolves folders:null (ok) and a superseded failure ok:false", async () => {
    await withAccounts();
    const first = store.loadFolders(A1, true);
    const c1 = last("folders", A1);
    const second = store.loadFolders(A1, true);
    await answer(c1, { folders: [folder("X", "inbox")], stale: false });
    expect(await first).toEqual({ ok: true, folders: null });
    const c2 = last("folders", A1);
    const third = store.loadFolders(A1, true);
    await refuse(c2, offlineError());
    expect(await second).toEqual({ ok: false, folders: null });
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox")], stale: false });
    await third;
  });

  test("failures: auth empties the tree; a non-silent failure is offline; a silent non-auth failure keeps what is shown", async () => {
    await withAccounts();
    const quiet = store.loadFolders(A1, true);
    await refuse(last("folders", A1), offlineError());
    expect(await quiet).toEqual({ ok: false, folders: null });
    expect(snap().states[A1]).toMatchObject({ health: "ok" });
    expect(snap().states[A1]?.folders).toHaveLength(3);

    void store.loadFolders(A1);
    await refuse(last("folders", A1), offlineError());
    expect(snap().states[A1]).toEqual({ health: "offline", code: "imap_unreachable", stale: false, folders: [] });

    void store.loadFolders(A2, true);
    await refuse(last("folders", A2), authError());
    expect(snap().states[A2]).toEqual({ health: "auth", code: "auth_failed", stale: false, folders: [] });
  });

  test("lookups over the tree: folder, inboxPath, folderRole, trashFolder", async () => {
    await withAccounts({ [A1]: [folder("Posteingang", "inbox"), folder("Papierkorb", "trash")] });
    expect(store.inboxPath(A1)).toBe("Posteingang");
    expect(store.inboxPath(A2)).toBe("INBOX");
    expect(store.folder(A1, "Papierkorb")?.role).toBe("trash");
    expect(store.folderRole(A1, "Papierkorb")).toBe("trash");
    expect(store.folderRole(A1, "Nope")).toBeUndefined();
    expect(store.trashFolder(A1)).toBe("Papierkorb");
    expect(store.trashFolder(A2)).toBeUndefined();
  });

  test("accountSaved replaces the account and rev; forgetRequested lets the tree and lists be asked again", async () => {
    await withAccounts();
    store.ensureLoaded([{ accountId: A1, folder: "INBOX" }]);
    await answer(last("headers", A1, "INBOX"), page([1]));
    store.accountSaved({ ...acct(A1), displayName: "Renamed" }, 9);
    expect(snap().rev).toBe(9);
    expect(snap().accounts?.find((a) => a.id === A1)?.displayName).toBe("Renamed");
    store.forgetRequested(A1);
    store.ensureFolders();
    store.ensureLoaded([{ accountId: A1, folder: "INBOX" }]);
    expect(open("folders", A1)).toHaveLength(1);
    expect(open("headers", A1, "INBOX")).toHaveLength(1);
  });
});

// ---- message lists ------------------------------------------------------------------------------

describe("message lists", () => {
  test("ensureLoaded loads each source once; visiting it again does not reload", async () => {
    await withAccounts();
    store.ensureLoaded([{ accountId: A1, folder: "INBOX" }]);
    store.ensureLoaded([{ accountId: A1, folder: "INBOX" }, { accountId: A2, folder: "INBOX" }]);
    expect(open("headers").map((c) => c.accountId)).toEqual([A1, A2]);
    await answer(last("headers", A1), page([1]));
    store.ensureLoaded([{ accountId: A1, folder: "INBOX" }]);
    expect(open("headers", A1)).toHaveLength(0);
    expect(store.isLoaded(A1, "INBOX")).toBe(true);
    expect(store.isLoaded(A1, "Work")).toBe(false);
  });

  test("a user load shows loading; its answer replaces the list (deduplicated)", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    expect(src(A1, "INBOX")).toMatchObject({ loading: true, headers: [] });
    await answer(last("headers"), { ...page([5, 4, 4, 3], { nextBefore: 3 }) });
    expect(src(A1, "INBOX")).toMatchObject({ loading: false, nextBefore: 3, uidValidity: 7, error: null });
    expect(uids(A1, "INBOX")).toEqual([5, 4, 3]);
  });

  test("more in the same epoch appends after the cursor and drops duplicates", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5, 4], { nextBefore: 4 }));
    void store.loadSource(A1, "INBOX", true);
    expect(src(A1, "INBOX")).toMatchObject({ loadingMore: true, loading: false });
    expect(last("headers").before).toBe(4);
    await answer(last("headers"), page([4, 3, 2], { nextBefore: 2 }));
    expect(uids(A1, "INBOX")).toEqual([5, 4, 3, 2]);
    expect(src(A1, "INBOX")?.nextBefore).toBe(2);
  });

  test("more across an epoch change drops that page and starts the folder over (not silently)", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5, 4], { nextBefore: 4 }));
    void store.loadSource(A1, "INBOX", true);
    await answer(last("headers"), page([30, 29], { uidValidity: 8 }));
    expect(uids(A1, "INBOX")).toEqual([5, 4]);
    const restart = last("headers");
    expect(restart.before).toBeNull();
    expect(src(A1, "INBOX")?.loading).toBe(true);
    await answer(restart, page([31, 30], { uidValidity: 8 }));
    expect(uids(A1, "INBOX")).toEqual([31, 30]);
  });

  test("silent with new data: fresh first page plus the older pages below it, nextBefore kept", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([10, 9], { nextBefore: 9 }));
    void store.loadSource(A1, "INBOX", true);
    await answer(last("headers"), page([8, 7], { nextBefore: 7 }));
    void store.loadSource(A1, "INBOX", false, true);
    expect(src(A1, "INBOX")?.loading).toBe(false); // no spinner
    await answer(last("headers"), page([11, 10, 9], { nextBefore: 9 }));
    expect(uids(A1, "INBOX")).toEqual([11, 10, 9, 8, 7]);
    expect(src(A1, "INBOX")?.nextBefore).toBe(7);
  });

  test("silent with nothing older below the fresh page takes the fresh cursor", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([10, 9], { nextBefore: 9 }));
    void store.loadSource(A1, "INBOX", false, true);
    await answer(last("headers"), page([12, 11, 10, 9], { nextBefore: 3 }));
    expect(uids(A1, "INBOX")).toEqual([12, 11, 10, 9]);
    expect(src(A1, "INBOX")?.nextBefore).toBe(3);
  });

  test("silent with an empty page or another epoch replaces the list", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([10, 9], { nextBefore: 9 }));
    void store.loadSource(A1, "INBOX", false, true);
    await answer(last("headers"), page([], { nextBefore: null }));
    expect(uids(A1, "INBOX")).toEqual([]);
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([10, 9], { nextBefore: 9 }));
    void store.loadSource(A1, "INBOX", false, true);
    await answer(last("headers"), page([3, 2], { uidValidity: 99, nextBefore: null }));
    expect(uids(A1, "INBOX")).toEqual([3, 2]);
    expect(src(A1, "INBOX")).toMatchObject({ uidValidity: 99, nextBefore: null });
  });

  test("a failed reload updates the CURRENT entry: a star changed meanwhile is not undone", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([2, 1]));
    void store.loadSource(A1, "INBOX");
    store.patch({ accountId: A1, folder: "INBOX", uid: 2 }, { starred: true });
    await refuse(last("headers"), offlineError());
    expect(src(A1, "INBOX")?.headers[0]?.starred).toBe(true);
    expect(src(A1, "INBOX")).toMatchObject({ loading: false, error: "imap_unreachable" });
  });

  test("a silent non-auth failure keeps the error as it was; an auth failure is shown and marks the account auth", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([2, 1]));
    void store.loadSource(A1, "INBOX", false, true);
    await refuse(last("headers"), offlineError());
    expect(src(A1, "INBOX")?.error).toBeNull();
    expect(uids(A1, "INBOX")).toEqual([2, 1]);
    void store.loadSource(A1, "INBOX", false, true);
    await refuse(last("headers"), authError());
    expect(src(A1, "INBOX")?.error).toBe("auth_failed");
    expect(snap().states[A1]).toEqual({ health: "auth", code: "auth_failed", stale: false, folders: [] });
  });

  test("resolves false when the server could not be asked", async () => {
    await withAccounts();
    const r = store.loadSource(A1, "INBOX");
    await refuse(last("headers"), offlineError());
    expect(await r).toBe(false);
    const ok = store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([1]));
    expect(await ok).toBe(true);
  });
});

// ---- concurrency -----------------------------------------------------------------------------------

describe("silent reloads and user loads", () => {
  test("a silent reload waits for a user load in flight and runs once it is done", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5, 4], { nextBefore: 4 }));
    void store.loadSource(A1, "INBOX", true);
    void store.loadSource(A1, "INBOX", false, true);
    void store.loadSource(A1, "INBOX", false, true);
    expect(open("headers")).toHaveLength(1); // not preempted
    await answer(last("headers"), page([4, 3], { nextBefore: 3 }));
    expect(uids(A1, "INBOX")).toEqual([5, 4, 3]);
    const deferred = open("headers");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.before).toBeNull();
    await answer(last("headers"), page([6, 5, 4], { nextBefore: 4 }));
    expect(uids(A1, "INBOX")).toEqual([6, 5, 4, 3]);
    expect(open("headers")).toHaveLength(0);
  });

  test("a silent reload overtaken by a user load is run again once that load is done", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5, 4], { nextBefore: 4 }));
    void store.loadSource(A1, "INBOX", false, true);
    const silent = last("headers");
    void store.loadSource(A1, "INBOX", true);
    const more = last("headers");
    await answer(silent, page([9, 5, 4])); // superseded: discarded
    expect(uids(A1, "INBOX")).toEqual([5, 4]);
    expect(open("headers")).toHaveLength(1); // deferred until the user load ends
    await answer(more, page([3], { nextBefore: null }));
    expect(uids(A1, "INBOX")).toEqual([5, 4, 3]);
    const rerun = last("headers");
    expect(rerun.before).toBeNull();
    await answer(rerun, page([9, 5, 4], { nextBefore: 4 }));
    expect(uids(A1, "INBOX")).toEqual([9, 5, 4, 3]);
  });

  test("an overtaken silent reload whose user load already ended runs again at once", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5]));
    void store.loadSource(A1, "INBOX", false, true);
    const silent = last("headers");
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([6, 5]));
    await refuse(silent, offlineError());
    expect(open("headers")).toHaveLength(1);
    expect(src(A1, "INBOX")?.error).toBeNull();
  });

  test("a silent reload overtaken by another silent reload is abandoned (that one carries the truth)", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([5]));
    void store.loadSource(A1, "INBOX", false, true);
    const first = last("headers");
    void store.loadSource(A1, "INBOX", false, true);
    const second = last("headers");
    await answer(second, page([7, 6, 5]));
    await answer(first, page([6, 5]));
    expect(uids(A1, "INBOX")).toEqual([7, 6, 5]);
    expect(open("headers")).toHaveLength(0);
  });
});

// ---- whole-page reloads ---------------------------------------------------------------------------

describe("refreshAll and reloadQuiet", () => {
  test("refreshAll reloads every tree and the visible lists with spinners", async () => {
    await withAccounts();
    store.refreshAll([{ accountId: A1, folder: "INBOX" }]);
    expect(open("folders").map((c) => c.accountId)).toEqual([A1, A2]);
    expect(snap().states[A1]?.health).toBe("loading");
    expect(open("headers").map((c) => c.accountId)).toEqual([A1]);
  });

  test("reloadQuiet skips accounts whose login was refused and shows no spinner", async () => {
    await withAccounts();
    void store.loadFolders(A2);
    await refuse(last("folders", A2), authError());
    store.reloadQuiet([
      { accountId: A1, folder: "INBOX" },
      { accountId: A2, folder: "INBOX" },
    ]);
    expect(open("folders").map((c) => c.accountId)).toEqual([A1]);
    expect(open("headers").map((c) => c.accountId)).toEqual([A1]);
    expect(snap().states[A1]?.health).toBe("ok");
  });
});

// ---- the live picture -------------------------------------------------------------------------------

describe("report to the live picture", () => {
  test("inbox only for a healthy account; blocked for a refused one; told on every change", async () => {
    void store.loadAccounts();
    await answer(last("accounts"), { rev: 1, accounts: [acct(A1), acct(A2)] });
    expect(reports[reports.length - 1]).toEqual([
      { accountId: A1, inbox: null, blocked: false },
      { accountId: A2, inbox: null, blocked: false },
    ]);
    store.ensureFolders();
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 4)], stale: false });
    await refuse(last("folders", A2), authError());
    expect(reports[reports.length - 1]).toEqual([
      { accountId: A1, inbox: 4, blocked: false },
      { accountId: A2, inbox: null, blocked: true },
    ]);
    store.bumpUnread(A1, "INBOX", -1);
    await flush();
    expect(reports[reports.length - 1]?.[0]?.inbox).toBe(3);
  });

  test("changes in one tick are told once, after them, with the final state (no in-between state reaches it)", async () => {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([1]));
    const told = reports.length;
    // a list refused as auth, then in the same tick the tree written back as fine
    void store.loadSource(A1, "INBOX", false, true);
    const list = last("headers");
    void store.loadFolders(A1, true);
    const tree = last("folders", A1);
    calls.splice(calls.indexOf(list), 1);
    calls.splice(calls.indexOf(tree), 1);
    list.reject(authError());
    tree.resolve({ folders: [folder("INBOX", "inbox", 5)], stale: false });
    expect(reports.length).toBe(told);
    await flush();
    expect(snap().states[A1]?.health).toBe("ok");
    expect(reports.length).toBe(told + 1);
    expect(reports[reports.length - 1]?.[0]).toEqual({ accountId: A1, inbox: 5, blocked: false });
    // two synchronous changes: one report, after both
    store.bumpUnread(A1, "INBOX", -1);
    store.bumpUnread(A1, "INBOX", -1);
    expect(reports.length).toBe(told + 1);
    await flush();
    expect(reports.length).toBe(told + 2);
    expect(reports[reports.length - 1]?.[0]).toEqual({ accountId: A1, inbox: 3, blocked: false });
  });

  test("an inbox without a count reports 0, an account still loading reports null", async () => {
    await withAccounts({ [A1]: [folder("INBOX", "inbox", null)] });
    expect(reports[reports.length - 1]).toEqual([{ accountId: A1, inbox: 0, blocked: false }]);
    void store.loadFolders(A1);
    await flush();
    expect(reports[reports.length - 1]).toEqual([{ accountId: A1, inbox: null, blocked: false }]);
  });
});

describe("live reloads", () => {
  const unified: Scope = { kind: "unified" };
  let scope: Scope;
  const push = (e: MailLiveEvent) => {
    for (const h of [...liveHandlers]) h(e);
  };
  const changed = (accountId: string, watch = "idle", cause = "inbox") =>
    push({ kind: "changed", accountId, watch, cause } as MailLiveEvent);

  beforeEach(() => {
    scope = unified;
  });

  async function attached() {
    await withAccounts();
    store.ensureLoaded([
      { accountId: A1, folder: "INBOX" },
      { accountId: A2, folder: "INBOX" },
    ]);
    await answer(last("headers", A1), page([2, 1]));
    await answer(last("headers", A2), page([5]));
    return store.attachLive(() => scope);
  }

  test("a burst of pushes is one reload of the tree and the visible INBOX, 250ms later", async () => {
    await attached();
    changed(A1);
    changed(A1);
    await clock.advance(249);
    expect(open("folders")).toHaveLength(0);
    await clock.advance(1);
    expect(open("folders").map((c) => c.accountId)).toEqual([A1]);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    const list = last("headers", A1, "INBOX");
    await answer(list, page([3, 2, 1]));
    expect(uids(A1, "INBOX")).toEqual([3, 2, 1]);
    expect(snap().states[A1]?.folders[0]?.unread).toBe(3);
    expect(snap().states[A1]?.health).toBe("ok"); // silent: never flipped to loading
  });

  test("pushes during a running reload cause exactly one more afterwards", async () => {
    await attached();
    changed(A1);
    await clock.advance(250);
    changed(A1);
    changed(A1);
    await clock.advance(1000);
    expect(open("folders", A1)).toHaveLength(1);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    await answer(last("headers", A1), page([3, 2, 1]));
    expect(open("folders", A1)).toHaveLength(0);
    await clock.advance(250);
    expect(open("folders", A1)).toHaveLength(1);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    await answer(last("headers", A1), page([3, 2, 1]));
    await clock.advance(1000);
    expect(open("folders", A1)).toHaveLength(0);
  });

  test("a timer for an account that is gone does nothing", async () => {
    await attached();
    changed("acc-zzzzzzzzzzzz");
    await clock.advance(250);
    expect(open("folders")).toHaveLength(0);
  });

  test("a tree answer that was superseded (folders:null) stops there: no list reload", async () => {
    await attached();
    changed(A1);
    await clock.advance(250);
    const live = last("folders", A1);
    void store.loadFolders(A1); // newer request
    await answer(live, { folders: [folder("INBOX", "inbox", 3)], stale: false });
    expect(open("headers")).toHaveLength(0);
  });

  test("the list is reloaded only in the unified inbox or when exactly that account's INBOX is shown", async () => {
    await attached();
    scope = { kind: "folder", accountId: A1, path: "Work" };
    changed(A1);
    await clock.advance(250);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    expect(open("headers")).toHaveLength(0);
    scope = { kind: "folder", accountId: A2, path: "INBOX" };
    changed(A1);
    await clock.advance(250);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    expect(open("headers")).toHaveLength(0);
    scope = { kind: "folder", accountId: A1, path: "INBOX" };
    changed(A1);
    await clock.advance(250);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    expect(open("headers").map((c) => `${c.accountId}:${c.folder}`)).toEqual([`${A1}:INBOX`]);
  });

  test("resync reloads every account except refused ones", async () => {
    await attached();
    void store.loadFolders(A2);
    await refuse(last("folders", A2), authError());
    push({ kind: "resync" });
    await clock.advance(250);
    expect(open("folders").map((c) => c.accountId)).toEqual([A1]);
  });

  test("a changed push saying the login fails marks the account refused without asking the server", async () => {
    await attached();
    changed(A1, "credential_missing");
    expect(snap().states[A1]).toEqual({ health: "auth", code: "credential_missing", stale: false, folders: [] });
    const before = snap();
    changed(A1, "auth_failed"); // already refused: left as it is
    expect(snap()).toBe(before);
    changed(A2, "auth_failed");
    expect(snap().states[A2]?.code).toBe("auth_failed");
    await clock.advance(1000);
    expect(open("folders")).toHaveLength(0);
  });

  test("a refused account is reloaded only when it is watched again (idle/polling); a state-only push never reloads", async () => {
    await attached();
    changed(A1, "auth_failed");
    changed(A1, "connecting", "state");
    changed(A1, "connecting", "inbox");
    await clock.advance(250);
    expect(open("folders")).toHaveLength(0);
    changed(A1, "polling", "state");
    await clock.advance(250);
    expect(open("folders", A1)).toHaveLength(1);
    await answer(last("folders", A1), { folders: [folder("INBOX", "inbox", 3)], stale: false });
    await answer(last("headers", A1), page([2, 1]));
    changed(A2, "idle", "state");
    await clock.advance(250);
    expect(open("folders", A2)).toHaveLength(0);
  });

  test("detaching stops listening", async () => {
    const detach = await attached();
    detach();
    changed(A1);
    await clock.advance(250);
    expect(open("folders")).toHaveLength(0);
    expect(liveHandlers.size).toBe(0);
  });
});

// ---- optimistic reducers ----------------------------------------------------------------------------

describe("optimistic changes", () => {
  const r = (uid: number) => ({ accountId: A1, folder: "INBOX", uid });
  async function loaded() {
    await withAccounts();
    void store.loadSource(A1, "INBOX");
    await answer(last("headers"), page([4, 3, 2, 1]));
  }

  test("patch changes the row and forwards to the search results; an unknown list is a no-op", async () => {
    await loaded();
    store.patch(r(3), { unread: true, starred: true });
    expect(src(A1, "INBOX")?.headers.find((h) => h.uid === 3)).toMatchObject({ unread: true, starred: true });
    expect(mirror.patched).toEqual([{ ref: r(3), p: { unread: true, starred: true } }]);
    const before = snap();
    store.patch({ accountId: A1, folder: "Nowhere", uid: 3 }, { starred: true });
    expect(snap()).toBe(before);
    expect(mirror.patched).toHaveLength(2); // the search results may still show it
  });

  test("remove takes the row out; the revert puts it back at its place, once, and restores the search row", async () => {
    await loaded();
    const revert = store.remove(r(3));
    expect(uids(A1, "INBOX")).toEqual([4, 2, 1]);
    expect(mirror.removed).toEqual([r(3)]);
    revert();
    expect(uids(A1, "INBOX")).toEqual([4, 3, 2, 1]);
    expect(mirror.restored).toBe(1);
    revert(); // already back (e.g. a reload brought it): not inserted twice
    expect(uids(A1, "INBOX")).toEqual([4, 3, 2, 1]);
  });

  test("the revert clamps to the current length when rows went away meanwhile", async () => {
    await loaded();
    const revert = store.remove(r(1));
    store.remove(r(4));
    store.remove(r(3));
    revert();
    expect(uids(A1, "INBOX")).toEqual([2, 1]);
  });

  test("removing a row not in the list still removes it from the search results", async () => {
    await loaded();
    const before = snap();
    const revert = store.remove(r(99));
    expect(snap()).toBe(before);
    revert();
    expect(snap()).toBe(before);
    expect(mirror.removed).toEqual([r(99)]);
    expect(mirror.restored).toBe(1);
  });

  test("bumpUnread floors at 0 and skips folders without a count", async () => {
    await withAccounts({ [A1]: [folder("INBOX", "inbox", 1), folder("Trash", "trash", null)] });
    store.bumpUnread(A1, "INBOX", -5);
    expect(store.folder(A1, "INBOX")?.unread).toBe(0);
    store.bumpUnread(A1, "INBOX", 2);
    expect(store.folder(A1, "INBOX")?.unread).toBe(2);
    store.bumpUnread(A1, "Trash", 1);
    expect(store.folder(A1, "Trash")?.unread).toBeNull();
    const before = snap();
    store.bumpUnread("acc-zzzzzzzzzzzz", "INBOX", 1);
    expect(snap()).toBe(before);
  });

  test("header and uidValidity look in the list first, then in the search results; listUidValidity does not", async () => {
    await loaded();
    expect(store.header(r(3))?.uid).toBe(3);
    expect(store.uidValidity(r(3))).toBe(7);
    mirror.found = header(50);
    mirror.validity = 12;
    const other = { accountId: A1, folder: "Archive", uid: 50 };
    expect(store.header(other)?.uid).toBe(50);
    expect(store.uidValidity(other)).toBe(12);
    expect(store.listUidValidity(other)).toBeUndefined();
    expect(store.listUidValidity(r(3))).toBe(7);
  });

  test("subscribers hear every change; getSnapshot is stable between changes", async () => {
    const heard = vi.fn();
    const off = store.subscribe(heard);
    await loaded();
    const n = heard.mock.calls.length;
    expect(n).toBeGreaterThan(0);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.patch(r(3), { starred: true });
    expect(heard).toHaveBeenCalledTimes(n + 1);
    off();
    store.patch(r(3), { starred: false });
    expect(heard).toHaveBeenCalledTimes(n + 1);
  });
});

// ---- dispose ---------------------------------------------------------------------------------------------

describe("dispose", () => {
  test("stops everything: answers in flight, pending live timers, the live subscription, further loads", async () => {
    await withAccounts();
    store.attachLive(() => ({ kind: "unified" }));
    void store.loadSource(A1, "INBOX");
    const list = last("headers");
    for (const h of [...liveHandlers]) h({ kind: "changed", accountId: A1, watch: "idle", cause: "inbox" } as MailLiveEvent);
    const heard = vi.fn();
    store.subscribe(heard);
    const reported = reports.length;
    store.dispose();
    expect(liveHandlers.size).toBe(0);
    await answer(list, page([1]));
    await clock.advance(1000);
    expect(open("folders")).toHaveLength(0);
    void store.loadAccounts();
    void store.loadFolders(A1);
    void store.loadSource(A1, "Work");
    store.ensureFolders();
    store.patch({ accountId: A1, folder: "INBOX", uid: 1 }, { starred: true });
    expect(calls).toHaveLength(0);
    expect(heard).not.toHaveBeenCalled();
    expect(reports.length).toBe(reported);
  });
});
