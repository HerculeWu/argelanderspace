// @vitest-environment jsdom
import type { MailAccount, MailHeader, WsMailChanged } from "@argelanderspace/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { MailNavItem } from "../src/mail/MailNavItem";
import { MailView } from "../src/mail/MailView";
import { resetMailLive } from "../src/mail/mailLive";

// The WebSocket client is replaced by a hand-driven channel.
const channel = vi.hoisted(() => ({
  push: null as ((msg: WsMailChanged) => void) | null,
  resync: null as (() => void) | null,
  subscribers: 0,
}));
vi.mock("../src/api/ws", () => ({
  onMailChanged: (cb: (msg: WsMailChanged) => void, resync?: () => void) => {
    channel.push = cb;
    channel.resync = resync ?? null;
    channel.subscribers++;
    return () => {
      channel.subscribers--;
      channel.push = null;
      channel.resync = null;
    };
  },
}));

const A1 = "acc-aaaaaaaaaaaa";
const A2 = "acc-bbbbbbbbbbbb";
const acct = (id: string, name: string): MailAccount => ({
  id: id as MailAccount["id"],
  displayName: name,
  address: `${name.toLowerCase()}@example.test`,
  preset: "custom",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: "u",
  smtpUser: "u",
  credentialRef: id as MailAccount["credentialRef"],
  credentialProtection: "keychain",
});
const header = (uid: number, unread = true): MailHeader => ({
  uid,
  date: `2026-10-0${Math.min(uid, 9)}T10:00:00.000Z`,
  from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
  to: [],
  subject: `Subject ${uid}`,
  unread,
  starred: false,
  hasAttachments: false,
  size: 100,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

interface Server {
  accounts: MailAccount[];
  /** Per account: authoritative INBOX headers, and whether it refuses the login. */
  inbox: Record<string, { headers: MailHeader[]; authFailed?: boolean }>;
  /** What GET /api/mail/unread answers. */
  summary: { accountId: string; unread: number | null; watch: string }[];
  calls: string[];
  /** UIDVALIDITY the headers endpoint reports. */
  uidValidity: number;
  /** Per account: `nextBefore` of the first page and the older page behind it. */
  paging: Record<string, { nextBefore: number; older: MailHeader[] }>;
  /** When set, requests for older pages wait for it; when `unreadGate` is set the summary waits too. */
  olderGate: Promise<void> | null;
  unreadGate: Promise<void> | null;
  /** One-shot gates: the next first-page request / the next Work folder request waits for it (its body is fixed at request time). */
  headGate: Promise<void> | null;
  folderGate: Promise<void> | null;
}
let srv: Server;
const unreadOf = (a: string) => srv.inbox[a]?.headers.filter((h) => h.unread).length ?? 0;
const total = () => srv.summary.reduce((n, a) => n + (a.watch === "auth_failed" ? 0 : (a.unread ?? 0)), 0);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  resetMailLive();
  channel.push = null;
  channel.resync = null;
  channel.subscribers = 0;
  srv = {
    accounts: [acct(A1, "Work"), acct(A2, "Home")],
    inbox: {
      [A1]: { headers: [header(3), header(2), header(1, false)] },
      [A2]: { headers: [header(5)] },
    },
    summary: [
      { accountId: A1, unread: 2, watch: "idle" },
      { accountId: A2, unread: 1, watch: "idle" },
    ],
    calls: [],
    uidValidity: 7,
    paging: {},
    olderGate: null,
    unreadGate: null,
    headGate: null,
    folderGate: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      srv.calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/mail/unread") {
        const body = { version: 1, accounts: structuredClone(srv.summary), total: total() };
        if (srv.unreadGate) await srv.unreadGate;
        return json(body);
      }
      if (url === "/api/mail/accounts") return json({ version: 1, rev: 1, accounts: srv.accounts });
      const f = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/folders$/);
      if (f) {
        const cfg = srv.inbox[f[1] as string];
        if (cfg?.authFailed) return json({ code: "auth_failed", detail: "x" }, 502);
        const gate = f[1] === A1 ? srv.folderGate : null;
        if (gate) srv.folderGate = null;
        const response = json({
          accountId: f[1],
          stale: false,
          folders: [
            { path: "INBOX", name: "INBOX", role: "inbox", depth: 0, selectable: true, unread: unreadOf(f[1] as string), total: cfg?.headers.length ?? 0 },
          ],
        });
        if (gate) await gate;
        return response;
      }
      const l = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/messages\?(.*)$/);
      if (l) {
        const cfg = srv.inbox[l[1] as string];
        if (cfg?.authFailed) return json({ code: "auth_failed", detail: "x" }, 502);
        const all = cfg?.headers ?? [];
        const paging = srv.paging[l[1] as string];
        if (paging && /[?&]before=/.test(url)) {
          if (srv.olderGate) await srv.olderGate;
          return json({ accountId: l[1], folder: "INBOX", uidValidity: srv.uidValidity, total: all.length, headers: paging.older, nextBefore: null, stale: false });
        }
        const head = srv.headGate;
        if (head) {
          srv.headGate = null;
          await head;
        }
        return json({ accountId: l[1], folder: "INBOX", uidValidity: srv.uidValidity, total: all.length, headers: all, nextBefore: paging?.nextBefore ?? null, stale: false });
      }
      return json({ code: "unavailable" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const push = (over: Partial<WsMailChanged> & Pick<WsMailChanged, "accountId">) =>
  act(() => {
    channel.push?.({
      type: "mail.changed",
      cause: "inbox",
      unread: null,
      watch: "idle",
      at: "2026-10-08T10:00:00.000Z",
      ...over,
    });
  });

function nav() {
  return render(<MailNavItem label="Mail" className="nav-icon-action" active={false} onClick={() => {}} />);
}
const badge = () => document.querySelector('[data-ui="mail-unread-badge"]');

test("the Mail entry shows the server's INBOX total as a number badge and names it for assistive tech", async () => {
  nav();
  await waitFor(() => expect(badge()?.textContent).toBe("3"));
  const button = screen.getByRole("button", { name: "Mail · 3 unread" });
  expect(button.getAttribute("data-ui")).toBe("navigate-view");
  expect(badge()?.getAttribute("aria-hidden")).toBe("true");
});

test("no badge at zero unread, and 99+ beyond 99", async () => {
  srv.summary = [{ accountId: A1, unread: 0, watch: "idle" }];
  nav();
  await waitFor(() => expect(srv.calls).toContain("GET /api/mail/unread"));
  expect(badge()).toBeNull();
  expect(screen.getByRole("button", { name: "Mail" })).toBeTruthy();
  push({ accountId: A1, unread: 150, cause: "inbox" });
  await waitFor(() => expect(badge()?.textContent).toBe("99+"));
});

test("pushes move the badge; an account that cannot log in does not count; offline keeps its last count", async () => {
  nav();
  await waitFor(() => expect(badge()?.textContent).toBe("3"));
  push({ accountId: A1, unread: 5 });
  await waitFor(() => expect(badge()?.textContent).toBe("6"));
  push({ accountId: A2, unread: 1, watch: "auth_failed", cause: "state" });
  await waitFor(() => expect(badge()?.textContent).toBe("5"));
  push({ accountId: A1, unread: 5, watch: "offline", cause: "state" });
  expect(badge()?.textContent).toBe("5");
  push({ accountId: A2, unread: 1, watch: "idle", cause: "state" });
  await waitFor(() => expect(badge()?.textContent).toBe("6"));
});

test("zh-CN: the accessible name reads in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  render(<MailNavItem label="邮件" className="nav-icon-action" active={false} onClick={() => {}} />);
  await waitFor(() => screen.getByRole("button", { name: "邮件 · 3 封未读" }));
});

test("the live channel is released when the Mail entry unmounts", async () => {
  const view = nav();
  await waitFor(() => expect(channel.subscribers).toBe(1));
  view.unmount();
  expect(channel.subscribers).toBe(0);
});

test("a reconnect refetches the picture", async () => {
  nav();
  await waitFor(() => expect(badge()?.textContent).toBe("3"));
  srv.summary = [
    { accountId: A1, unread: 9, watch: "idle" },
    { accountId: A2, unread: 1, watch: "idle" },
  ];
  await act(async () => {
    channel.resync?.(); // a hello after the first picture is a reconnect
  });
  await waitFor(() => expect(badge()?.textContent).toBe("10"));
});

// ---- the Mail page and the badge agree -----------------------------------------------

function both() {
  return render(
    <>
      <MailNavItem label="Mail" className="nav-icon-action" active={false} onClick={() => {}} />
      <MailView />
    </>
  );
}
const folderCount = (key: string) => {
  const el = document.querySelector(`[data-ui="mail-folder"][data-ui-key="${key}"] .mail-count`);
  return el ? Number(el.textContent) : 0;
};
const rowSubjects = () => [...document.querySelectorAll('[data-ui="mail-message-row"]')].map((r) => r.textContent ?? "");

test("a push reloads the folder tree and the visible INBOX list, and the badge equals the 'All inboxes' count", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  await waitFor(() => expect(folderCount("unified")).toBe(3));
  expect(badge()?.textContent).toBe("3");

  // Mail arrives in Work's INBOX on the server.
  srv.inbox[A1]?.headers.unshift(header(4));
  srv.summary = [
    { accountId: A1, unread: 3, watch: "idle" },
    { accountId: A2, unread: 1, watch: "idle" },
  ];
  push({ accountId: A1, unread: 3, cause: "inbox" });
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Subject 4"))).toBe(true));
  await waitFor(() => expect(folderCount("unified")).toBe(4));
  expect(folderCount(`${A1}:INBOX`)).toBe(3);
  expect(badge()?.textContent).toBe("4");
  // The reload was silent: the list never went back to a loading state in between.
  expect(document.querySelector('[data-ui="mail-message-list"] [aria-busy="true"]')).toBeNull();

  // Another client reads a message: only flags change.
  const h = srv.inbox[A1]?.headers.find((x) => x.uid === 3);
  if (h) h.unread = false;
  push({ accountId: A1, unread: 2, cause: "flags" });
  await waitFor(() => expect(folderCount("unified")).toBe(3));
  expect(badge()?.textContent).toBe("3");
});

test("a burst of pushes reloads once; state-only pushes do not reload the lists", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  const count = () => srv.calls.filter((c) => c === `GET /api/mail/accounts/${A1}/folders`).length;
  const before = count();
  push({ accountId: A1, unread: 2, cause: "state", watch: "offline" });
  await new Promise((r) => setTimeout(r, 400));
  expect(count()).toBe(before);
  for (let i = 0; i < 5; i++) push({ accountId: A1, unread: 2, cause: "inbox" });
  await waitFor(() => expect(count()).toBe(before + 1));
  await new Promise((r) => setTimeout(r, 400));
  expect(count()).toBe(before + 1);
});

test("an account whose login the server refuses leaves both the 'All inboxes' count and the badge", async () => {
  srv.inbox[A2] = { headers: [header(5)], authFailed: true };
  srv.summary = [
    { accountId: A1, unread: 2, watch: "idle" },
    { accountId: A2, unread: null, watch: "auth_failed" },
  ];
  both();
  await waitFor(() => expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).not.toBeNull());
  await waitFor(() => expect(folderCount("unified")).toBe(2));
  expect(badge()?.textContent).toBe("2");
});

test("a reload that fails in passing keeps what is on screen", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  srv.inbox[A1] = { headers: [], authFailed: false };
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).includes(`/accounts/${A1}/`)) return json({ code: "timeout", detail: "x" }, 502);
    return original(input, init);
  }));
  push({ accountId: A1, unread: 2, cause: "inbox" });
  await new Promise((r) => setTimeout(r, 500));
  expect(rowSubjects().length).toBe(4);
  expect(document.querySelector('[data-ui="mail-list-error"]')).toBeNull();
});

test("the first picture merges with a push that overtook it instead of being thrown away", async () => {
  let release: () => void = () => {};
  srv.unreadGate = new Promise<void>((r) => {
    release = r;
  });
  nav();
  await waitFor(() => expect(srv.calls).toContain("GET /api/mail/unread"));
  push({ accountId: A1, unread: 9 }); // arrives while the summary (A1: 2, A2: 1) is still in flight
  await waitFor(() => expect(badge()?.textContent).toBe("9"));
  release();
  // The summary's Home count is kept, and Work keeps the newer pushed number.
  await waitFor(() => expect(badge()?.textContent).toBe("10"));
});

test("a hello right after the first picture is a real reconnect: the Mail page reloads (not swallowed)", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  const count = () => srv.calls.filter((c) => c === `GET /api/mail/accounts/${A1}/folders`).length;
  const before = count();
  await act(async () => {
    channel.resync?.();
  });
  await waitFor(() => expect(count()).toBe(before + 1));
});

test("a reconnect does not log into an account whose login was refused", async () => {
  srv.inbox[A2] = { headers: [header(5)], authFailed: true };
  srv.summary = [
    { accountId: A1, unread: 2, watch: "idle" },
    { accountId: A2, unread: null, watch: "auth_failed" },
  ];
  both();
  await waitFor(() => expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).not.toBeNull());
  const count = (id: string) => srv.calls.filter((c) => c === `GET /api/mail/accounts/${id}/folders`).length;
  const [a1, a2] = [count(A1), count(A2)];
  await act(async () => {
    channel.resync?.();
  });
  await waitFor(() => expect(count(A1)).toBe(a1 + 1));
  await new Promise((r) => setTimeout(r, 400));
  expect(count(A2)).toBe(a2);
});

test("the server saying an account cannot log in updates the tree and the unified list at once", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).toBeNull();
  push({ accountId: A1, unread: 2, cause: "state", watch: "auth_failed" });
  await waitFor(() => expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).not.toBeNull());
  await waitFor(() => expect(rowSubjects().every((t) => !t.includes("Work"))).toBe(true));
  expect(folderCount("unified")).toBe(1);
  expect(badge()?.textContent).toBe("1");
});

test("a live refresh across a UIDVALIDITY change replaces the list instead of mixing epochs", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  // The mailbox was recreated: new epoch, different messages that reuse low UIDs.
  srv.uidValidity = 8;
  srv.inbox[A1] = { headers: [header(5, true), header(4, true)] };
  srv.inbox[A1]?.headers.forEach((h, i) => {
    h.subject = `Epoch8 ${i}`;
  });
  srv.summary = [
    { accountId: A1, unread: 2, watch: "idle" },
    { accountId: A2, unread: 1, watch: "idle" },
  ];
  push({ accountId: A1, unread: 2, cause: "inbox" });
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Epoch8 0"))).toBe(true));
  const work = rowSubjects().filter((t) => t.includes("Work"));
  // Old-epoch UID 3 ("Subject 3") must not survive next to the new epoch's messages.
  expect(work).toHaveLength(2);
  expect(rowSubjects().some((t) => t.includes("Subject 3"))).toBe(false);
});

test("a live refresh never discards a page the user asked for, and nothing sticks in loading", async () => {
  let open: () => void = () => {};
  srv.inbox[A1] = { headers: [header(13), header(12), header(11, false)] };
  srv.paging[A1] = { nextBefore: 11, older: [header(7, false), header(6, false)] };
  srv.paging[A1].older[0].subject = "Older seven";
  srv.paging[A1].older[1].subject = "Older six";
  both();
  await waitFor(() => expect(document.querySelector('[data-ui="mail-load-more"]')).not.toBeNull());
  srv.olderGate = new Promise<void>((r) => {
    open = r;
  });
  const more = document.querySelector('[data-ui="mail-load-more"]') as HTMLElement;
  await act(async () => {
    more.click();
  });
  // While that page is on its way, mail arrives and the live refresh is triggered.
  srv.inbox[A1]?.headers.unshift(header(14));
  push({ accountId: A1, unread: 3, cause: "inbox" });
  await new Promise((r) => setTimeout(r, 450));
  open();
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Older seven"))).toBe(true));
  // The deferred live refresh ran after the user's load and brought the new mail without losing the page.
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Subject 14"))).toBe(true));
  expect(rowSubjects().some((t) => t.includes("Older seven"))).toBe(true);
  expect(document.querySelector('[data-ui="mail-load-more"][aria-busy="true"]')).toBeNull();
  expect(document.querySelector('[data-ui="mail-load-more"]')?.textContent ?? "").not.toMatch(/…/);
});

test("a push saying a refused account is watched again brings it back into the tree, the list and the badge", async () => {
  srv.inbox[A2] = { headers: [header(5)], authFailed: true };
  srv.summary = [
    { accountId: A1, unread: 2, watch: "idle" },
    { accountId: A2, unread: null, watch: "auth_failed" },
  ];
  both();
  await waitFor(() => expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).not.toBeNull());
  expect(badge()?.textContent).toBe("2");
  // The password was fixed (elsewhere): the server logs in again and says so.
  srv.inbox[A2] = { headers: [header(5)] };
  push({ accountId: A2, unread: 1, cause: "state", watch: "idle" });
  await waitFor(() => expect(document.querySelector('[data-ui="mail-account-auth-failed"]')).toBeNull());
  await waitFor(() => expect(folderCount("unified")).toBe(3));
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Home"))).toBe(true));
  expect(badge()?.textContent).toBe("3");
});

test("a live refresh that 'load more' overtook is run again afterwards", async () => {
  let release: () => void = () => {};
  srv.inbox[A1] = { headers: [header(13), header(12), header(11, false)] };
  srv.paging[A1] = { nextBefore: 11, older: [header(7, false), header(6, false)] };
  srv.paging[A1].older[0].subject = "Older seven";
  both();
  await waitFor(() => expect(document.querySelector('[data-ui="mail-load-more"]')).not.toBeNull());
  srv.headGate = new Promise<void>((r) => {
    release = r;
  });
  srv.inbox[A1]?.headers.unshift(header(14));
  push({ accountId: A1, unread: 3, cause: "inbox" });
  await waitFor(() => expect(srv.headGate).toBeNull()); // the live request is in flight (held)
  const more = document.querySelector('[data-ui="mail-load-more"]') as HTMLElement;
  await act(async () => {
    more.click();
  });
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Older seven"))).toBe(true));
  release(); // the held live response arrives after the user's page: it was superseded
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Subject 14"))).toBe(true));
  expect(rowSubjects().some((t) => t.includes("Older seven"))).toBe(true);
});

test("pushes during a running reload cause exactly one more reload, not one each", async () => {
  both();
  await waitFor(() => expect(rowSubjects().length).toBe(4));
  const count = () => srv.calls.filter((c) => c === `GET /api/mail/accounts/${A1}/folders`).length;
  const before = count();
  let release: () => void = () => {};
  srv.folderGate = new Promise<void>((r) => {
    release = r;
  });
  push({ accountId: A1, unread: 2, cause: "inbox" });
  await waitFor(() => expect(count()).toBe(before + 1)); // in flight, held
  for (let i = 0; i < 4; i++) push({ accountId: A1, unread: 2, cause: "flags" });
  await new Promise((r) => setTimeout(r, 400));
  expect(count()).toBe(before + 1); // nothing overlaps while it runs
  release();
  await waitFor(() => expect(count()).toBe(before + 2));
  await new Promise((r) => setTimeout(r, 500));
  expect(count()).toBe(before + 2);
});

test("an older folder response never overwrites the tree a newer request produced", async () => {
  both();
  await waitFor(() => expect(folderCount(`${A1}:INBOX`)).toBe(2));
  let release: () => void = () => {};
  srv.folderGate = new Promise<void>((r) => {
    release = r;
  });
  // The first (held) response is a snapshot taken now: Work has 2 unread.
  push({ accountId: A1, unread: 2, cause: "inbox" });
  await waitFor(() => expect(srv.folderGate).toBeNull());
  // Meanwhile everything gets read and the user refreshes: that newer response says 0.
  for (const h of srv.inbox[A1]?.headers ?? []) h.unread = false;
  srv.summary = [
    { accountId: A1, unread: 0, watch: "idle" },
    { accountId: A2, unread: 1, watch: "idle" },
  ];
  await act(async () => {
    (document.querySelector('[data-ui="mail-refresh"]') as HTMLElement).click();
  });
  await waitFor(() => expect(folderCount(`${A1}:INBOX`)).toBe(0));
  release();
  await new Promise((r) => setTimeout(r, 300));
  expect(folderCount(`${A1}:INBOX`)).toBe(0);
});
