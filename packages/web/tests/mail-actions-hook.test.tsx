// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MailFolder, MailHeader } from "@argelanderspace/contracts";
import i18n from "../src/i18n";
import { createMailListStore, type MailListStore } from "../src/mail/mail-list-store";
import { useMailActions } from "../src/mail/useMailActions";

const A = "acc-aaaaaaaaaaaa";
const ref = { accountId: A, folder: "Trash", uid: 9 };
const header = (uid: number, extra: Partial<MailHeader> = {}): MailHeader =>
  ({ uid, subject: `Subject ${uid}`, unread: false, starred: false, date: null, ...extra }) as MailHeader;
const folder = (path: string, role: MailFolder["role"], unread: number | null = 0): MailFolder => ({
  path,
  name: path,
  role,
  depth: 0,
  selectable: true,
  unread,
  total: null,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

let requests = 0;
let release: () => void = () => {};
/** The management calls the hook sends (it uses the real api over fetch); each answer is set per test. */
let manage: { url: string; body: Record<string, unknown> }[];
let answerManage: (url: string, body: Record<string, unknown>) => Promise<Response>;
/** The store's own list api, answered from these lists (tree, folder lists). */
let tree: MailFolder[];
let lists: Record<string, MailHeader[]>;
let listCalls: string[];
let listFails: boolean;
let store: MailListStore;

function makeStore() {
  return createMailListStore({
    api: {
      fetchMailAccounts: async () => ({ rev: 1, accounts: [{ id: A } as never] }),
      fetchMailFolders: async (id) => {
        listCalls.push(`folders ${id}`);
        if (listFails) throw new Error("down");
        return { folders: structuredClone(tree), stale: false };
      },
      fetchMailHeaders: async (id, f) => {
        listCalls.push(`headers ${id} ${f}`);
        if (listFails) throw new Error("down");
        return { headers: structuredClone(lists[f] ?? []), uidValidity: 7, nextBefore: null, stale: false };
      },
    },
    live: { subscribe: () => () => {}, report: () => {} },
  });
}

async function loaded(...folders: string[]) {
  await store.loadAccounts();
  await store.loadFolders(A);
  for (const f of folders) await store.loadSource(A, f);
  listCalls = [];
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  requests = 0;
  manage = [];
  listCalls = [];
  listFails = false;
  tree = [folder("INBOX", "inbox", 1), folder("Archive", "custom", 0), folder("Trash", "trash", null)];
  lists = { Trash: [header(9, { subject: "Old" })], INBOX: [header(3), header(2, { unread: true }), header(1)] };
  answerManage = async () => {
    requests++;
    await new Promise<void>((r) => {
      release = r;
    });
    return json({ outcome: "deleted", destination: null, uid: null, uidValidity: null });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      manage.push({ url: String(input), body });
      return answerManage(String(input), body);
    })
  );
  store = makeStore();
});
afterEach(() => {
  cleanup();
  store.dispose();
  vi.unstubAllGlobals();
});

const uids = (f: string) => store.getSnapshot().sources[`${A}\u0000${f}`]?.headers.map((h) => h.uid);
const unread = (f: string) => store.folder(A, f)?.unread;
const env = (over: { closeIfOpen?: () => () => void; refreshSearch?: () => boolean } = {}) => ({
  store,
  closeIfOpen: over.closeIfOpen ?? (() => () => {}),
  refreshSearch: over.refreshSearch ?? (() => false),
});

test("confirming a permanent delete twice from the same render sends ONE request (a synchronous guard, not just busy)", async () => {
  await loaded("Trash");
  const { result } = renderHook(() => useMailActions(env()));
  act(() => result.current.requestDelete(ref));
  expect(result.current.confirm?.busy).toBe(false);
  // Both calls come from the same closure: neither can see busy=true, only a ref can stop the second.
  const confirm = result.current.confirmPermanent;
  await act(async () => {
    void confirm();
    void confirm();
    void confirm();
  });
  expect(requests).toBe(1);
  await act(async () => release());
});

// ---- optimistic changes on the real store, rolled back on failure, and what the user is told -------------

describe("flags", () => {
  const r2 = { accountId: A, folder: "INBOX", uid: 2 };

  test("a star shows at once and settles on what the server holds", async () => {
    await loaded("INBOX");
    let answer: (r: Response) => void = () => {};
    answerManage = () => new Promise((res) => (answer = res));
    const { result } = renderHook(() => useMailActions(env()));
    act(() => result.current.toggleStar(r2));
    expect(store.header(r2)?.starred).toBe(true);
    expect(result.current.pending.has(`${A}\u0000INBOX\u00002`)).toBe(true);
    expect(manage[0]?.body).toMatchObject({ folder: "INBOX", uid: 2, uidValidity: 7, flag: "flagged", value: true });
    await act(async () => answer(json({ uid: 2, unread: true, starred: true })));
    expect(store.header(r2)).toMatchObject({ starred: true, unread: true });
    expect(result.current.pending.size).toBe(0);
    expect(result.current.toasts).toEqual([]);
  });

  test("marking read moves the unread count; a refusal puts flag and count back and says why", async () => {
    await loaded("INBOX");
    let answer: (r: Response) => void = () => {};
    answerManage = () => new Promise((res) => (answer = res));
    const { result } = renderHook(() => useMailActions(env()));
    act(() => result.current.toggleRead(r2));
    expect(store.header(r2)?.unread).toBe(false);
    expect(unread("INBOX")).toBe(0);
    await act(async () => answer(json({ code: "imap_rejected" }, 502)));
    expect(store.header(r2)?.unread).toBe(true);
    expect(unread("INBOX")).toBe(1);
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ tone: "danger" });
    expect(result.current.toasts[0]?.text).toBe(
      i18n.t("mail.manage.flagFailed", { reason: i18n.t("mail.error.imap_rejected", { defaultValue: i18n.t("mail.error.unknown") }) })
    );
    expect(listCalls).toEqual([]); // the state is known: nothing is reloaded
  });

  test("a message gone on the server leaves the list and the reader", async () => {
    await loaded("INBOX");
    answerManage = async () => json({ code: "message_not_found" }, 404);
    const closeIfOpen = vi.fn(() => () => {});
    const { result } = renderHook(() => useMailActions(env({ closeIfOpen })));
    await act(async () => result.current.toggleStar(r2));
    expect(uids("INBOX")).toEqual([3, 1]);
    expect(closeIfOpen).toHaveBeenCalledWith(r2);
    expect(result.current.toasts[0]?.tone).toBe("danger");
  });

  test("an unknown outcome rolls back, reloads tree and loaded list silently, reruns the search, and says so", async () => {
    await loaded("INBOX");
    answerManage = async () => {
      throw new TypeError("network");
    };
    const refreshSearch = vi.fn(() => true);
    const { result } = renderHook(() => useMailActions(env({ refreshSearch })));
    await act(async () => {
      result.current.toggleStar(r2);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(store.header(r2)?.starred).toBe(false);
    expect(listCalls).toEqual([`folders ${A}`, `headers ${A} INBOX`]);
    expect(store.folder(A, "INBOX")).toBeDefined(); // silent: the tree never emptied
    expect(refreshSearch).toHaveBeenCalled();
    expect(result.current.toasts.map((t) => t.text)).toEqual([
      i18n.t("mail.manage.outcomeUnknown", { reason: i18n.t("mail.error.unreachable", { defaultValue: i18n.t("mail.error.unknown") }) }),
      i18n.t("mail.manage.reloaded"),
    ]);
  });

  test("when that reload fails too, the rolled-back state stays and nothing is claimed", async () => {
    await loaded("INBOX");
    answerManage = async () => {
      throw new TypeError("network");
    };
    const { result } = renderHook(() => useMailActions(env()));
    listFails = true;
    await act(async () => {
      result.current.toggleStar(r2);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(uids("INBOX")).toEqual([3, 2, 1]);
    expect(result.current.toasts[1]?.text).toBe(i18n.t("mail.manage.unconfirmed"));
  });
});

describe("move and delete", () => {
  const r2 = { accountId: A, folder: "INBOX", uid: 2 };

  test("a move takes the row out at once, names the folder, and undo moves it back", async () => {
    await loaded("INBOX", "Archive");
    let answer: (r: Response) => void = () => {};
    answerManage = () => new Promise((res) => (answer = res));
    const { result } = renderHook(() => useMailActions(env()));
    act(() => void result.current.move(r2, "Archive"));
    expect(uids("INBOX")).toEqual([3, 1]);
    expect(unread("INBOX")).toBe(0);
    expect(unread("Archive")).toBe(1);
    await act(async () => answer(json({ destination: "Archive", uid: 40, uidValidity: 8 })));
    expect(listCalls).toEqual([`headers ${A} Archive`]); // the destination is loaded: reloaded quietly
    const toast = result.current.toasts[0];
    expect(toast?.text).toBe(i18n.t("mail.manage.movedTo", { folder: "Archive" }));
    expect(toast?.action?.label).toBe(i18n.t("mail.manage.undo"));
    answerManage = async () => json({ destination: "INBOX", uid: 2, uidValidity: 7 });
    await act(async () => {
      toast?.action?.run();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(manage[1]).toMatchObject({ body: { folder: "Archive", uid: 40, uidValidity: 8, destination: "INBOX" } });
    expect(unread("INBOX")).toBe(1);
    expect(unread("Archive")).toBe(0);
    expect(result.current.toasts[1]?.text).toBe(i18n.t("mail.manage.undone"));
  });

  test("a standard folder is named in the page's language (the hook words it)", async () => {
    tree = [...tree, folder("Spam", "junk", 0)];
    await loaded("INBOX");
    answerManage = async () => json({ destination: "Spam", uid: null, uidValidity: null });
    const { result } = renderHook(() => useMailActions(env()));
    await act(async () => void (await result.current.move(r2, "Spam")));
    expect(result.current.toasts[0]?.text).toBe(i18n.t("mail.manage.movedTo", { folder: i18n.t("mail.folder.junk") }));
    expect(result.current.toasts[0]?.action).toBeUndefined(); // no new uid: nothing to undo with
  });

  test("a refused move puts the row back where it was, the counts and the reader too", async () => {
    await loaded("INBOX");
    answerManage = async () => json({ code: "imap_rejected" }, 502);
    const reopen = vi.fn();
    const { result } = renderHook(() => useMailActions(env({ closeIfOpen: () => reopen })));
    await act(async () => void (await result.current.move(r2, "Archive")));
    expect(uids("INBOX")).toEqual([3, 2, 1]);
    expect(unread("INBOX")).toBe(1);
    expect(unread("Archive")).toBe(0);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(result.current.toasts[0]?.tone).toBe("danger");
  });

  test("a move of a message gone on the server keeps it out; only the counts come back", async () => {
    await loaded("INBOX");
    answerManage = async () => json({ code: "message_not_found" }, 404);
    const { result } = renderHook(() => useMailActions(env()));
    await act(async () => void (await result.current.move(r2, "Archive")));
    expect(uids("INBOX")).toEqual([3, 1]);
    expect(unread("INBOX")).toBe(1);
    expect(unread("Archive")).toBe(0);
  });

  test("a partial move reloads the destination and says the state", async () => {
    await loaded("INBOX", "Archive");
    answerManage = async () => json({ code: "partial" }, 502);
    const { result } = renderHook(() => useMailActions(env()));
    await act(async () => void (await result.current.move(r2, "Archive")));
    expect(uids("INBOX")).toEqual([3, 2, 1]);
    expect(listCalls).toEqual([`headers ${A} Archive`]);
    expect(result.current.toasts[0]?.text).toBe(i18n.t("mail.manage.partial"));
  });

  test("delete outside Trash moves to Trash with the trashed notice; inside Trash it asks first", async () => {
    await loaded("INBOX", "Trash");
    answerManage = async () => json({ outcome: "trashed", destination: "Trash", uid: 77, uidValidity: 5 });
    const { result } = renderHook(() => useMailActions(env()));
    await act(async () => {
      result.current.requestDelete(r2);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(uids("INBOX")).toEqual([3, 1]);
    expect(result.current.toasts[0]?.text).toBe(i18n.t("mail.manage.trashed"));
    expect(listCalls).toEqual([`headers ${A} Trash`]);
    act(() => result.current.requestDelete(ref));
    expect(result.current.confirm).toMatchObject({ ref, subject: "Old", busy: false });
  });

  test("a confirmed permanent delete removes the row only after the server did, then reloads Trash", async () => {
    await loaded("Trash");
    answerManage = async () => {
      lists.Trash = [];
      return json({ outcome: "deleted", destination: null, uid: null, uidValidity: null });
    };
    const closeIfOpen = vi.fn(() => () => {});
    const { result } = renderHook(() => useMailActions(env({ closeIfOpen })));
    act(() => result.current.requestDelete(ref));
    expect(uids("Trash")).toEqual([9]);
    await act(async () => void (await result.current.confirmPermanent()));
    expect(manage[0]?.body).toMatchObject({ folder: "Trash", uid: 9, uidValidity: 7, permanent: true });
    expect(uids("Trash")).toEqual([]);
    expect(listCalls).toEqual([`headers ${A} Trash`]);
    expect(closeIfOpen).toHaveBeenCalledWith(ref);
    expect(result.current.confirm).toBeNull();
    expect(result.current.toasts[0]?.text).toBe(i18n.t("mail.manage.deletedForever"));
  });

  test("a permanent delete without a known UIDVALIDITY sends nothing", async () => {
    await loaded();
    const shown = { ...ref, folder: "Elsewhere" };
    tree = [...tree, folder("Elsewhere", "trash", null)];
    await store.loadFolders(A);
    const { result } = renderHook(() =>
      useMailActions({ ...env(), store: { ...store, header: () => header(9) } })
    );
    act(() => result.current.requestDelete(shown));
    await act(async () => void (await result.current.confirmPermanent()));
    expect(manage).toEqual([]);
    expect(result.current.confirm?.code).toBe("invalid_input");
  });
});
