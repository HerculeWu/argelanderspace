// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailAccount, MailHeader, MailMessage } from "@argelanderspace/contracts";
import { MailView } from "../src/mail/MailView";
import { MAIL_FRAME_SANDBOX } from "../src/mail/sanitize";
import i18n from "../src/i18n";

const acct = (id: string, name: string, over: Partial<MailAccount> = {}): MailAccount => ({
  id,
  displayName: name,
  address: `${name.toLowerCase()}@example.test`,
  preset: "custom",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: "u",
  smtpUser: "u",
  credentialRef: id as MailAccount["credentialRef"],
  credentialProtection: "keychain",
  ...over,
});
const A1 = "acc-aaaaaaaaaaaa";
const A2 = "acc-bbbbbbbbbbbb";

const header = (uid: number, over: Partial<MailHeader> = {}): MailHeader => ({
  uid,
  date: `2026-10-0${Math.min(uid, 9)}T10:00:00.000Z`,
  from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
  to: [{ name: "", address: "me@example.test" }],
  subject: `Subject ${uid}`,
  unread: true,
  starred: false,
  hasAttachments: false,
  size: 100,
  ...over,
});
const message = (accountId: string, uid: number, over: Partial<MailMessage> = {}): MailMessage => ({
  accountId: accountId as MailMessage["accountId"],
  folder: "INBOX",
  uid,
  uidValidity: 7,
  messageId: null,
  subject: `Subject ${uid}`,
  date: "2026-10-05T10:00:00.000Z",
  from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
  to: [{ name: "", address: "me@example.test" }],
  cc: [],
  replyTo: [],
  text: `Plain body ${uid}`,
  html: null,
  attachments: [],
  ...over,
});

interface Server {
  accounts: MailAccount[];
  folders: Record<string, { code?: string; status?: number; unread: number; stale?: boolean }>;
  headers: Record<string, MailHeader[]>;
  messages: Record<string, MailMessage>;
  stale: boolean;
  calls: { method: string; url: string; body?: unknown }[];
  post: (url: string, body: unknown) => Response | null;
}
let srv: Server;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  srv = {
    accounts: [acct(A1, "Work"), acct(A2, "Home")],
    folders: { [A1]: { unread: 2 }, [A2]: { unread: 1 } },
    headers: {
      [A1]: [header(3), header(2, { unread: false, hasAttachments: true })],
      [A2]: [header(5, { date: "2026-10-09T10:00:00.000Z", subject: "Home mail" })],
    },
    messages: {},
    stale: false,
    calls: [],
    post: () => null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      srv.calls.push({ method, url, body });
      if (/\/api\/mail\/accounts\/[^/]+\/attachment\?/.test(url))
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });
      if (url === "/api/mail/accounts" && method === "GET") return json({ version: 1, rev: 4, accounts: srv.accounts });
      const f = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/folders$/);
      if (f) {
        const cfg = srv.folders[f[1] as string] ?? { unread: 0 };
        if (cfg.code) return json({ code: cfg.code, detail: "x" }, cfg.status ?? 502);
        return json({
          accountId: f[1],
          stale: cfg.stale === true,
          folders: [
            { path: "INBOX", name: "INBOX", role: "inbox", depth: 0, selectable: true, unread: cfg.unread, total: 10 },
            { path: "Sent", name: "Sent", role: "sent", depth: 0, selectable: true, unread: 0, total: 3 },
            { path: "Projects/Euclid", name: "Euclid", role: "custom", depth: 1, selectable: true, unread: 0, total: 1 },
          ],
        });
      }
      const l = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/messages\?(.*)$/);
      if (l) {
        const q = new URLSearchParams(l[2]);
        const all = srv.headers[l[1] as string] ?? [];
        const before = q.get("before");
        const page = before ? all.filter((h) => h.uid < Number(before)) : all;
        return json({
          accountId: l[1],
          folder: q.get("folder"),
          uidValidity: 7,
          total: all.length,
          headers: page,
          nextBefore: null,
          stale: srv.stale,
        });
      }
      const o = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/messages\/open$/);
      if (o && method === "POST") {
        const custom = srv.post(url, body);
        if (custom) return custom;
        const m = srv.messages[`${o[1]}:${body.uid}`] ?? message(o[1] as string, body.uid);
        return json({ message: m, seen: true, stale: false });
      }
      const custom = srv.post(url, body);
      if (custom) return custom;
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
const row = (acc: string, uid: number) => ui("mail-message-row", `${acc}:INBOX:${uid}`)!;

test("unified inbox merges accounts newest first, shows account names and unread counts", async () => {
  render(<MailView />);
  await screen.findByText("Home mail");
  const rows = [...document.querySelectorAll('[data-ui="mail-message-row"]')].map((r) => r.textContent ?? "");
  expect(rows[0]).toContain("Home mail");
  expect(rows[0]).toContain("Home"); // account name in unified view
  expect(rows).toHaveLength(3);
  expect(within(ui("mail-folder", "unified")!).getByLabelText("3 unread")).toBeTruthy();
  expect(within(ui("mail-folder", `${A1}:INBOX`)!).getByLabelText("2 unread")).toBeTruthy();
  expect(ui("mail-folder", `${A1}:Projects/Euclid`)).toBeTruthy();
  expect(row(A1, 2).querySelector('[aria-label="Has attachments"]')).toBeTruthy();
  expect(row(A1, 2).className).not.toContain("unread");
  expect(row(A1, 3).className).toContain("unread");
});

test("opening an unread message asks the server to set \\Seen, shows the body and updates counts", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(row(A1, 3));
  await screen.findByText("Plain body 3");
  const open = srv.calls.find((c) => c.url.endsWith("/messages/open"))!;
  expect(open.method).toBe("POST");
  expect(open.body).toEqual({ folder: "INBOX", uid: 3, uidValidity: 7, unread: true });
  await waitFor(() => expect(row(A1, 3).className).not.toContain("unread"));
  expect(within(ui("mail-folder", `${A1}:INBOX`)!).getByLabelText("1 unread")).toBeTruthy();
  expect(ui("mail-text-body")!.textContent).toBe("Plain body 3");
  // an already read message does not claim to be unread
  fireEvent.click(row(A1, 2));
  await waitFor(() => expect(srv.calls.filter((c) => c.url.endsWith("/messages/open")).length).toBe(2));
  expect(srv.calls.filter((c) => c.url.endsWith("/messages/open"))[1]!.body).toMatchObject({ uid: 2, unread: false });
});

test("a text body is rendered as text, never as markup", async () => {
  srv.messages[`${A1}:3`] = message(A1, 3, { text: "<img src=x onerror=alert(1)><b>bold</b>" });
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(row(A1, 3));
  await waitFor(() => expect(ui("mail-text-body")!.textContent).toBe("<img src=x onerror=alert(1)><b>bold</b>"));
  expect(ui("mail-text-body")!.querySelector("img,b")).toBeNull();
});

const HTML =
  '<p>Hello</p><script>alert(1)</script><img src="https://track.test/p.gif"><img src="cid:logo"><form action="https://evil.test"><input name=x></form><a href="https://ok.test/">link</a>';
const htmlMessage = () =>
  message(A1, 3, {
    html: HTML,
    attachments: [
      { part: 0, filename: "logo.png", contentType: "image/png", size: 8, contentId: "logo", inline: true },
      { part: 1, filename: "report.pdf", contentType: "application/pdf", size: 2048, contentId: null, inline: false },
    ],
  });

test("HTML mail: sandboxed frame, CSP, no script/form, remote content blocked until loaded for this message", async () => {
  srv.messages[`${A1}:3`] = htmlMessage();
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(row(A1, 3));
  const frame = (await waitFor(() => {
    const f = ui("mail-html-frame");
    expect(f).toBeTruthy();
    return f;
  })) as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe(MAIL_FRAME_SANDBOX);
  const blocked = frame.getAttribute("srcdoc")!;
  expect(blocked).toContain("Content-Security-Policy");
  expect(blocked).not.toMatch(/<script|<form|<input|track\.test|evil\.test/);
  // the cid image becomes a data: URI (the sandboxed frame cannot fetch from the app itself)
  await waitFor(() => expect(ui("mail-html-frame")!.getAttribute("srcdoc")).toContain("data:image/png;base64,iVBORw=="));
  expect(ui("mail-html-frame")!.getAttribute("srcdoc")).not.toContain("/api/mail/");
  expect(blocked).toMatch(/img-src data: [^;]*;/);
  expect(blocked).not.toMatch(/img-src[^;]*https:/);
  const bar = ui("mail-remote-content-bar")!;
  expect(bar.textContent).toContain("Remote content blocked");
  fireEvent.click(within(bar).getByRole("button", { name: "Load remote content" }));
  await waitFor(() => expect(ui("mail-html-frame")!.getAttribute("srcdoc")).toContain("https://track.test/p.gif"));
  const loaded = ui("mail-html-frame")!.getAttribute("srcdoc")!;
  expect(loaded).toMatch(/img-src[^;]*https:/);
  expect(loaded).not.toMatch(/<script|<form/);
  expect(ui("mail-remote-content-bar")!.textContent).toContain("Remote content loaded");
  // only for that message: opening another one does not inherit it
  fireEvent.click(row(A1, 2));
  await screen.findByText("Plain body 2");
});

test("attachments are listed as downloads (inline images too)", async () => {
  srv.messages[`${A1}:3`] = htmlMessage();
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(row(A1, 3));
  const list = await waitFor(() => {
    const l = ui("mail-attachments");
    expect(l).toBeTruthy();
    return l!;
  });
  const files = list.querySelectorAll('[data-ui="mail-attachment"]');
  expect(files).toHaveLength(2); // the inline cid image stays downloadable
  expect(within(list).getByRole("link", { name: "Download logo.png" })).toBeTruthy();
  const link = within(list).getByRole("link", { name: "Download report.pdf" }) as HTMLAnchorElement;
  expect(link.getAttribute("download")).toBe("report.pdf");
  expect(link.href).toContain("/api/mail/accounts/acc-aaaaaaaaaaaa/attachment?");
  expect(link.href).toContain("part=1");
  expect(link.href).not.toContain("inline=1");
});

test("a failed open shows a readable reason and can be retried", async () => {
  let fail = true;
  srv.post = (url) => (fail && url.endsWith("/messages/open") ? json({ code: "message_not_found" }, 404) : null);
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(row(A1, 3));
  const err = await waitFor(() => {
    const e = ui("mail-open-error");
    expect(e).toBeTruthy();
    return e!;
  });
  expect(err.textContent).toContain("no longer on the server");
  fail = false;
  fireEvent.click(within(err).getByRole("button", { name: "Retry" }));
  await screen.findByText("Plain body 3");
});

test("a rejected password is flagged on the account, which drops out of the unified inbox", async () => {
  srv.folders[A2] = { code: "auth_failed", unread: 0 };
  render(<MailView />);
  await screen.findByText("Subject 3");
  const flag = await waitFor(() => {
    const f = ui("mail-account-auth-failed");
    expect(f).toBeTruthy();
    return f!;
  });
  expect(flag.getAttribute("role")).toBe("alert");
  expect(screen.queryByText("Home mail")).toBeNull();
  fireEvent.click(within(flag).getByRole("button", { name: "Re-enter password" }));
  expect(await screen.findByText(/Enter the new password for home@example.test/)).toBeTruthy();
});

test("a file-stored password is marked on its account for good", async () => {
  srv.accounts = [acct(A1, "Work", { credentialProtection: "file" })];
  render(<MailView />);
  const flag = await waitFor(() => {
    const f = ui("mail-account-file-store");
    expect(f).toBeTruthy();
    return f!;
  });
  expect(flag.textContent).toContain("Password in local file");
});

test("stale lists say so", async () => {
  srv.stale = true;
  render(<MailView />);
  await screen.findByText("Subject 3");
  expect(ui("mail-stale-notice")!.textContent).toContain("last saved copy");
});

test("add account: keychain unavailable needs explicit consent before the file fallback is requested", async () => {
  srv.accounts = [];
  const posts: unknown[] = [];
  srv.post = (url, body) => {
    if (url !== "/api/mail/accounts") return null;
    posts.push(body);
    if (!(body as { fileFallbackConsent?: boolean }).fileFallbackConsent)
      return json({ code: "keychain_unavailable", detail: "x" }, 422);
    srv.accounts = [acct("acc-cccccccccccc", "Gmail", { credentialProtection: "file", preset: "gmail" })];
    return json({ rev: 5, account: srv.accounts[0] }, 201);
  };
  render(<MailView />);
  await waitFor(() => expect(ui("mail-empty")).toBeTruthy());
  fireEvent.click(ui("mail-add-account")!);
  fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
  fireEvent.change(ui("mail-account-email")!, { target: { value: "me@gmail.com" } });
  fireEvent.change(ui("mail-account-password")!, { target: { value: "synthetic-app-password" } });
  const submit = () => ui("mail-add-account-submit") as HTMLButtonElement;
  fireEvent.click(submit());
  await waitFor(() => expect(ui("mail-keychain-fallback")).toBeTruthy());
  expect(posts).toHaveLength(1);
  expect(submit().disabled).toBe(true); // consent still missing
  fireEvent.click(ui("mail-keychain-consent")!);
  expect(submit().disabled).toBe(false);
  fireEvent.click(submit());
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toMatchObject({ preset: "gmail", address: "me@gmail.com", fileFallbackConsent: true });
  await waitFor(() => expect(ui("mail-add-account-dialog")).toBeNull());
  await waitFor(() => expect(ui("mail-account-file-store")).toBeTruthy());
});

test("add account: a failed login test is explained per protocol and the password is never echoed", async () => {
  srv.accounts = [];
  srv.post = (url) =>
    url === "/api/mail/accounts"
      ? json(
          {
            code: "connection_failed",
            detail: "x",
            test: {
              imap: { ok: false, code: "auth_failed", detail: "d" },
              smtp: { ok: false, code: "timeout", detail: "d" },
            },
          },
          422
        )
      : null;
  render(<MailView />);
  await waitFor(() => expect(ui("mail-empty")).toBeTruthy());
  fireEvent.click(ui("mail-add-account")!);
  fireEvent.click(await screen.findByRole("button", { name: "University of Bonn" }));
  fireEvent.change(ui("mail-account-email")!, { target: { value: "me@uni-bonn.de" } });
  fireEvent.change(ui("mail-account-password")!, { target: { value: "synthetic-secret-pw" } });
  fireEvent.click(ui("mail-add-account-submit")!);
  const t = await waitFor(() => {
    const e = ui("mail-add-account-test");
    expect(e).toBeTruthy();
    return e!;
  });
  expect(t.textContent).toContain("IMAP: The server rejected the user name or password");
  expect(t.textContent).toContain("SMTP: The server did not respond in time");
  expect(t.textContent).toContain("Nothing was saved");
  expect(document.body.textContent).not.toContain("synthetic-secret-pw");
  expect((ui("mail-account-password") as HTMLInputElement).type).toBe("password");
});

test("load more pages older messages", async () => {
  srv.accounts = [acct(A1, "Work")];
  const headers = [header(9), header(8)];
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (/\/messages\?/.test(url)) {
      const q = new URLSearchParams(url.split("?")[1]);
      srv.calls.push({ method: "GET", url });
      const first = !q.get("before");
      return json({
        accountId: A1,
        folder: "INBOX",
        uidValidity: 7,
        total: 3,
        headers: first ? headers : [header(1)],
        nextBefore: first ? 8 : null,
        stale: false,
      });
    }
    return orig(input, init);
  }));
  render(<MailView />);
  await screen.findByText("Subject 9");
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await screen.findByText("Subject 1");
  expect(srv.calls.some((c) => c.url.includes("before=8"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("folders served from the cache say so on the account", async () => {
  srv.folders[A1] = { unread: 2, stale: true };
  render(<MailView />);
  const flag = await waitFor(() => {
    const f = ui("mail-account-stale");
    expect(f).toBeTruthy();
    return f!;
  });
  expect(flag.textContent).toContain("last saved copy");
});

test("an unreachable account is marked and can be retried", async () => {
  srv.folders[A2] = { code: "connection_refused", unread: 0 };
  render(<MailView />);
  const flag = await waitFor(() => {
    const f = ui("mail-account-offline");
    expect(f).toBeTruthy();
    return f!;
  });
  expect(flag.textContent).toContain("refused or dropped");
  srv.folders[A2] = { unread: 1 };
  fireEvent.click(within(flag).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(ui("mail-account-offline")).toBeNull());
});

test("re-entering a rejected password sends the account's own settings with the new password", async () => {
  srv.folders[A2] = { code: "auth_failed", unread: 0 };
  const puts: { url: string; body: Record<string, unknown> }[] = [];
  srv.post = (url, body) => {
    if (!url.endsWith(`/accounts/${A2}`)) return null;
    puts.push({ url, body: body as Record<string, unknown> });
    srv.folders[A2] = { unread: 1 };
    return json({ rev: 5, account: srv.accounts[1] });
  };
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) =>
    init?.method === "PUT" ? (srv.post(String(u), JSON.parse(String(init.body))) as Response) : orig(u, init)));
  render(<MailView />);
  const reenter = await waitFor(() => {
    const b = ui("mail-account-reenter");
    expect(b).toBeTruthy();
    return b!;
  });
  fireEvent.click(reenter);
  fireEvent.change(await waitFor(() => ui("mail-account-password")!), { target: { value: "new-synthetic-pw" } });
  fireEvent.click(ui("mail-reenter-password-submit")!);
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]!.body).toMatchObject({ rev: 4, address: "home@example.test", password: "new-synthetic-pw", preset: "custom" });
  await waitFor(() => expect(ui("mail-reenter-password-dialog")).toBeNull());
  await waitFor(() => expect(ui("mail-account-auth-failed")).toBeNull());
});

test("account menu: Escape closes it and returns focus; removing needs the confirm dialog and sends the rev", async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      calls.push(String(u));
      srv.accounts = srv.accounts.filter((a) => a.id !== A2);
      return json({ rev: 5, warnings: [] });
    }
    return orig(u, init);
  }));
  render(<MailView />);
  await screen.findByText("Subject 3");
  const trigger = ui("mail-account-menu", A2) as HTMLElement;
  fireEvent.click(trigger);
  expect(ui("mail-account-menu-list")).toBeTruthy();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(ui("mail-account-remove"));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(ui("mail-account-menu-list")).toBeNull());
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  fireEvent.click(ui("mail-account-remove")!);
  const dlg = await waitFor(() => {
    const d = ui("mail-remove-account-dialog");
    expect(d).toBeTruthy();
    return d!;
  });
  expect(dlg.textContent).toContain("Messages on the server are not affected");
  expect(calls).toEqual([]); // nothing until confirmed
  fireEvent.click(ui("mail-remove-account-confirm")!);
  await waitFor(() => expect(calls).toEqual([`/api/mail/accounts/${A2}?rev=4`]));
  await waitFor(() => expect(ui("mail-account", A2)).toBeNull());
});

test("the Copilot page report: complete once the lists loaded, carries the open message, and is not republished on every render", async () => {
  const reports: (import("@argelanderspace/contracts").MailPage | null)[] = [];
  render(<MailView paneId={1} onContext={(_pane, page) => reports.push(page)} />);
  await screen.findByText("Subject 3");
  await waitFor(() => expect(reports[reports.length - 1]?.phase).toBe("ready"));
  fireEvent.click(row(A1, 3));
  await screen.findByText("Plain body 3");
  await waitFor(() => {
    const open = reports[reports.length - 1]?.open;
    expect(open?.status === "ok" && open.text).toBe("Plain body 3");
  });
  const settled = reports.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(reports.length).toBe(settled);
  expect(settled).toBeLessThan(25);
  expect(reports[reports.length - 1]?.untrusted).toBe(true);
});
