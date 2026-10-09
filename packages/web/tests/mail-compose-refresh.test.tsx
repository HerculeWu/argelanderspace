// @vitest-environment jsdom
// Mail closing-review B1 (tickets 07/08 seam): what the compose layer's `onChanged` does to the page.
import type { MailAccount, MailHeader } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { MailView } from "../src/mail/MailView";
import { resetMailLive } from "../src/mail/mailLive";

vi.mock("../src/api/ws", () => ({ onMailChanged: () => () => {} }));

// The provider is replaced by a stand-in that exposes the `onChanged` the page hands to the compose layer.
const seam = vi.hoisted(() => ({ onChanged: null as (() => void) | null }));
vi.mock("../src/mail/MailCompose", async (orig) => {
  const real = await orig<typeof import("../src/mail/MailCompose")>();
  return {
    ...real,
    MailComposeProvider: (p: { onChanged: () => void; children: unknown }) => {
      seam.onChanged = p.onChanged;
      return p.children;
    },
    ComposeButton: () => null,
    MailComposeActions: () => null,
    MailComposeLayer: () => null,
  };
});

const A1 = "acc-aaaaaaaaaaaa";
const A2 = "acc-bbbbbbbbbbbb";
const A3 = "acc-cccccccccccc";
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
const header = (uid: number): MailHeader => ({
  uid,
  date: `2026-10-0${Math.min(uid, 9)}T10:00:00.000Z`,
  from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
  to: [],
  subject: `Subject ${uid}`,
  unread: true,
  starred: false,
  hasAttachments: false,
  size: 100,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

let calls: string[];
let folderMode: "ok" | "gate" | "fail";
let gate: Promise<void> | null;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  resetMailLive();
  calls = [];
  folderMode = "ok";
  gate = null;
  seam.onChanged = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/mail/accounts")
        return json({ version: 1, rev: 1, accounts: [acct(A1, "Work"), acct(A2, "Home"), acct(A3, "Refused")] });
      const f = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/folders$/);
      if (f) {
        if (f[1] === A3) return json({ code: "auth_failed", detail: "x" }, 502);
        if (f[1] === A1 && folderMode === "fail" && calls.filter((c) => c.endsWith(`${A1}/folders`)).length > 1)
          return json({ code: "unreachable" }, 502);
        if (f[1] === A1 && folderMode === "gate" && gate) await gate;
        return json({
          accountId: f[1],
          stale: false,
          folders: [{ path: "INBOX", name: "INBOX", role: "inbox", depth: 0, selectable: true, unread: 1, total: 3 }],
        });
      }
      const l = url.match(/^\/api\/mail\/accounts\/([^/?]+)\/messages\?(.*)$/);
      if (l) {
        if (l[1] === A3) return json({ code: "auth_failed", detail: "x" }, 502);
        if (l[1] === A2) return json({ accountId: A2, folder: "INBOX", uidValidity: 7, total: 1, headers: [header(5)], nextBefore: null, stale: false });
        if (/[?&]before=/.test(url))
          return json({ accountId: A1, folder: "INBOX", uidValidity: 7, total: 3, headers: [header(1)], nextBefore: null, stale: false });
        return json({ accountId: A1, folder: "INBOX", uidValidity: 7, total: 3, headers: [header(3), header(2)], nextBefore: 2, stale: false });
      }
      return json({ code: "unavailable" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rowSubjects = () => [...document.querySelectorAll('[data-ui="mail-message-row"]')].map((r) => r.textContent ?? "");
const hit = (s: string) => calls.filter((c) => c.includes(s)).length;

test("compose onChanged reloads quietly: rows stay, pages stay, a refused account is not asked again", async () => {
  render(<MailView />);
  await waitFor(() => expect(rowSubjects().length).toBe(3));
  fireEvent.click(await screen.findByRole("button", { name: /load more/i }));
  await waitFor(() => expect(rowSubjects().some((t) => t.includes("Subject 1"))).toBe(true));
  const refusedBefore = hit(A3);
  const a1Before = hit(`${A1}/folders`);

  folderMode = "gate";
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  act(() => seam.onChanged?.());
  await waitFor(() => expect(hit(`${A1}/folders`)).toBeGreaterThan(a1Before));
  // while the reload is in flight nothing vanishes: the unified inbox still shows every row
  expect(rowSubjects().some((t) => t.includes("Subject 5"))).toBe(true);
  expect(rowSubjects().some((t) => t.includes("Subject 3"))).toBe(true);
  release();
  await waitFor(() => expect(hit(`${A1}/messages`)).toBeGreaterThan(2));
  await act(async () => {});
  // the older page loaded earlier is still there, and so is the refused account's state: no request to it
  expect(rowSubjects().some((t) => t.includes("Subject 1"))).toBe(true);
  expect(rowSubjects().length).toBe(4);
  expect(hit(A3)).toBe(refusedBefore);
});

test("compose onChanged keeps the folder tree and rows when the server cannot be reached", async () => {
  folderMode = "fail";
  render(<MailView />);
  await waitFor(() => expect(rowSubjects().length).toBe(3));
  const treeBefore = document.querySelectorAll('[data-ui="mail-folder"]').length;
  act(() => seam.onChanged?.());
  await waitFor(() => expect(hit(`${A1}/folders`)).toBe(2));
  await act(async () => {});
  expect(document.querySelectorAll('[data-ui="mail-folder"]').length).toBe(treeBefore);
  expect(rowSubjects().length).toBe(3);
});
