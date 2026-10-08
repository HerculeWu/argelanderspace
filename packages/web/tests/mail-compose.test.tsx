// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailAccount, MailHeader, MailMessage, MailSendStatus } from "@argelanderspace/contracts";
import { MailView } from "../src/mail/MailView";
import i18n from "../src/i18n";

const A1 = "acc-aaaaaaaaaaaa";
const SEND_RE = /\/api\/mail\/compose\/accounts\/([^/]+)\/send$/;
const acct = (over: Partial<MailAccount> = {}): MailAccount => ({
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
  ...over,
});
const header = (uid: number): MailHeader => ({
  uid,
  date: "2026-10-05T10:00:00.000Z",
  from: { name: "Ada", address: "ada@example.test" },
  to: [{ name: "", address: "work@example.test" }],
  subject: `Subject ${uid}`,
  unread: false,
  starred: false,
  hasAttachments: false,
  size: 100,
});
const message = (uid: number, folder = "INBOX"): MailMessage => ({
  accountId: A1 as MailMessage["accountId"],
  folder,
  uid,
  uidValidity: 7,
  messageId: "m@example.test",
  subject: `Subject ${uid}`,
  date: "2026-10-05T10:00:00.000Z",
  from: { name: "Ada", address: "ada@example.test" },
  to: [{ name: "", address: "work@example.test" }],
  cc: [],
  replyTo: [],
  text: `Plain body ${uid}`,
  html: null,
  attachments: [],
});
const status = (over: Partial<MailSendStatus> = {}): MailSendStatus => ({
  sendId: "00000000-0000-4000-8000-000000000001",
  accountId: A1 as MailSendStatus["accountId"],
  messageId: "<d@example.test>",
  subject: "Hello",
  state: "pending",
  remainingMs: 8000,
  code: null,
  sentCopy: null,
  draftKept: true,
  rejected: 0,
  ownedElsewhere: false,
  ...over,
});

interface Call {
  method: string;
  url: string;
  body?: any;
}
interface Server {
  account: MailAccount;
  calls: Call[];
  outbox: MailSendStatus[];
  sendResult: () => Response;
  undoResult: (sendId: string) => Response;
  discardResult: () => Response;
  statusFor: (sendId: string) => MailSendStatus | null;
  statusSeq: MailSendStatus[];
  uploadSize: number;
  initDraft: Record<string, unknown>;
}
let srv: Server;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const ui = (id: string, key?: string) =>
  document.querySelector<HTMLElement>(`[data-ui="${id}"]${key ? `[data-ui-key="${key}"]` : ""}`);
const calls = (re: RegExp, method?: string) => srv.calls.filter((c) => re.test(c.url) && (!method || c.method === method));

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  srv = {
    account: acct(),
    calls: [],
    outbox: [],
    sendResult: () => json(status({ remainingMs: 8000 }), 202),
    undoResult: (id) => json(status({ sendId: id, state: "cancelled", remainingMs: null })),
    discardResult: () => json({ ok: true }),
    statusFor: () => null,
    statusSeq: [],
    uploadSize: 1000,
    initDraft: {
      messageId: "<reply-1@example.test>",
      inReplyTo: "<m@example.test>",
      references: ["<m@example.test>"],
      to: "Ada <ada@example.test>",
      cc: "",
      bcc: "",
      subject: "Re: Subject 3",
      text: "\n\nOn 2026-10-05, Ada wrote:\n> Plain body 3\n",
      attachments: [],
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body = typeof raw === "string" ? JSON.parse(raw) : undefined;
      srv.calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
      if (url === "/api/mail/accounts") return json({ version: 1, rev: 4, accounts: [srv.account] });
      if (url.endsWith("/folders"))
        return json({
          accountId: A1,
          stale: false,
          folders: [
            { path: "INBOX", name: "INBOX", role: "inbox", depth: 0, selectable: true, unread: 0, total: 3 },
            { path: "Drafts", name: "Drafts", role: "drafts", depth: 0, selectable: true, unread: 0, total: 1 },
          ],
        });
      if (/\/messages\?/.test(url))
        return json({ accountId: A1, folder: "INBOX", uidValidity: 7, total: 1, headers: [header(3)], nextBefore: null, stale: false });
      if (url.endsWith("/messages/open"))
        return json({ message: message(body.uid, body.folder), seen: true, stale: false });
      if (url === "/api/mail/compose/outbox") return json({ sends: srv.outbox });
      if (/\/compose\/accounts\/[^/]+\/init$/.test(url)) return json({ draft: srv.initDraft, attachments: [] });
      if (/\/compose\/accounts\/[^/]+\/draft$/.test(url) && method === "PUT")
        return json({ messageId: body.messageId, savedAt: "x", folder: "Drafts", uid: 1 });
      if (/\/draft\/discard$/.test(url)) return srv.discardResult();
      if (/\/attachments$/.test(url) && method === "POST") {
        const f = raw as File;
        return json({ id: "a".repeat(32), filename: f.name, contentType: f.type, size: srv.uploadSize }, 201);
      }
      if (SEND_RE.test(url)) {
        // Each accepted send gets its own id, as the server reports it back.
        const res = srv.sendResult();
        return res.status === 202 ? json({ ...(await res.json()), sendId: body.sendId, subject: body.draft.subject }, 202) : res;
      }
      const undoM = url.match(/\/sends\/([^/]+)\/undo$/);
      if (undoM) return srv.undoResult(undoM[1] as string);
      if (/\/sends\/[^/]+$/.test(url) && method === "GET") {
        const forId = srv.statusFor(url.split("/").pop() as string);
        if (forId) return json(forId);
        const next = srv.statusSeq.length > 1 ? srv.statusSeq.shift() : srv.statusSeq[0];
        return next ? json(next) : json({ code: "not_found" }, 404);
      }
      if (/\/sends\/[^/]+$/.test(url) && method === "DELETE") return json({ ok: true });
      return json({ code: "unavailable" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openMail = async () => {
  render(<MailView />);
  const row = await screen.findByText("Subject 3");
  fireEvent.click(row);
  await screen.findByText("Plain body 3");
};
const type = (id: string, value: string) => fireEvent.change(ui(id)!, { target: { value } });

test("Write opens an empty composer; typing saves it to the server Drafts after a pause, and not before", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  await waitFor(() => expect(ui("mail-compose")!.hasAttribute("disabled")).toBe(false));
  fireEvent.click(ui("mail-compose")!);
  expect(ui("mail-composer")).toBeTruthy();
  expect(ui("mail-composer-draft-state")!.textContent).toBe("");
  expect(calls(/\/draft$/, "PUT")).toHaveLength(0); // an untouched composer saves nothing
  type("mail-composer-to", "ada@example.test");
  type("mail-composer-subject", "Hello");
  expect(calls(/\/draft$/, "PUT")).toHaveLength(0); // debounced
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1), { timeout: 4000 });
  const put = calls(/\/draft$/, "PUT")[0]!;
  expect(put.body).toMatchObject({ to: "ada@example.test", subject: "Hello" });
  expect(put.body.messageId).toMatch(/^<[0-9a-f-]{36}@example\.test>$/);
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved to server Drafts/));
}, 10000);

test("Reply asks the server for the threaded draft and puts the cursor above the quote", async () => {
  await openMail();
  fireEvent.click(ui("mail-reply")!);
  await waitFor(() => expect(ui("mail-composer")).toBeTruthy());
  const init = calls(/\/init$/)[0]!;
  expect(init.body).toEqual({ mode: "reply", folder: "INBOX", uid: 3, uidValidity: 7, locale: "en" });
  expect((ui("mail-composer-to") as HTMLInputElement).value).toBe("Ada <ada@example.test>");
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Re: Subject 3");
  const body = ui("mail-composer-body") as HTMLTextAreaElement;
  expect(body.value).toContain("> Plain body 3");
  expect(ui("mail-reply")!.hasAttribute("disabled")).toBe(true); // one composer at a time
});

test("in the Drafts folder the reader offers Edit draft instead of reply and forward", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-folder", `${A1}:Drafts`)!);
  const row = await screen.findByText("Subject 3");
  fireEvent.click(row);
  await screen.findByText("Plain body 3");
  expect(ui("mail-edit-draft")).toBeTruthy();
  expect(ui("mail-reply")).toBeNull();
  fireEvent.click(ui("mail-edit-draft")!);
  await waitFor(() => expect(calls(/\/init$/)[0]?.body.mode).toBe("draft"));
  await waitFor(() => expect(ui("mail-composer")).toBeTruthy());
  expect(ui("mail-composer-draft-state")!.textContent).toBe("Draft is on the server");
});

test("sending without a recipient is refused in the window and nothing is sent", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "No recipient");
  fireEvent.click(ui("mail-composer-send")!);
  expect(await screen.findByText("Add at least one recipient.")).toBeTruthy();
  expect(calls(SEND_RE)).toHaveLength(0);
});

test("Send closes the composer into the undo bar; Undo brings the text back and the server is told to cancel", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", "ada@example.test");
  type("mail-composer-subject", "Hello");
  type("mail-composer-body", "Dear Ada");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  expect(ui("mail-composer")).toBeNull();
  const send = calls(SEND_RE)[0]!;
  expect(send.body.sendId).toMatch(/^[0-9a-f-]{36}$/);
  expect(send.body.draft).toMatchObject({ to: "ada@example.test", subject: "Hello", text: "Dear Ada" });
  const bar = ui("mail-send-undo")!;
  expect(bar.textContent).toMatch(/Sending in [78]s/);
  expect(bar.textContent).toContain("Hello");
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-composer")).toBeTruthy());
  expect(calls(/\/undo$/, "POST")).toHaveLength(1);
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Dear Ada");
  expect((ui("mail-composer-to") as HTMLInputElement).value).toBe("ada@example.test");
  expect(ui("mail-send-undo")).toBeNull();
});

test("when the window runs out the bar becomes 'Sending…' and the server's answer is reported: sent", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusSeq = [status({ state: "sending", remainingMs: null }), status({ state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false })];
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", "ada@example.test");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  await waitFor(() => expect(ui("mail-send-undo")?.getAttribute("data-phase")).toBe("sending"), { timeout: 3000 });
  expect(ui("mail-send-undo-action")).toBeNull(); // no undo once it is being sent
  await waitFor(() => expect(within(ui("mail-notice")!).getByText(/^Sent: /)).toBeTruthy(), { timeout: 4000 });
  expect(ui("mail-send-undo")).toBeNull();
  expect(calls(/\/undo$/)).toHaveLength(0);
  await waitFor(() => expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(1));
}, 10000);

test("an SMTP failure puts the text back in the composer with the reason", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusSeq = [status({ state: "failed", remainingMs: null, code: "recipient_rejected" })];
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", "ada@example.test");
  type("mail-composer-body", "Keep this text");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy(), { timeout: 4000 });
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Keep this text");
  expect(within(ui("mail-composer-error")!).getByText(/refused the recipient/)).toBeTruthy();
  expect(ui("mail-send-undo")).toBeNull();
}, 10000);

test("a server restart inside the window is reported honestly: not sent, back in Drafts, with a way to open Drafts", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300, subject: "Hello" }), 202);
  srv.statusSeq = [status({ state: "interrupted", remainingMs: null })];
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", "ada@example.test");
  type("mail-composer-subject", "Hello");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy(), { timeout: 4000 });
  const notice = ui("mail-notice")!;
  expect(notice.getAttribute("data-tone")).toBe("warning");
  expect(notice.textContent).toContain("was not sent");
  expect(notice.textContent).toContain("will not be sent automatically");
  expect(ui("mail-composer")).toBeNull();
  fireEvent.click(within(notice).getByText("Open Drafts"));
  await waitFor(() => expect(ui("mail-folder", `${A1}:Drafts`)!.getAttribute("aria-current")).toBe("true"));
  // The marker stays until the user closes the notice, then it is forgotten on the server.
  expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(0);
  fireEvent.click(ui("mail-notice-close")!);
  await waitFor(() => expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(1));
  expect(ui("mail-notice")).toBeNull();
}, 10000);

test("opening Mail after a restart reports what the server still has: interrupted and unknown sends", async () => {
  srv.outbox = [
    status({ sendId: "00000000-0000-4000-8000-0000000000a1", state: "interrupted", remainingMs: null, subject: "Lost one" }),
    status({ sendId: "00000000-0000-4000-8000-0000000000a2", state: "unknown", remainingMs: null, subject: "Maybe sent", code: "outcome_unknown" }),
  ];
  render(<MailView />);
  await waitFor(() => expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(2));
  const text = [...document.querySelectorAll('[data-ui="mail-notice"]')].map((n) => n.textContent ?? "");
  expect(text[0]).toContain("“Lost one” was not sent");
  expect(text[1]).toContain("unknown whether it went out");
});

test("opening Mail inside a running window shows the countdown again", async () => {
  srv.outbox = [status({ remainingMs: 5000, subject: "Still pending" })];
  render(<MailView />);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  expect(ui("mail-send-undo")!.textContent).toContain("Still pending");
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(calls(/\/undo$/, "POST")).toHaveLength(1));
  await waitFor(() => expect(ui("mail-send-undo")).toBeNull());
  expect(within(ui("mail-notice")!).getByText(/Undone/)).toBeTruthy();
});

test("attachments over the provider's per-message limit get a visible warning (Gmail 25 MB, encoded)", async () => {
  srv.account = acct({ preset: "gmail" });
  srv.uploadSize = 22 * 1024 * 1024; // about 29 MB once encoded
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  const file = new File([new Uint8Array(10)], "thesis.pdf", { type: "application/pdf" });
  fireEvent.change(ui("mail-composer-file")!, { target: { files: [file] } });
  await waitFor(() => expect(ui("mail-composer-attachment")).toBeTruthy());
  expect(ui("mail-composer-attachment")!.textContent).toContain("thesis.pdf");
  const hint = ui("mail-composer-size")!;
  expect(hint.textContent).toContain("Gmail");
  expect(hint.textContent).toContain("25.0 MB");
  // Under the limit it is a plain summary, not a warning.
  fireEvent.click(within(ui("mail-composer-attachment")!).getByLabelText("Remove thesis.pdf"));
  await waitFor(() => expect(ui("mail-composer-attachment")).toBeNull());
  expect(calls(/\/attachments\/a+$/, "DELETE")).toHaveLength(1);
});

test("an attachment above the 40 MB per-file cap is refused in the window without uploading", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  const big = new File([new Uint8Array(10)], "huge.iso");
  Object.defineProperty(big, "size", { value: 41 * 1024 * 1024 });
  fireEvent.change(ui("mail-composer-file")!, { target: { files: [big] } });
  expect(await within(ui("mail-composer-error")!).findByText(/“huge\.iso” is too large/)).toBeTruthy();
  expect(calls(/\/attachments$/, "POST")).toHaveLength(0);
});

test("discarding a saved draft asks first and then deletes it on the server", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "To be dropped");
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1), { timeout: 4000 });
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/));
  fireEvent.click(ui("mail-composer-discard")!);
  expect(calls(/\/draft\/discard$/)).toHaveLength(0); // asks first
  fireEvent.click(await screen.findByText("Discard draft", { selector: '[data-ui="mail-composer-discard-confirm"]' }));
  await waitFor(() => expect(calls(/\/draft\/discard$/)).toHaveLength(1));
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
}, 10000);

test("the composer speaks Chinese when the interface does", async () => {
  await i18n.changeLanguage("zh-CN");
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  expect(ui("mail-composer-send")!.textContent).toBe("发送");
  expect(ui("mail-composer")!.textContent).toContain("收件人");
  expect(ui("mail-composer-attach")!.getAttribute("aria-label")).toBe("添加附件");
});


// ---- review round 1 -----------------------------------------------------------------

const compose1 = async (subject: string, to = "ada@example.test") => {
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", to);
  type("mail-composer-subject", subject);
  type("mail-composer-body", `Body of ${subject}`);
};

test("several sends can be in their window at once: each has its own countdown, undo and result", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("First");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(document.querySelectorAll('[data-ui="mail-send-undo"]')).toHaveLength(1));
  await compose1("Second");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(document.querySelectorAll('[data-ui="mail-send-undo"]')).toHaveLength(2));
  const bars = [...document.querySelectorAll('[data-ui="mail-send-undo"]')];
  expect(bars[0]!.textContent).toContain("First");
  expect(bars[1]!.textContent).toContain("Second");
  const [id1, id2] = calls(SEND_RE).map((c) => c.body.sendId as string);
  expect(id1).not.toBe(id2);
  // Undoing the first leaves the second counting down, and only the first one's text comes back.
  fireEvent.click(document.querySelector(`[data-ui="mail-send-undo-action"][data-ui-key="${id1}"]`)!);
  await waitFor(() => expect(ui("mail-composer")).toBeTruthy());
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("First");
  expect(document.querySelectorAll('[data-ui="mail-send-undo"]')).toHaveLength(1);
  expect(ui("mail-send-undo")!.textContent).toContain("Second");
  expect(calls(/\/undo$/, "POST").map((c) => c.url)).toEqual([expect.stringContaining(id1 as string)]);
});

test("a send that ends while the user is writing something else is offered, never swapped in over their text", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Sent one");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  await compose1("Typing now", "kofi@example.test");
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
  // The composer still holds the text being typed.
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Typing now");
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Typing now");
  expect(ui("mail-notice")!.textContent).toContain("Sent one");
  // Opening it saves the current one to the server first, then shows the restored one.
  fireEvent.click(ui("mail-notice-action")!);
  await waitFor(() => expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Sent one"));
  const saved = calls(/\/draft$/, "PUT").map((c) => c.body.subject);
  expect(saved).toContain("Typing now");
  expect(ui("mail-notice")).toBeNull();
});

test("undo after a server restart reports what really happened, not 'too late, already being sent'", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  srv.undoResult = () => json({ code: "not_pending" }, 409);
  srv.statusFor = (id) => status({ sendId: id, state: "interrupted", remainingMs: null, subject: "Hello" });
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Hello");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
  expect(ui("mail-notice")!.textContent).toContain("was not sent");
  expect(ui("mail-notice")!.textContent).not.toContain("Too late");
  expect(ui("mail-send-undo")).toBeNull();
});

test("undo that really is too late says so and keeps following the send", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  srv.undoResult = () => json({ code: "not_pending" }, 409);
  srv.statusFor = (id) => status({ sendId: id, state: "sending", remainingMs: null });
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Hello");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")?.textContent).toContain("Too late"));
  expect(ui("mail-send-undo")?.getAttribute("data-phase")).toBe("sending");
});

test("retrying the same draft after a lost answer reuses the send id; a changed draft gets a new one", async () => {
  let fail = true;
  srv.sendResult = () => {
    if (fail) throw new TypeError("network down");
    return json(status({ remainingMs: 8000 }), 202);
  };
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Retry me");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy());
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(2));
  expect(calls(SEND_RE)[1]!.body.sendId).toBe(calls(SEND_RE)[0]!.body.sendId);
  type("mail-composer-body", "changed text");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(3));
  expect(calls(SEND_RE)[2]!.body.sendId).not.toBe(calls(SEND_RE)[0]!.body.sendId);
  fail = false;
});

test("a failed discard keeps the dialog open with the reason and cannot be dismissed while running", async () => {
  srv.discardResult = () => json({ code: "auth_failed" }, 502);
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Keep me");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  fireEvent.click(ui("mail-composer-discard")!);
  expect((await screen.findByText(/cannot be recovered/i))).toBeTruthy();
  fireEvent.click(ui("mail-composer-discard-confirm")!);
  expect(await screen.findByText(/refused the login/)).toBeTruthy();
  expect(ui("mail-composer")).toBeTruthy();
  expect(ui("mail-composer-discard-confirm")).toBeTruthy(); // still open
}, 10000);

test("after the countdown, an unreachable server shows 'reconnecting', not a claim that it is being sent", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusFor = () => null; // 404 would end it; use a network failure instead
  const real = globalThis.fetch;
  let down = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (down && /\/sends\/[^/]+$/.test(String(input)) && (init?.method ?? "GET") === "GET") throw new TypeError("down");
    return real(input as never, init);
  }));
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Hello");
  down = true;
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")?.getAttribute("data-phase")).toBe("sending"), { timeout: 3000 });
  await waitFor(() => expect(ui("mail-send-undo")!.textContent).toContain("Reconnecting"), { timeout: 3000 });
  expect(ui("mail-send-undo")!.textContent).not.toMatch(/^Sending…/);
}, 10000);

test("leaving Mail with edits the server does not have yet saves them first", async () => {
  const view = render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Unsaved on leave");
  expect(calls(/\/draft$/, "PUT")).toHaveLength(0); // still inside the autosave delay
  view.unmount();
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1));
  expect(calls(/\/draft$/, "PUT")[0]!.body.subject).toBe("Unsaved on leave");
});


// ---- review round 2 -----------------------------------------------------------------

/** Hold the matching request until released (the rest goes through the normal stub). */
function hold(match: RegExp, method?: string) {
  const real = globalThis.fetch;
  let release: (r: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (match.test(String(input)) && (!method || (init?.method ?? "GET") === method)) {
        srv.calls.push({
          method: init?.method ?? "GET",
          url: String(input),
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        });
        return new Promise<Response>((res) => {
          release = res;
        });
      }
      return real(input as never, init);
    })
  );
  return { release: (r: Response) => release(r) };
}

test("an edit made after the last save is saved before the window closes", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("First");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  const before = calls(/\/draft$/, "PUT").length;
  type("mail-composer-body", "LATER EDIT");
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  const puts = calls(/\/draft$/, "PUT");
  expect(puts.length).toBe(before + 1);
  expect(puts[puts.length - 1]!.body.text).toBe("LATER EDIT");
}, 10000);

test("opening a restored send saves the later edit of the open composer first", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Sent one");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  await compose1("Second", "kofi@example.test");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
  type("mail-composer-body", "EDIT AFTER SAVE");
  fireEvent.click(ui("mail-notice-action")!);
  await waitFor(() => expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Sent one"));
  expect(calls(/\/draft$/, "PUT").map((c) => c.body.text)).toContain("EDIT AFTER SAVE");
}, 10000);

test("while a send request is in flight the window cannot be closed or edited, and a failure keeps the text", async () => {
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Unsaved");
  const h = hold(SEND_RE, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  expect(ui("mail-composer-close")!.hasAttribute("disabled")).toBe(true);
  expect((ui("mail-composer-body") as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.click(ui("mail-composer-close")!);
  fireEvent.change(ui("mail-composer-body")!, { target: { value: "typed during send" } });
  expect(ui("mail-composer")).toBeTruthy();
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Unsaved");
  h.release(json({ code: "drafts_unavailable" }, 422));
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy());
  expect(ui("mail-composer-error")!.textContent).toContain("no Drafts folder");
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Unsaved");
  expect(ui("mail-composer-close")!.hasAttribute("disabled")).toBe(false);
});

test("a restored send cannot be opened over a composer that is sending", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Alpha");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  await compose1("Beta", "kofi@example.test");
  const h = hold(SEND_RE, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(2));
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
  fireEvent.click(ui("mail-notice-action")!);
  await new Promise((r) => setTimeout(r, 200));
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Beta"); // untouched
  expect(ui("mail-notice")).toBeTruthy(); // still on offer
  h.release(json(status({ remainingMs: 8000 }), 202));
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  expect(document.querySelectorAll('[data-ui="mail-send-undo"]').length).toBe(1); // Beta's own bar
});

test("undo of a send owned by another Mail window says so, and double clicks make one request", async () => {
  srv.sendResult = () => json(status({ remainingMs: 8000 }), 202);
  srv.undoResult = () => json({ code: "owned_elsewhere" }, 409);
  srv.statusFor = (id) => status({ sendId: id, state: "pending", remainingMs: 5000, ownedElsewhere: true });
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Shared");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  fireEvent.click(ui("mail-send-undo-action")!);
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect(ui("mail-notice")?.textContent).toContain("Another Mail window"));
  expect(ui("mail-notice")!.textContent).not.toContain("Too late");
  expect(calls(/\/undo$/, "POST")).toHaveLength(1);
  expect(ui("mail-send-undo")?.getAttribute("data-phase")).toBe("window");
});

test("a sent result the user must know about stays until it is closed, and only then is it forgotten", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusFor = (id) =>
    status({ sendId: id, state: "sent", remainingMs: null, sentCopy: "saved", draftKept: true, rejected: 1 });
  render(<MailView />);
  await screen.findByText("Subject 3");
  await compose1("Hello");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(
    () => expect(document.querySelector('[data-ui="mail-notice"][data-tone="warning"]')).toBeTruthy(),
    { timeout: 4000 }
  );
  const warn = document.querySelector('[data-ui="mail-notice"][data-tone="warning"]') as HTMLElement;
  expect(warn.textContent).toContain("could not be removed");
  expect(warn.textContent).toContain("refused 1 recipient");
  expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(0);
  fireEvent.click(within(warn).getByLabelText("Dismiss"));
  await waitFor(() => expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(1));
}, 10000);

test("a reply whose answer arrives after another composer was opened is offered, not swapped in", async () => {
  await openMail();
  const h = hold(/\/init$/, "POST");
  fireEvent.click(ui("mail-reply")!);
  await waitFor(() => expect(calls(/\/init$/)).toHaveLength(1));
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Typing");
  h.release(json({ draft: srv.initDraft, attachments: [] }));
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Typing");
});
