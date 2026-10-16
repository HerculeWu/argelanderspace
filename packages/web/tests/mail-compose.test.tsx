// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailAccount, MailHeader, MailMessage, MailSendStatus } from "@argelanderspace/contracts";
import { MailView } from "../src/mail/MailView";
import i18n from "../src/i18n";
import { selectIsDisabled, selectRows, selectTrigger } from "./select-helpers";

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
  sessionStorage.clear();
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

// web-test-flake 02. The bar's seconds are the difference of two readings of the page clock; a clock that moves at
// every reading (as the real one may, between any two of them) must not make an 8 s window read "9s".
test("the undo bar never starts above the server's window, even when the clock moves between every two readings", async () => {
  const real = Date.now.bind(Date);
  let last = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    last = Math.max(real(), last + 1);
    return last;
  });
  try {
    render(<MailView />);
    await screen.findByText("Subject 3");
    fireEvent.click(ui("mail-compose")!);
    type("mail-composer-to", "ada@example.test");
    type("mail-composer-subject", "Hello");
    fireEvent.click(ui("mail-composer-send")!);
    await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
    expect(ui("mail-send-undo")!.textContent).toMatch(/Sending in [78]s/);
  } finally {
    spy.mockRestore();
  }
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

test("closing review B2: sends the Copilot started are neither restored, reported nor dismissed by the Mail page", async () => {
  srv.outbox = [
    status({ sendId: "00000000-0000-4000-8000-0000000000c1", state: "sent", remainingMs: null, subject: "By the Copilot", sentCopy: "saved", draftKept: false, origin: "copilot" }),
    status({ sendId: "00000000-0000-4000-8000-0000000000c2", state: "pending", remainingMs: 5000, subject: "Copilot window", origin: "copilot" }),
    status({ sendId: "00000000-0000-4000-8000-0000000000c3", state: "interrupted", remainingMs: null, subject: "Mine", origin: "mail" }),
  ];
  render(<MailView />);
  await waitFor(() => expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(1));
  expect(document.body.textContent).toContain("Mine");
  expect(document.body.textContent).not.toContain("By the Copilot");
  expect(ui("mail-send-undo")).toBeNull();
  await new Promise((r) => setTimeout(r, 100));
  expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(0);
  expect(calls(/\/sends\/[^/]+$/, "GET")).toHaveLength(0);
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


// ---- review round 3 -----------------------------------------------------------------

const staged = (id: string, name: string) =>
  json({ id: id.repeat(32).slice(0, 32), filename: name, contentType: "application/pdf", size: 10 }, 201);
const attachFile = (name: string) =>
  fireEvent.change(ui("mail-composer-file")!, {
    target: { files: [new File([new Uint8Array(10)], name, { type: "application/pdf" })] },
  });
const attachmentNames = () =>
  [...document.querySelectorAll('[data-ui="mail-composer-attachment"]')].map((e) => e.textContent ?? "");
const mount = async () => {
  const view = render(<MailView />);
  await screen.findByText("Subject 3");
  return view;
};

test("closing a window while an attachment uploads keeps it open and says so; the file lands in that window, never in the next one", async () => {
  await mount();
  await compose1("Window A");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  const h = hold(/\/attachments$/, "POST");
  attachFile("secret-A.pdf");
  await waitFor(() => expect(calls(/\/attachments$/, "POST")).toHaveLength(1));
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer-error")!.textContent).toMatch(/still uploading/i));
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Window A");
  h.release(staged("b", "secret-A.pdf"));
  await waitFor(() => expect(attachmentNames().join()).toContain("secret-A.pdf"));
  expect(ui("mail-composer-error")).toBeNull();
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  const puts = calls(/\/draft$/, "PUT");
  expect(puts[puts.length - 1]!.body.attachments).toEqual(["b".repeat(32)]);
  await compose1("Window B", "bob@example.test");
  expect(attachmentNames()).toEqual([]);
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  expect(calls(SEND_RE)[0]!.body.draft.attachments).toEqual([]);
}, 10000);

test("an upload that finishes after the user left Mail is not written over the draft on the server; the next visit says to add it again", async () => {
  const view = await mount();
  await compose1("Leaving with a file");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  const h = hold(/\/attachments$/, "POST");
  attachFile("late.pdf");
  await waitFor(() => expect(calls(/\/attachments$/, "POST")).toHaveLength(1));
  const mid = (calls(/\/draft$/, "PUT")[0]!.body as { messageId: string }).messageId;
  view.unmount();
  // Back in Mail, the same draft gets newer text (this window, another tab: the page cannot know).
  await mount();
  await fetch(`/api/mail/compose/accounts/${A1}/draft`, {
    method: "PUT",
    body: JSON.stringify({ ...srv.initDraft, messageId: mid, text: "NEWER TEXT" }),
  });
  h.release(staged("c", "late.pdf"));
  const notice = await waitFor(() => {
    const n = [...document.querySelectorAll('[data-ui="mail-notice"]')].find((x) => /late\.pdf/.test(x.textContent ?? ""));
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(notice.textContent).toMatch(/was not added to “Leaving with a file”/);
  // Nothing wrote the old snapshot back over the newer text; the unused staged file was removed.
  expect(calls(/\/draft$/, "PUT").slice(-1)[0]!.body.text).toBe("NEWER TEXT");
  expect(calls(new RegExp(`/attachments/${"c".repeat(32)}$`), "DELETE")).toHaveLength(1);
  // No text is held by this notice, so it closes without asking.
  fireEvent.click(within(notice).getByLabelText("Dismiss"));
  await waitFor(() => expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(0));
  expect(ui("mail-left-drop-dialog")).toBeNull();
  expect(sessionStorage.getItem("argelander.mail.leftBehind")).toBeNull();
}, 10000);

test("a late upload whose draft text exists only in this tab joins that kept text", async () => {
  const view = await mount();
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Only here");
  const h = hold(/\/attachments$/, "POST");
  attachFile("joins.pdf");
  await waitFor(() => expect(calls(/\/attachments$/, "POST")).toHaveLength(1));
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) throw new TypeError("offline");
    return real(input as never, init);
  }));
  view.unmount();
  await new Promise((r) => setTimeout(r, 50));
  h.release(staged("e", "joins.pdf"));
  await waitFor(() => expect(sessionStorage.getItem("argelander.mail.leftBehind") ?? "").toContain("e".repeat(32)));
  vi.stubGlobal("fetch", real);
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect(attachmentNames().join()).toContain("joins.pdf"));
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Only here");
}, 10000);

test("an upload that finishes after its draft was discarded is removed again, not attached anywhere", async () => {
  await mount();
  fireEvent.click(ui("mail-compose")!);
  const h = hold(/\/attachments$/, "POST");
  attachFile("drop.pdf");
  await waitFor(() => expect(calls(/\/attachments$/, "POST")).toHaveLength(1));
  fireEvent.click(ui("mail-composer-discard")!);
  fireEvent.click(await waitFor(() => ui("mail-composer-discard-confirm")!));
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  await compose1("Another one", "bob@example.test"); // a different window is open when the upload lands
  h.release(staged("d", "drop.pdf"));
  await waitFor(() =>
    expect(calls(new RegExp(`/attachments/${"d".repeat(32)}$`), "DELETE")).toHaveLength(1)
  );
  expect(attachmentNames()).toEqual([]);
  expect(ui("mail-notice")).toBeNull(); // the user threw it away: nothing to report
  await waitFor(() => expect(calls(/\/draft$/, "PUT").length).toBeGreaterThan(0), { timeout: 4000 });
  expect(calls(/\/draft$/, "PUT").every((c) => c.body.attachments.length === 0)).toBe(true);
}, 10000);

test("leaving Mail while a send request is in flight: a send that then fails is saved to Drafts, and the next visit says so and can reopen it", async () => {
  const view = await mount();
  await compose1("Left behind");
  const h = hold(SEND_RE, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  view.unmount();
  h.release(json({ code: "drafts_unavailable" }, 422));
  await waitFor(() => expect(calls(/\/draft$/, "PUT").some((c) => c.body.text === "Body of Left behind")).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  expect(notice.textContent).toMatch(/“Left behind” was not sent/);
  expect(notice.textContent).toMatch(/in Drafts/);
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Left behind"));
  expect((ui("mail-composer-to") as HTMLInputElement).value).toBe("ada@example.test");
}, 10000);

test("leaving Mail while a send request is in flight: if neither the send nor saving the draft works, the text is kept in the tab and offered on return", async () => {
  const view = await mount();
  await compose1("Nowhere");
  const h = hold(SEND_RE, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  view.unmount();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) {
      srv.calls.push({ method: "PUT", url: String(input), body: JSON.parse(String(init?.body)) });
      return json({ code: "auth_failed" }, 502);
    }
    return real(input as never, init);
  }));
  h.release(json({ code: "auth_failed" }, 502));
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  vi.stubGlobal("fetch", real);
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  expect(notice.textContent).toMatch(/“Nowhere” was not sent/);
  expect(notice.textContent).toMatch(/kept in this tab/);
  expect(ui("mail-composer")).toBeNull(); // offered, not pushed over the page
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Nowhere"));
}, 10000);

test("a draft that could not be saved on leaving is kept in the tab and can be reopened", async () => {
  srv.account = acct();
  const view = await mount();
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Kept here");
  type("mail-composer-body", "words that must survive");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) throw new TypeError("offline");
    return real(input as never, init);
  }));
  view.unmount();
  await new Promise((r) => setTimeout(r, 50));
  vi.stubGlobal("fetch", real);
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  expect(notice.textContent).toMatch(/kept in this tab/);
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("words that must survive"));
}, 10000);

const lostThenRetry = async (statusOfFirst: () => Response) => {
  await mount();
  await compose1("Twice");
  const real = globalThis.fetch;
  let failOnce = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (SEND_RE.test(url) && failOnce) {
      failOnce = false;
      srv.calls.push({ method: "POST", url, body: JSON.parse(String(init?.body)) });
      throw new TypeError("Failed to fetch");
    }
    if (/\/sends\/[^/]+$/.test(url) && (init?.method ?? "GET") === "GET") {
      srv.calls.push({ method: "GET", url });
      return statusOfFirst();
    }
    return real(input as never, init);
  }));
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy());
  const firstId = calls(SEND_RE)[0]!.body.sendId as string;
  type("mail-composer-body", "Body of Twice (typo fixed)");
  fireEvent.click(ui("mail-composer-send")!);
  return firstId;
};

test("a lost send answer is checked before sending again: an accepted first send is joined, never sent a second time", async () => {
  const firstId = await lostThenRetry(() =>
    json(status({ sendId: "00000000-0000-4000-8000-000000000001", subject: "Twice", remainingMs: 6000 }))
  );
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  expect(calls(SEND_RE)).toHaveLength(1);
  expect(calls(new RegExp(`/sends/${firstId}$`), "GET")).toHaveLength(1);
  expect(ui("mail-composer")).toBeNull();
  expect(screen.getByText(/edits made after it are not in it/)).toBeTruthy();
  // Undo gives back the latest text, so it can be sent with the fix.
  fireEvent.click(ui("mail-send-undo-action")!);
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("Body of Twice (typo fixed)"));
}, 10000);

test("a lost send answer whose send already went out is not sent again; the window says so", async () => {
  await lostThenRetry(() => json(status({ state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false })));
  await waitFor(() => expect(ui("mail-composer-sent")!.textContent).toMatch(/already been sent/i));
  expect(calls(SEND_RE)).toHaveLength(1);
  expect(screen.getByText(/^Sent: /)).toBeTruthy();
  expect(ui("mail-composer-send")!.hasAttribute("disabled")).toBe(true);
}, 10000);

test("a lost send answer the server never received lets the retry through, under a new id for the changed text", async () => {
  const firstId = await lostThenRetry(() => json({ code: "not_found" }, 404));
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(2));
  expect(calls(SEND_RE)[1]!.body.sendId).not.toBe(firstId);
  expect(calls(SEND_RE)[1]!.body.draft.text).toBe("Body of Twice (typo fixed)");
}, 10000);

test("a lost send answer that still cannot be checked does not send again", async () => {
  await lostThenRetry(() => {
    throw new TypeError("still offline");
  });
  await waitFor(() => expect(calls(/\/sends\/[^/]+$/, "GET")).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(SEND_RE)).toHaveLength(1);
  expect(ui("mail-composer-error")!.textContent).toMatch(/could not be reached/);
  expect(ui("mail-composer-send")!.getAttribute("aria-busy")).not.toBe("true");
}, 10000);

test("discarding while the first save is still on its way waits for it and then deletes the saved copy", async () => {
  await mount();
  await compose1("Discard me");
  const h = hold(/\/draft$/, "PUT");
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1), { timeout: 4000 });
  fireEvent.click(ui("mail-composer-discard")!);
  fireEvent.click(await waitFor(() => ui("mail-composer-discard-confirm")!));
  await new Promise((r) => setTimeout(r, 100));
  expect(ui("mail-composer")).toBeTruthy(); // still waiting for the save
  h.release(json({ messageId: "x", savedAt: "x", folder: "Drafts", uid: 1 }));
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  expect(calls(/\/draft\/discard$/)).toHaveLength(1);
  expect(calls(/\/draft\/discard$/)[0]!.body.subject).toBe("Discard me");
}, 10000);

test("a draft save that answers after its window was sent does not mark the next window as saved", async () => {
  await mount();
  await compose1("First window");
  const h = hold(/\/draft$/, "PUT");
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1), { timeout: 4000 });
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo")).toBeTruthy());
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Second window");
  h.release(json({ messageId: "x", savedAt: "x", folder: "Drafts", uid: 1 }));
  await new Promise((r) => setTimeout(r, 100));
  expect(ui("mail-composer-draft-state")!.textContent).not.toMatch(/Saved|on the server/);
}, 10000);

test("a send that ends both by the countdown and by a late undo answer is settled once", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusFor = (id) => status({ sendId: id, state: "failed", code: "recipient_rejected", remainingMs: null });
  await mount();
  await compose1("Only once");
  const h = hold(/\/undo$/, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-send-undo-action")).toBeTruthy());
  fireEvent.click(ui("mail-send-undo-action")!);
  // The countdown ends and the poll reports the failure: the text comes back in the composer.
  await waitFor(() => expect((ui("mail-composer-subject") as HTMLInputElement | null)?.value).toBe("Only once"), { timeout: 3000 });
  h.release(json({ code: "not_pending" }, 409));
  await new Promise((r) => setTimeout(r, 150));
  expect(document.querySelectorAll('[data-ui="mail-composer"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(0);
}, 10000);


// ---- review round 4 -----------------------------------------------------------------

/** Leave Mail while a send is under way; the send fails and so does saving the draft (text kept in the tab). */
const leaveWithKeptText = async (body: string) => {
  const v = await mount();
  await compose1("Precious");
  type("mail-composer-body", body);
  const real = globalThis.fetch;
  let release: (r: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const u = String(input);
    const m = init?.method ?? "GET";
    if (SEND_RE.test(u)) {
      srv.calls.push({ method: m, url: u });
      return new Promise<Response>((res) => {
        release = res;
      });
    }
    if (/\/draft$/.test(u) && m === "PUT") return json({ code: "auth_failed" }, 502);
    return real(input as never, init);
  }));
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  v.unmount();
  release(json({ code: "invalid_recipient" }, 422));
  await waitFor(() => expect(sessionStorage.getItem("argelander.mail.leftBehind") ?? "").toContain(body));
  vi.stubGlobal("fetch", real);
};
const kept = () => sessionStorage.getItem("argelander.mail.leftBehind") ?? "";

test("kept text survives being shown: leaving or reloading again without Open still offers it", async () => {
  await leaveWithKeptText("PRECIOUS TEXT 123");
  const v2 = await mount();
  await waitFor(() => expect(ui("mail-notice")!.textContent).toMatch(/“Precious” was not sent/));
  expect(kept()).toContain("PRECIOUS TEXT 123"); // shown, not consumed
  v2.unmount(); // leave (or reload: sessionStorage is what survives)
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(1);
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("PRECIOUS TEXT 123"));
  // Back in a composer: only now is the tab copy let go.
  expect(kept()).toBe("");
}, 15000);

test("dismissing a notice that holds kept text asks first; cancelling keeps it, confirming drops it", async () => {
  await leaveWithKeptText("DROP ME 456");
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  fireEvent.click(within(notice).getByLabelText("Dismiss"));
  await waitFor(() => expect(ui("mail-left-drop-dialog")).toBeTruthy());
  expect(ui("mail-left-drop-dialog")!.textContent).toMatch(/only in this browser tab/);
  fireEvent.click(within(ui("mail-left-drop-dialog")!).getByText("Cancel"));
  await waitFor(() => expect(ui("mail-left-drop-dialog")).toBeNull());
  expect(ui("mail-notice")).toBeTruthy();
  expect(kept()).toContain("DROP ME 456");
  fireEvent.click(within(ui("mail-notice")!).getByLabelText("Dismiss"));
  fireEvent.click(await waitFor(() => ui("mail-left-drop-confirm")!));
  await waitFor(() => expect(ui("mail-notice")).toBeNull());
  expect(kept()).toBe("");
}, 15000);

test("a record made while Mail is open is written to the tab as well, so a reload right away keeps it", async () => {
  // Leave and come back before the failed send answers: the record arrives while Mail is mounted.
  const v = await mount();
  await compose1("Arrives late");
  const h = hold(SEND_RE, "POST");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(1));
  v.unmount();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) return json({ code: "auth_failed" }, 502);
    return real(input as never, init);
  }));
  const v2 = await mount();
  h.release(json({ code: "invalid_recipient" }, 422));
  await waitFor(() => expect(ui("mail-notice")?.textContent ?? "").toMatch(/“Arrives late” was not sent/));
  expect(kept()).toContain("Body of Arrives late");
  v2.unmount();
  vi.stubGlobal("fetch", real);
  await mount();
  await waitFor(() => expect(ui("mail-notice")?.textContent ?? "").toMatch(/“Arrives late” was not sent/));
}, 15000);

/** A composer whose message turns out to be sent already (lost answer; the first send went out). */
const sentWindow = async (sentCopy: "saved" | "failed" = "saved") => {
  await lostThenRetry(() => json(status({ state: "sent", remainingMs: null, sentCopy, draftKept: sentCopy === "failed" })));
  await waitFor(() => expect(ui("mail-composer-sent")).toBeTruthy());
};

test("a sent message's window can be closed; edits made after sending are offered as a new message, not saved over it", async () => {
  await sentWindow();
  const putsBefore = calls(/\/draft$/, "PUT").length;
  type("mail-composer-body", "EDITED AFTER SENDING");
  await new Promise((r) => setTimeout(r, 1500)); // past the autosave delay: nothing is saved
  expect(calls(/\/draft$/, "PUT")).toHaveLength(putsBefore);
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  const notice = await waitFor(() => {
    const n = [...document.querySelectorAll('[data-ui="mail-notice"]')].find((x) => /had already been sent/.test(x.textContent ?? ""));
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement | null)?.value).toBe("EDITED AFTER SENDING"));
  expect(ui("mail-composer-sent")).toBeNull();
  expect(ui("mail-composer-send")!.hasAttribute("disabled")).toBe(false);
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(2));
  expect(calls(SEND_RE)[1]!.body.draft.messageId).not.toBe(calls(SEND_RE)[0]!.body.draft.messageId);
}, 15000);

test("Copy as new message turns a sent message's window into a new message with its text", async () => {
  await sentWindow();
  type("mail-composer-body", "keep this wording");
  fireEvent.click(ui("mail-composer-copy-new")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeNull());
  expect((ui("mail-composer-body") as HTMLTextAreaElement).value).toBe("keep this wording");
  await waitFor(() => expect(calls(/\/draft$/, "PUT").some((c) => c.body.text === "keep this wording")).toBe(true), { timeout: 4000 });
  const mids = new Set(calls(SEND_RE).map((c) => c.body.draft.messageId));
  expect(mids.has(calls(/\/draft$/, "PUT").slice(-1)[0]!.body.messageId)).toBe(false);
}, 15000);

test("leaving Mail with edits to a sent message keeps them once, without trying to save", async () => {
  const real = globalThis.fetch;
  await sentWindow();
  type("mail-composer-body", "after-send words");
  const puts = calls(/\/draft$/, "PUT").length;
  cleanup(); // leave Mail
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(/\/draft$/, "PUT")).toHaveLength(puts);
  expect(kept()).toContain("after-send words");
  vi.stubGlobal("fetch", real);
  await mount();
  const n = await waitFor(() => ui("mail-notice")!);
  expect(n.textContent).toMatch(/had already been sent/);
  expect(document.querySelectorAll('[data-ui="mail-notice"]')).toHaveLength(1);
}, 15000);

test("a save refused as already sent turns the window into its sent state instead of a failure to retry", async () => {
  await mount();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input)) && init?.method === "PUT") return json({ code: "already_sent" }, 409);
    return real(input as never, init);
  }));
  await compose1("Sent in another tab");
  await waitFor(() => expect(ui("mail-composer-sent")).toBeTruthy(), { timeout: 4000 });
  expect(ui("mail-composer-draft-state")!.textContent).not.toMatch(/Couldn't save/);
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
}, 15000);

test("discarding the Drafts copy of a sent message whose Sent copy failed warns that it is the only record", async () => {
  srv.initDraft = { ...srv.initDraft, messageId: "<left@example.test>" };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/init$/.test(String(input))) return json({ draft: srv.initDraft, attachments: [], sent: { sentCopy: "failed" } });
    return real(input as never, init);
  }));
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(screen.getByText("Subject 3"));
  await screen.findByText("Plain body 3");
  fireEvent.click(ui("mail-reply")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeTruthy());
  expect(ui("mail-composer-send")!.hasAttribute("disabled")).toBe(true);
  fireEvent.click(ui("mail-composer-discard")!);
  await waitFor(() => expect(ui("mail-composer-discard-only-record")).toBeTruthy());
  expect(ui("mail-composer-discard-only-record")!.textContent).toMatch(/only record/);
}, 15000);

test("while an earlier send's answer is unknown the sender cannot be changed", async () => {
  await mount();
  await compose1("Fixed sender");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (SEND_RE.test(String(input))) {
      srv.calls.push({ method: "POST", url: String(input), body: JSON.parse(String(init?.body)) });
      throw new TypeError("Failed to fetch");
    }
    return real(input as never, init);
  }));
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy());
  expect(selectIsDisabled(ui("mail-composer-from")!)).toBe(true);
  // The list cannot be opened, so the other account cannot be picked.
  fireEvent.click(selectTrigger(ui("mail-composer-from")!));
  fireEvent.keyDown(selectTrigger(ui("mail-composer-from")!), { key: "ArrowDown" });
  expect(selectRows(ui("mail-composer-from")!)).toHaveLength(0);
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(calls(SEND_RE)).toHaveLength(2));
  expect(calls(SEND_RE)[1]!.url).toContain(A1);
}, 15000);

test("leaving Mail while a discard request runs does not save the discarded draft back", async () => {
  const view = await mount();
  await compose1("Going away");
  await waitFor(() => expect(ui("mail-composer-draft-state")!.textContent).toMatch(/^Saved/), { timeout: 4000 });
  type("mail-composer-body", "unsaved edit before discard");
  const h = hold(/\/draft\/discard$/);
  fireEvent.click(ui("mail-composer-discard")!);
  fireEvent.click(await waitFor(() => ui("mail-composer-discard-confirm")!));
  await waitFor(() => expect(calls(/\/draft\/discard$/)).toHaveLength(1));
  const puts = calls(/\/draft$/, "PUT").length;
  view.unmount();
  h.release(json({ ok: true }));
  await new Promise((r) => setTimeout(r, 100));
  expect(calls(/\/draft$/, "PUT")).toHaveLength(puts);
  expect(kept()).toBe("");
}, 15000);


// ---- review round 5 -----------------------------------------------------------------

const sentEditsNotice = () =>
  [...document.querySelectorAll('[data-ui="mail-notice"]')].find((x) => /had already been sent/.test(x.textContent ?? "")) as
    | HTMLElement
    | undefined;

test("edits to a sent message survive closing its window and then leaving Mail", async () => {
  await sentWindow();
  type("mail-composer-body", "EDITS ONLY HERE");
  fireEvent.click(ui("mail-composer-close")!);
  await waitFor(() => expect(ui("mail-composer")).toBeNull());
  await waitFor(() => expect(sentEditsNotice()).toBeTruthy());
  expect(kept()).toContain("EDITS ONLY HERE");
  cleanup(); // leave Mail
  await mount();
  await waitFor(() => expect(sentEditsNotice()).toBeTruthy());
  fireEvent.click(within(sentEditsNotice()!).getByText("Open"));
  await waitFor(() => expect((ui("mail-composer-body") as HTMLTextAreaElement | null)?.value).toBe("EDITS ONLY HERE"));
}, 15000);

test("dismissing the notice with a sent message's edits asks first", async () => {
  await sentWindow();
  type("mail-composer-body", "EDITS ONLY HERE");
  fireEvent.click(ui("mail-composer-close")!);
  const n = await waitFor(() => {
    expect(sentEditsNotice()).toBeTruthy();
    return sentEditsNotice()!;
  });
  fireEvent.click(within(n).getByLabelText("Dismiss"));
  await waitFor(() => expect(ui("mail-left-drop-dialog")).toBeTruthy());
  expect(sentEditsNotice()).toBeTruthy();
  expect(kept()).toContain("EDITS ONLY HERE");
}, 15000);

/** A kept record (its window's save failed on leaving) whose upload is still running; returns the upload hold. */
const keptWithUploadInFlight = async () => {
  const v = await mount();
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Kept here");
  type("mail-composer-body", "KEPT WORDS");
  const up = hold(/\/attachments$/, "POST");
  attachFile("later.pdf");
  await waitFor(() => expect(calls(/\/attachments$/, "POST")).toHaveLength(1));
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) throw new TypeError("offline");
    return real(input as never, init);
  }));
  v.unmount();
  await waitFor(() => expect(kept()).toContain("KEPT WORDS"));
  vi.stubGlobal("fetch", real);
  return up;
};

test("Open does not let go of the kept text when the open composer cannot be saved", async () => {
  const v = await mount();
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Kept here");
  type("mail-composer-body", "KEPT WORDS");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/draft$/.test(String(input))) throw new TypeError("offline");
    return real(input as never, init);
  }));
  v.unmount();
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Current");
  fireEvent.click(within(notice).getByText("Open"));
  await new Promise((r) => setTimeout(r, 400));
  expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Current");
  expect(kept()).toContain("KEPT WORDS");
  expect(ui("mail-notice")).toBeTruthy();
}, 15000);

test("a late attachment that joins a kept record while Open is under way is not deleted with the opened version", async () => {
  const up = await keptWithUploadInFlight();
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-subject", "Current");
  const put = hold(/\/draft$/, "PUT"); // Open first saves the open composer: keep that save waiting
  fireEvent.click(within(notice).getByText("Open"));
  await waitFor(() => expect(calls(/\/draft$/, "PUT").length).toBeGreaterThan(0));
  up.release(staged("f", "later.pdf")); // joins the kept record: a newer version of it
  await waitFor(() => expect(kept()).toContain("f".repeat(32)));
  put.release(json({ messageId: "x", savedAt: "x", folder: "Drafts", uid: 1 }));
  await waitFor(() => expect((ui("mail-composer-subject") as HTMLInputElement).value).toBe("Kept here"));
  // The version with the attachment is still kept and still offered.
  expect(kept()).toContain("f".repeat(32));
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy());
}, 15000);

test("confirming the drop works even if the record was replaced while the dialog was open", async () => {
  const up = await keptWithUploadInFlight();
  await mount();
  const notice = await waitFor(() => ui("mail-notice")!);
  fireEvent.click(within(notice).getByLabelText("Dismiss"));
  await waitFor(() => expect(ui("mail-left-drop-dialog")).toBeTruthy());
  up.release(staged("g", "later.pdf"));
  await waitFor(() => expect(kept()).toContain("g".repeat(32)));
  fireEvent.click(ui("mail-left-drop-confirm")!);
  await waitFor(() => expect(kept()).toBe(""));
  expect(ui("mail-notice")).toBeNull();
}, 15000);

test("copying a sent message as new leaves out attachments the send already removed, and says so", async () => {
  await mount();
  await compose1("With file");
  attachFile("sent-along.pdf");
  await waitFor(() => expect(attachmentNames().join()).toContain("sent-along.pdf"));
  const real = globalThis.fetch;
  let failOnce = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const u = String(input);
    if (SEND_RE.test(u) && failOnce) {
      failOnce = false;
      srv.calls.push({ method: "POST", url: u, body: JSON.parse(String(init?.body)) });
      throw new TypeError("Failed to fetch");
    }
    if (/\/sends\/[^/]+$/.test(u) && (init?.method ?? "GET") === "GET")
      return json(status({ state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false }));
    return real(input as never, init);
  }));
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-error")).toBeTruthy());
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeTruthy());
  fireEvent.click(ui("mail-composer-copy-new")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeNull());
  expect(attachmentNames()).toEqual([]);
  expect(ui("mail-composer-error")!.textContent).toMatch(/not copied.*sent-along\.pdf/);
}, 15000);

test("copying the Drafts leftover of a sent message keeps its freshly staged attachments", async () => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (/\/init$/.test(String(input)))
      return json({
        draft: { ...srv.initDraft, messageId: "<left@example.test>", attachments: ["h".repeat(32)] },
        attachments: [{ id: "h".repeat(32), filename: "restaged.pdf", contentType: "application/pdf", size: 10 }],
        sent: { sentCopy: "saved" },
      });
    return real(input as never, init);
  }));
  await openMail();
  fireEvent.click(ui("mail-reply")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeTruthy());
  fireEvent.click(ui("mail-composer-copy-new")!);
  await waitFor(() => expect(ui("mail-composer-sent")).toBeNull());
  expect(attachmentNames().join()).toContain("restaged.pdf");
  expect(ui("mail-composer-error")).toBeNull();
}, 15000);

test("leaving Mail while a discard waits for a save on its way does not save the draft back", async () => {
  const view = await mount();
  await compose1("Thrown away");
  const put = hold(/\/draft$/, "PUT");
  await waitFor(() => expect(calls(/\/draft$/, "PUT")).toHaveLength(1), { timeout: 4000 });
  type("mail-composer-body", "edit after the save started");
  fireEvent.click(ui("mail-composer-discard")!);
  fireEvent.click(await waitFor(() => ui("mail-composer-discard-confirm")!));
  await new Promise((r) => setTimeout(r, 50));
  view.unmount();
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(/\/draft$/, "PUT")).toHaveLength(1);
  put.release(json({ messageId: "x", savedAt: "x", folder: "Drafts", uid: 1 }));
  await new Promise((r) => setTimeout(r, 100));
  expect(kept()).toBe("");
}, 15000);

// ---- Copilot ticket 40 (Q3) -----------------------------------------------------------

test("a failure whose outcome cannot be known (outcome_unknown) is reported as unknown, never put back as unsent text", async () => {
  srv.sendResult = () => json(status({ remainingMs: 300 }), 202);
  srv.statusSeq = [status({ state: "failed", remainingMs: null, code: "outcome_unknown", subject: "Maybe gone" })];
  render(<MailView />);
  await screen.findByText("Subject 3");
  fireEvent.click(ui("mail-compose")!);
  type("mail-composer-to", "ada@example.test");
  type("mail-composer-subject", "Maybe gone");
  fireEvent.click(ui("mail-composer-send")!);
  await waitFor(() => expect(ui("mail-notice")).toBeTruthy(), { timeout: 4000 });
  const notice = ui("mail-notice")!;
  expect(notice.getAttribute("data-tone")).toBe("warning");
  expect(notice.textContent).toContain("unknown whether it went out");
  expect(within(notice).getByText("Open Drafts")).toBeTruthy();
  // Not restored as a composer with a failure (that would say it was not sent).
  expect(ui("mail-composer")).toBeNull();
  expect(ui("mail-send-undo")).toBeNull();
  // The server keeps the record until the user closes the notice.
  await new Promise((r) => setTimeout(r, 100));
  expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(0);
  fireEvent.click(ui("mail-notice-close")!);
  await waitFor(() => expect(calls(/\/sends\/[^/]+$/, "DELETE")).toHaveLength(1));
}, 10000);
