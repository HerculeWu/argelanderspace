// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailAccount, MailHeader } from "@argelanderspace/contracts";
import { MailView } from "../src/mail/MailView";
import i18n from "../src/i18n";

const A1 = "acc-aaaaaaaaaaaa";
const account: MailAccount = {
  id: A1 as MailAccount["id"],
  displayName: "Work",
  address: "work@example.test",
  preset: "custom",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: "u",
  smtpUser: "u",
  credentialRef: A1 as MailAccount["credentialRef"],
  credentialProtection: "keychain",
};
const header = (uid: number, over: Partial<MailHeader> = {}): MailHeader => ({
  uid,
  date: `2026-10-0${uid}T10:00:00.000Z`,
  from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
  to: [{ name: "", address: "me@example.test" }],
  subject: `Subject ${uid}`,
  unread: true,
  starred: false,
  hasAttachments: false,
  size: 100,
  ...over,
});

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
interface Deferred {
  release: () => void;
  wait: Promise<void>;
}
const deferred = (): Deferred => {
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
};
interface Server {
  folders: Record<string, MailHeader[]>;
  calls: Call[];
  /** endpoint suffix (e.g. "flag") -> error to answer with instead of doing the change */
  failures: Record<string, { status: number; code: string } | undefined>;
  /** endpoint suffix -> hold the answer until released */
  holds: Record<string, Deferred | undefined>;
  searchResults: MailHeader[];
  nextUid: number;
  /** folder and message list requests fail (the server cannot be asked) */
  listDown: boolean;
  /** serve at most this many headers per page (0 = all) */
  pageCap: number;
}
let srv: Server;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const ROLES: Record<string, string> = { INBOX: "inbox", Sent: "sent", Trash: "trash", Archive: "archive" };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  srv = {
    folders: {
      INBOX: [header(3), header(2, { unread: false }), header(1)],
      Sent: [],
      "Projects/Euclid": [],
      Trash: [header(9, { unread: false, subject: "Old trash" })],
      Archive: [],
    },
    calls: [],
    failures: {},
    holds: {},
    searchResults: [header(2, { unread: false, subject: "Found two" }), header(1, { subject: "Found one" })],
    nextUid: 40,
    listDown: false,
    pageCap: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      srv.calls.push({ method, url, ...(body ? { body } : {}) });
      if (url === "/api/mail/accounts") return json({ version: 1, rev: 1, accounts: [account] });
      if (srv.listDown && method === "GET" && /\/(folders|messages\?.*)$/.test(url))
        return json({ code: "connection_refused", detail: "x" }, 502);
      if (/\/folders$/.test(url))
        return json({
          accountId: A1,
          stale: false,
          folders: Object.keys(srv.folders).map((path) => ({
            path,
            name: path.split("/").pop(),
            role: ROLES[path] ?? "custom",
            depth: path.includes("/") ? 1 : 0,
            selectable: true,
            unread: srv.folders[path]!.filter((h) => h.unread).length,
            total: srv.folders[path]!.length,
          })),
        });
      const list = url.match(/\/messages\?(.*)$/);
      if (list) {
        const params = new URLSearchParams(list[1]);
        const folder = params.get("folder")!;
        const before = Number(params.get("before") ?? Number.POSITIVE_INFINITY);
        const all = (srv.folders[folder] ?? []).filter((h) => h.uid < before);
        const page = srv.pageCap > 0 ? all.slice(0, srv.pageCap) : all;
        return json({
          accountId: A1,
          folder,
          uidValidity: 7,
          total: srv.folders[folder]?.length ?? 0,
          headers: page,
          nextBefore: page.length < all.length ? (page[page.length - 1]?.uid ?? null) : null,
          stale: false,
        });
      }
      if (/\/messages\/open$/.test(url)) {
        const h = srv.folders[body!.folder as string]?.find((x) => x.uid === body!.uid);
        if (h && body!.unread) h.unread = false; // the server sets \Seen on open
        return json({
          message: {
            accountId: A1,
            folder: body!.folder,
            uid: body!.uid,
            uidValidity: 7,
            messageId: null,
            subject: `Subject ${body!.uid}`,
            date: "2026-10-05T10:00:00.000Z",
            from: { name: "Sender", address: "s@example.test" },
            to: [],
            cc: [],
            replyTo: [],
            text: `Plain body ${body!.uid}`,
            html: null,
            attachments: [],
          },
          seen: true,
          stale: false,
        });
      }
      const action = url.match(/\/messages\/(flag|move|delete|search)$/)?.[1];
      if (action) {
        await srv.holds[action]?.wait;
        const fail = srv.failures[action];
        if (fail) return json({ code: fail.code, detail: "x" }, fail.status);
        const folder = body!.folder as string;
        const uid = body!.uid as number;
        const at = srv.folders[folder]?.findIndex((h) => h.uid === uid) ?? -1;
        if (action === "search")
          return json({
            accountId: A1,
            folder,
            uidValidity: 7,
            matches: srv.searchResults.length,
            headers: srv.searchResults,
            nextBefore: null,
          });
        if (action === "flag") {
          const h = srv.folders[folder]![at]!;
          if (body!.flag === "seen") h.unread = !body!.value;
          else h.starred = body!.value as boolean;
          return json({ uid, unread: h.unread, starred: h.starred });
        }
        const dest = action === "delete" ? "Trash" : (body!.destination as string);
        const [moved] = srv.folders[folder]!.splice(at, 1);
        const newUid = srv.nextUid++;
        srv.folders[dest]!.unshift({ ...moved!, uid: newUid });
        return json({ destination: dest, uid: newUid, uidValidity: 9 });
      }
      return json({ code: "unavailable" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ui = (id: string, key?: string) =>
  document.querySelector<HTMLElement>(`[data-ui="${id}"]${key ? `[data-ui-key="${key}"]` : ""}`);
const folder = (name: string) =>
  waitFor(() => {
    const el = ui("mail-folder", `${A1}:${name}`);
    if (!el) throw new Error(`folder ${name} not shown yet`);
    return el;
  });
const row = (uid: number, folder = "INBOX") => ui("mail-message-row", `${A1}:${folder}:${uid}`);
const calls = (suffix: string) => srv.calls.filter((c) => c.url.endsWith(suffix) && c.method === "POST");
const inboxCount = () =>
  within(ui("mail-folder", `${A1}:INBOX`)!).queryByLabelText(/unread/)?.textContent ?? "0";

async function openInbox(uid = 3) {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(uid)).toBeTruthy());
  fireEvent.click(row(uid)!);
  await screen.findByText(`Plain body ${uid}`);
}

// ---- flags ---------------------------------------------------------------------------

test("star shows at once, the server decides: a refusal puts the star back and says why", async () => {
  await openInbox(2);
  srv.holds.flag = deferred();
  srv.failures.flag = { status: 502, code: "refused" };
  const star = ui("mail-star")!;
  expect(star.getAttribute("data-starred")).toBe("false");
  fireEvent.click(star);
  // optimistic: starred in the reader and the list before the server answered
  await waitFor(() => expect(ui("mail-star")!.getAttribute("data-starred")).toBe("true"));
  expect(row(2)!.querySelector('[aria-label="Starred"]')).toBeTruthy();
  expect(ui("mail-star")!.hasAttribute("disabled")).toBe(true); // no second request while one is in flight
  await act(async () => srv.holds.flag!.release());
  await waitFor(() => expect(ui("mail-star")!.getAttribute("data-starred")).toBe("false"));
  expect(row(2)!.querySelector('[aria-label="Starred"]')).toBeNull();
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toContain("didn't go through");
  expect(toast.textContent).toContain("The server refused the change");
  expect(toast.className).toContain("danger"); // a failed change is an error, in the error tone
  expect(ui("mail-star")!.hasAttribute("aria-pressed")).toBe(false); // the name changes with the state instead
  expect(ui("mail-star")!.hasAttribute("disabled")).toBe(false);
  expect(calls("/messages/flag")[0]!.body).toEqual({ folder: "INBOX", uid: 2, uidValidity: 7, flag: "flagged", value: true });
});

test("star success keeps the star and the server's answer settles the state", async () => {
  await openInbox(2);
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(srv.folders.INBOX!.find((h) => h.uid === 2)!.starred).toBe(true));
  expect(ui("mail-star")!.getAttribute("data-starred")).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(srv.folders.INBOX!.find((h) => h.uid === 2)!.starred).toBe(false));
});

test("mark unread moves the folder count at once and puts it back when the server refuses", async () => {
  await openInbox(3); // opening marks it read: INBOX 2 -> 1 unread? (uid 3 and 1 were unread)
  await waitFor(() => expect(inboxCount()).toBe("1"));
  srv.holds.flag = deferred();
  srv.failures.flag = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-mark-unread")!);
  await waitFor(() => expect(inboxCount()).toBe("2"));
  expect(row(3)!.className).toContain("unread");
  await act(async () => srv.holds.flag!.release());
  await waitFor(() => expect(inboxCount()).toBe("1"));
  expect(row(3)!.className).not.toContain("unread");
  const alert = (await screen.findByRole("alert")).textContent ?? "";
  // a dropped connection leaves the outcome unknown: no "didn't go through", no claim either way
  expect(alert).toContain("Result unknown");
  expect(alert).not.toContain("didn't go through");
  expect(alert).not.toContain("still where it was");
  expect(calls("/messages/flag")[0]!.body).toMatchObject({ flag: "seen", value: false });
});

// ---- move ------------------------------------------------------------------------------

test("move: the row leaves at once, the reader closes, Undo moves it back from its new position", async () => {
  await openInbox(3);
  srv.holds.move = deferred();
  fireEvent.click(ui("mail-move")!);
  const menu = ui("mail-move-menu")!;
  const targets = [...menu.querySelectorAll('[data-ui="mail-move-target"]')].map((b) => b.getAttribute("data-ui-key"));
  expect(targets).toEqual(["Trash", "Archive", "Projects/Euclid"].sort((a, b) => targets.indexOf(a) - targets.indexOf(b)));
  expect(targets).not.toContain("INBOX");
  expect(targets).not.toContain("Sent");
  fireEvent.click(ui("mail-move-target", "Projects/Euclid")!);
  await waitFor(() => expect(row(3)).toBeNull());
  expect(ui("mail-text-body")).toBeNull(); // reader closed
  await act(async () => srv.holds.move!.release());
  await waitFor(() => expect(screen.getByText("Moved to Euclid")).toBeTruthy());
  expect(calls("/messages/move")[0]!.body).toEqual({ folder: "INBOX", uid: 3, uidValidity: 7, destination: "Projects/Euclid" });

  fireEvent.click(ui("mail-toast-action")!);
  await waitFor(() => expect(calls("/messages/move")).toHaveLength(2));
  expect(calls("/messages/move")[1]!.body).toEqual({ folder: "Projects/Euclid", uid: 40, uidValidity: 9, destination: "INBOX" });
  await waitFor(() => expect(row(41)).toBeTruthy()); // INBOX list reloaded: the message is back (new uid)
  expect(screen.getByText("Moved back")).toBeTruthy();
});

test("move refused: the row comes back in the same place, the reader reopens and the reason is shown", async () => {
  await openInbox(2);
  srv.holds.move = deferred();
  srv.failures.move = { status: 404, code: "destination_not_found" };
  fireEvent.click(ui("mail-move")!);
  fireEvent.click(ui("mail-move-target", "Archive")!);
  await waitFor(() => expect(row(2)).toBeNull());
  const order = () => [...document.querySelectorAll('[data-ui="mail-message-row"]')].map((r) => r.getAttribute("data-ui-key"));
  expect(order()).toEqual([`${A1}:INBOX:3`, `${A1}:INBOX:1`]);
  await act(async () => srv.holds.move!.release());
  await waitFor(() => expect(row(2)).toBeTruthy());
  expect(order()).toEqual([`${A1}:INBOX:3`, `${A1}:INBOX:2`, `${A1}:INBOX:1`]);
  await screen.findByText("Plain body 2"); // the reader is back
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toContain("still where it was");
  expect(toast.textContent).toContain("destination folder doesn't exist");
  expect(srv.folders.INBOX!.some((h) => h.uid === 2)).toBe(true);
});

test("a move of an unread message shifts both folder counts and restores them on failure", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  expect(inboxCount()).toBe("2");
  fireEvent.click(row(3)!);
  await screen.findByText("Plain body 3");
  await waitFor(() => expect(inboxCount()).toBe("1"));
});

// ---- delete ----------------------------------------------------------------------------

test("delete moves into Trash with Undo; a server failure puts the message back", async () => {
  await openInbox(1);
  fireEvent.click(ui("mail-delete")!);
  await waitFor(() => expect(row(1)).toBeNull());
  await waitFor(() => expect(screen.getByText("Moved to Trash")).toBeTruthy());
  expect(calls("/messages/delete")[0]!.body).toEqual({ folder: "INBOX", uid: 1, uidValidity: 7 });
  expect(srv.folders.Trash!.map((h) => h.uid)).toContain(40);

  // second delete fails
  fireEvent.click(row(2)!);
  await screen.findByText("Plain body 2");
  srv.holds.delete = deferred();
  srv.failures.delete = { status: 409, code: "trash_not_found" };
  fireEvent.click(ui("mail-delete")!);
  await waitFor(() => expect(row(2)).toBeNull());
  await act(async () => srv.holds.delete!.release());
  await waitFor(() => expect(row(2)).toBeTruthy());
  const alerts = await screen.findAllByRole("alert");
  expect(alerts.map((a) => a.textContent).join(" ")).toContain("no Trash folder");
});

test("in Trash, delete asks first, names the message and says it can't be undone; nothing is sent until confirmed", async () => {
  render(<MailView />);
  fireEvent.click(await folder("Trash"));
  await waitFor(() => expect(row(9, "Trash")).toBeTruthy());
  fireEvent.click(row(9, "Trash")!);
  await screen.findByText("Plain body 9");
  expect(ui("mail-delete")).toBeNull();
  expect(ui("mail-restore")).toBeTruthy();
  fireEvent.click(ui("mail-delete-forever")!);

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Old trash")).toBeTruthy();
  expect(dialog.textContent).toContain("can't be undone");
  expect(calls("/messages/delete")).toHaveLength(0);
  expect(row(9, "Trash")).toBeTruthy();
  // the safe default focus is Cancel
  expect(document.activeElement).toBe(ui("mail-permanent-delete-cancel"));

  fireEvent.click(ui("mail-permanent-delete-cancel")!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls("/messages/delete")).toHaveLength(0);
});

test("permanent delete is not optimistic: a failure keeps the row and the dialog and shows the reason", async () => {
  render(<MailView />);
  fireEvent.click(await folder("Trash"));
  await waitFor(() => expect(row(9, "Trash")).toBeTruthy());
  fireEvent.click(row(9, "Trash")!);
  await screen.findByText("Plain body 9");
  fireEvent.click(ui("mail-delete-forever")!);
  await screen.findByRole("dialog");
  srv.holds.delete = deferred();
  srv.failures.delete = { status: 502, code: "refused" };
  fireEvent.click(ui("mail-permanent-delete-confirm")!);
  await waitFor(() => expect(ui("mail-permanent-delete-confirm")!.hasAttribute("disabled")).toBe(true));
  expect(row(9, "Trash")).toBeTruthy(); // still there while the server works
  await act(async () => srv.holds.delete!.release());
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeTruthy());
  expect(screen.getByRole("dialog").textContent).toContain("The server refused the change");
  expect(row(9, "Trash")).toBeTruthy();
  expect(calls("/messages/delete")[0]!.body).toEqual({ folder: "Trash", uid: 9, uidValidity: 7, permanent: true });

  // retry succeeds
  delete srv.failures.delete;
  fireEvent.click(ui("mail-permanent-delete-confirm")!);
  await waitFor(() => expect(row(9, "Trash")).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Deleted permanently")).toBeTruthy();
});

test("a server that says the folder is Trash (confirmation_required) turns a plain delete into the confirmation", async () => {
  await openInbox(1);
  srv.failures.delete = { status: 409, code: "confirmation_required" };
  fireEvent.click(ui("mail-delete")!);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Delete this message permanently?");
  expect(row(1)).toBeTruthy(); // rolled back: nothing was removed
});

// ---- search ------------------------------------------------------------------------------

const searchBox = () => within(ui("mail-search")!).getByRole("textbox") as HTMLInputElement;
const submitSearch = (text: string) => {
  fireEvent.change(searchBox(), { target: { value: text } });
  fireEvent.submit(ui("mail-search")!);
};

test("search asks the server, replaces the list with the results and clearing brings the folder back", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  const folderCalls = srv.calls.filter((c) => /\/messages\?/.test(c.url)).length;
  srv.holds.search = deferred();
  submitSearch('from:ada subject:"weekly report" since:2026-01-31 euclid');
  await waitFor(() => expect(ui("mail-search-state")!.textContent).toContain("Searching on server"));
  await act(async () => srv.holds.search!.release());
  await waitFor(() => expect(ui("mail-search-state")!.textContent).toContain("2 found on the server"));
  expect(calls("/messages/search")[0]!.body).toEqual({
    folder: "INBOX",
    criteria: { text: "euclid", from: "ada", subject: "weekly report", since: "2026-01-31" },
    limit: 50,
  });
  expect(row(3)).toBeNull();
  expect(screen.getByText("Found two")).toBeTruthy();
  expect(screen.getByText("Found one")).toBeTruthy();
  // the folder list was not refetched by searching
  expect(srv.calls.filter((c) => /\/messages\?/.test(c.url)).length).toBe(folderCalls);

  fireEvent.click(ui("mail-search-clear")!);
  await waitFor(() => expect(row(3)).toBeTruthy());
  expect(ui("mail-search-state")).toBeNull();
  expect(searchBox().value).toBe("");
});

test("search with nothing to search for sends no request; a bad date is explained; no results and failures are said plainly", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  submitSearch("   ");
  submitSearch("since:31.01.2026");
  expect(ui("mail-search-state")!.textContent).toContain("Dates must look like");
  expect(calls("/messages/search")).toHaveLength(0);

  srv.searchResults = [];
  submitSearch("nothing");
  await waitFor(() => expect(ui("mail-search-empty")!.textContent).toContain("found no matching messages"));

  srv.failures.search = { status: 502, code: "connection_refused" };
  submitSearch("again");
  await waitFor(() => expect(ui("mail-search-state")!.textContent).toContain("Search failed"));
  expect(ui("mail-search-state")!.textContent).toContain("refused or dropped the connection");
  expect(ui("mail-search-empty")).toBeNull();
  expect(ui("mail-list-error")).toBeNull(); // one message, not two
});

test("search results are managed like the folder list: a star shows in the results and survives clearing", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  submitSearch("found");
  await screen.findByText("Found two");
  fireEvent.click(row(2)!);
  await screen.findByText("Plain body 2");
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(row(2)!.querySelector('[aria-label="Starred"]')).toBeTruthy());
  fireEvent.click(ui("mail-delete")!);
  await waitFor(() => expect(row(2)).toBeNull());
  fireEvent.click(ui("mail-search-clear")!);
  await waitFor(() => expect(row(3)).toBeTruthy());
  expect(row(2)).toBeNull(); // deleted: gone from the folder list too
});

test("switching folder drops the search; unified inbox searches every inbox", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  submitSearch("found");
  await screen.findByText("Found two");
  fireEvent.click(ui("mail-folder", `${A1}:Archive`)!);
  await waitFor(() => expect(ui("mail-search-state")).toBeNull());
  expect(searchBox().value).toBe("");
  fireEvent.click(ui("mail-folder", "unified")!);
  await waitFor(() => expect(row(3)).toBeTruthy());
  submitSearch("found");
  await waitFor(() => expect(calls("/messages/search")).toHaveLength(2));
  expect(calls("/messages/search")[1]!.body).toMatchObject({ folder: "INBOX", criteria: { text: "found" } });
});

test("Chinese interface: the actions and the failure text are localised", async () => {
  await i18n.changeLanguage("zh-CN");
  await openInbox(2);
  expect(ui("mail-star")!.getAttribute("aria-label")).toBe("加星标");
  expect(ui("mail-mark-unread")!.getAttribute("aria-label")).toBe("标为未读");
  expect(ui("mail-delete")!.getAttribute("aria-label")).toBe("删除");
  srv.failures.flag = { status: 502, code: "refused" };
  fireEvent.click(ui("mail-star")!);
  expect((await screen.findByRole("alert")).textContent).toContain("服务器拒绝了这项更改");
  expect(searchBox().getAttribute("placeholder")).toBe("在服务器上搜索");
});

// ---- review round 1: honest wording when the outcome is unknown -------------------------------

const foldersFetches = () => srv.calls.filter((c) => c.method === "GET" && /\/folders$/.test(c.url)).length;

test("a move whose connection dropped says the result is unknown and reloads from the server instead of claiming either", async () => {
  await openInbox(2);
  const folderLoads = foldersFetches();
  srv.holds.move = deferred();
  srv.failures.move = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-move")!);
  fireEvent.click(ui("mail-move-target", "Archive")!);
  await waitFor(() => expect(row(2)).toBeNull());
  await act(async () => srv.holds.move!.release());
  const alert = (await screen.findByRole("alert")).textContent ?? "";
  expect(alert).toContain("Result unknown");
  expect(alert).not.toContain("still where it was");
  expect(alert).not.toContain("reload"); // the reload is announced by its own notice, once it has an outcome
  await waitFor(() => expect(row(2)).toBeTruthy()); // the reload shows what the server holds
  expect(foldersFetches()).toBeGreaterThan(folderLoads);
  expect(srv.calls.filter((c) => /\/messages\?/.test(c.url) && c.url.includes("folder=INBOX")).length).toBeGreaterThan(1);
});

test("an unreachable workbench service is also an unknown outcome", async () => {
  await openInbox(2);
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/messages/flag")) throw new TypeError("network down");
    return real(input, init);
  }));
  fireEvent.click(ui("mail-star")!);
  expect((await screen.findByRole("alert")).textContent).toContain("Result unknown");
  await waitFor(() => expect(ui("mail-star")!.getAttribute("data-starred")).toBe("false"));
});

test("a message that is no longer there is reported as gone, and does not come back into the list", async () => {
  await openInbox(2);
  srv.failures.flag = { status: 404, code: "message_not_found" };
  fireEvent.click(ui("mail-star")!);
  const alert = (await screen.findByRole("alert")).textContent ?? "";
  expect(alert).toContain("no longer here");
  expect(alert).not.toContain("didn't go through");
  await waitFor(() => expect(row(2)).toBeNull());
});

test("permanent delete: an unknown outcome and a vanished message get their own dialog title; double click sends one request", async () => {
  render(<MailView />);
  fireEvent.click(await folder("Trash"));
  await waitFor(() => expect(row(9, "Trash")).toBeTruthy());
  fireEvent.click(row(9, "Trash")!);
  await screen.findByText("Plain body 9");
  fireEvent.click(ui("mail-delete-forever")!);
  await screen.findByRole("dialog");
  srv.failures.delete = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-permanent-delete-confirm")!);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("alert")).toBeTruthy());
  expect(dialog.textContent).toContain("Result unknown");
  expect(dialog.textContent).not.toContain("Not deleted");
  expect(row(9, "Trash")).toBeTruthy();

  srv.failures.delete = { status: 404, code: "message_not_found" };
  srv.holds.delete = deferred();
  const confirm = ui("mail-permanent-delete-confirm")!;
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await act(async () => srv.holds.delete!.release());
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Message no longer here"));
  expect(calls("/messages/delete")).toHaveLength(2); // the first attempt plus ONE of the three clicks
});

test("the search box: IME confirmation is not a search, and the syntax hint is a real tooltip linked by aria-describedby", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  const input = searchBox();
  expect(input.hasAttribute("title")).toBe(false);
  const form = ui("mail-search")!;
  // the description sits on the control that has focus, not on the form around it
  expect(form.hasAttribute("aria-describedby")).toBe(false);
  const hintId = input.getAttribute("aria-describedby")!.split(" ").pop()!;
  expect(document.getElementById(hintId)!.textContent).toContain("from:");
  expect(document.getElementById(hintId)!.getAttribute("role")).toBe("tooltip");
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.submit(form);
  expect(calls("/messages/search")).toHaveLength(0);
  fireEvent.compositionEnd(input);
  fireEvent.submit(form);
  await waitFor(() => expect(calls("/messages/search")).toHaveLength(1));
});

// ---- review round 2: an unknown outcome must not undo the rollback ----------------------------------

const toastTexts = () => [...document.querySelectorAll('[data-ui="mail-toast"]')].map((t) => t.textContent ?? "");
const starred = (uid: number) => !!row(uid)?.querySelector('[aria-label="Starred"]');

test("flag with an unknown outcome AND a failing reload: the rolled-back star stays rolled back, and the user is told nothing could be confirmed", async () => {
  await openInbox(2);
  srv.failures.flag = { status: 502, code: "connection_lost" };
  srv.listDown = true;
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Couldn't confirm with the server"));
  expect(toastTexts().join("|")).toContain("Result unknown");
  expect(starred(2)).toBe(false);
  expect(ui("mail-star")!.getAttribute("data-starred")).toBe("false");
  expect(row(2)).toBeTruthy();
  expect(ui("mail-list-error")).toBeNull(); // a silent reload failure is not a list error banner
});

test("move with an unknown outcome AND a failing reload: the row stays where it was, in its place", async () => {
  await openInbox(2);
  srv.failures.move = { status: 502, code: "connection_lost" };
  srv.listDown = true;
  fireEvent.click(ui("mail-move")!);
  fireEvent.click(ui("mail-move-target", "Archive")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Couldn't confirm with the server"));
  expect(toastTexts().join("|")).toContain("Result unknown");
  const order = [...document.querySelectorAll('[data-ui="mail-message-row"]')].map((r) => r.getAttribute("data-ui-key"));
  expect(order).toEqual([`${A1}:INBOX:3`, `${A1}:INBOX:2`, `${A1}:INBOX:1`]);
  await screen.findByText("Plain body 2"); // and the reader that was closed is back
  expect(inboxCount()).toBe("2");
});

test("delete with an unknown outcome AND a failing reload: the message is back in the list", async () => {
  await openInbox(1);
  srv.failures.delete = { status: 502, code: "connection_lost" };
  srv.listDown = true;
  fireEvent.click(ui("mail-delete")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Couldn't confirm with the server"));
  expect(toastTexts().join("|")).toContain("Result unknown");
  expect(row(1)).toBeTruthy();
});

test("permanent delete with an unknown outcome AND a failing reload: dialog and row stay, wording is honest", async () => {
  render(<MailView />);
  fireEvent.click(await folder("Trash"));
  await waitFor(() => expect(row(9, "Trash")).toBeTruthy());
  fireEvent.click(row(9, "Trash")!);
  await screen.findByText("Plain body 9");
  fireEvent.click(ui("mail-delete-forever")!);
  await screen.findByRole("dialog");
  srv.failures.delete = { status: 502, code: "connection_lost" };
  srv.listDown = true;
  fireEvent.click(ui("mail-permanent-delete-confirm")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Couldn't confirm with the server"));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Result unknown");
  expect(dialog.textContent).toContain("connection dropped");
  expect(dialog.textContent).not.toContain("refresh");
  expect(row(9, "Trash")).toBeTruthy();
});

test("a service answer that cannot be read (unavailable) is an unknown outcome too", async () => {
  await openInbox(2);
  srv.failures.flag = { status: 500, code: "unavailable" };
  fireEvent.click(ui("mail-star")!);
  expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("Result unknown");
});

test("a reload after an unknown outcome keeps the pages already loaded and never blanks the list", async () => {
  srv.pageCap = 2;
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  expect(row(1)).toBeNull();
  fireEvent.click(ui("mail-load-more")!);
  await waitFor(() => expect(row(1)).toBeTruthy());
  expect(ui("mail-load-more")).toBeNull();
  fireEvent.click(row(2)!);
  await screen.findByText("Plain body 2");

  const counts: number[] = [];
  const watch = new MutationObserver(() => counts.push(document.querySelectorAll('[data-ui="mail-message-row"]').length));
  watch.observe(document.body, { childList: true, subtree: true });
  srv.failures.flag = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Reloaded from the server"));
  watch.disconnect();
  expect(Math.min(...counts)).toBe(3); // never fewer rows, not even for a moment
  expect(row(1)).toBeTruthy(); // the older page was not cut off
  expect(ui("mail-load-more")).toBeNull();
});

test("the unified inbox keeps its rows during the reload that follows an unknown outcome", async () => {
  render(<MailView />);
  fireEvent.click(await waitFor(() => ui("mail-folder", "unified")!));
  await waitFor(() => expect(row(3)).toBeTruthy());
  fireEvent.click(row(2)!);
  await screen.findByText("Plain body 2");
  const counts: number[] = [];
  const watch = new MutationObserver(() => counts.push(document.querySelectorAll('[data-ui="mail-message-row"]').length));
  watch.observe(document.body, { childList: true, subtree: true });
  srv.failures.flag = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(toastTexts().join("|")).toContain("Reloaded from the server"));
  watch.disconnect();
  expect(Math.min(...counts)).toBe(3);
});

test("a row that a reload brought back while its move was still in flight is removed when the move succeeds", async () => {
  await openInbox(2);
  srv.holds.move = deferred();
  fireEvent.click(ui("mail-move")!);
  fireEvent.click(ui("mail-move-target", "Archive")!);
  await waitFor(() => expect(row(2)).toBeNull());
  // another change fails with an unknown outcome; its reload sees the server before the move has happened
  fireEvent.click(row(3)!);
  await screen.findByText("Plain body 3");
  srv.failures.flag = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(row(2)).toBeTruthy());
  delete srv.failures.flag;
  await act(async () => srv.holds.move!.release());
  await waitFor(() => expect(row(2)).toBeNull());
});

test("an unknown outcome during a search runs the search again", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  submitSearch("found");
  await screen.findByText("Found two");
  fireEvent.click(row(2)!);
  await screen.findByText("Plain body 2");
  expect(calls("/messages/search")).toHaveLength(1);
  srv.failures.flag = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-star")!);
  await waitFor(() => expect(calls("/messages/search")).toHaveLength(2));
});

test("a delete with an unknown outcome also reloads the Trash it may have gone to", async () => {
  render(<MailView />);
  fireEvent.click(await folder("Trash"));
  await waitFor(() => expect(row(9, "Trash")).toBeTruthy());
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(1)).toBeTruthy());
  fireEvent.click(row(1)!);
  await screen.findByText("Plain body 1");
  const trashLoads = () => srv.calls.filter((c) => /\/messages\?/.test(c.url) && c.url.includes("folder=Trash")).length;
  const before = trashLoads();
  srv.failures.delete = { status: 502, code: "connection_lost" };
  fireEvent.click(ui("mail-delete")!);
  await waitFor(() => expect(trashLoads()).toBeGreaterThan(before));
});

test("partial: a copy exists but the original is still here: known state, its own wording, not 'unknown'", async () => {
  await openInbox(2);
  srv.failures.move = { status: 502, code: "partial" };
  fireEvent.click(ui("mail-move")!);
  fireEvent.click(ui("mail-move-target", "Archive")!);
  const alert = (await screen.findByRole("alert")).textContent ?? "";
  expect(alert).toContain("A copy was made in the destination");
  expect(alert).toContain("original is still here");
  expect(alert).not.toContain("Result unknown");
  await waitFor(() => expect(row(2)).toBeTruthy());
});

test("a failed search is worded as a search, not as a change", async () => {
  render(<MailView />);
  fireEvent.click(await folder("INBOX"));
  await waitFor(() => expect(row(3)).toBeTruthy());
  srv.failures.search = { status: 502, code: "refused" };
  submitSearch("again");
  await waitFor(() => expect(ui("mail-search-state")!.textContent).toContain("The server refused the search"));
  expect(ui("mail-search-state")!.textContent).not.toContain("change");
  srv.failures.search = { status: 502, code: "connection_lost" };
  submitSearch("again");
  await waitFor(() => expect(ui("mail-search-state")!.textContent).toContain("search didn't finish"));
});
