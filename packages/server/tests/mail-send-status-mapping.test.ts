// Copilot tickets 41/43: how a failed send is reported. An ambiguous SMTP failure (connection lost after DATA:
// the message may have been accepted) is stored as `failed` + `ambiguous` and must reach every client as
// `unknown`, never as `failed`; the web decides "do not send again" from that. This pins the mapping of the
// status answer and of the outbox list (the same `statusOf` path) without touching the SMTP side.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailOutboxMarker } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { MailComposeService } from "../src/mail-compose.js";
import { MailOutbox } from "../src/mail-outbox.js";
import { MailSendService } from "../src/mail-send.js";

const ACC = "acc-0123456789ab";
let root: string;
let outbox: MailOutbox;
let send: MailSendService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-status-mapping-"));
  outbox = new MailOutbox(() => root);
  // Only the status mapping is exercised: nothing here reaches IMAP or SMTP.
  const compose = {
    setSendGuard: () => {},
    setSentLookup: () => {},
  } as unknown as MailComposeService;
  send = new MailSendService({ compose, outgoing: {} as never, outbox });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const marker = (over: Partial<MailOutboxMarker>): MailOutboxMarker => ({
  version: 1,
  sendId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  accountId: ACC as never,
  messageId: `<m${n}@fake.test>`,
  subject: "Subject",
  state: "failed",
  createdAt: Date.now(),
  deadlineAt: Date.now(),
  ownerPid: 1,
  ownerBoot: "another-life",
  code: null,
  ambiguous: false,
  sentCopy: null,
  draftKept: true,
  rejected: 0,
  ...over,
});

test("a failure whose SMTP outcome is ambiguous is reported as unknown (outcome_unknown), by status and by the outbox", () => {
  const m = marker({ code: "outcome_unknown", ambiguous: true });
  outbox.writeStrict(m);
  const st = send.status(ACC, m.sendId);
  expect(st.state).toBe("unknown");
  expect(st.code).toBe("outcome_unknown");
  expect(st.draftKept).toBe(true);
  const listed = send.list().find((x) => x.sendId === m.sendId);
  expect(listed?.state).toBe("unknown");
  expect(listed?.code).toBe("outcome_unknown");
});

test("any ambiguous failure is unknown whatever its stored code; a definite failure stays failed with its code", () => {
  const vague = marker({ code: "unknown", ambiguous: true });
  const definite = marker({ code: "recipient_rejected", ambiguous: false });
  outbox.writeStrict(vague);
  outbox.writeStrict(definite);
  expect(send.status(ACC, vague.sendId).state).toBe("unknown");
  const d = send.status(ACC, definite.sendId);
  expect(d.state).toBe("failed");
  expect(d.code).toBe("recipient_rejected");
  const states = Object.fromEntries(send.list().map((x) => [x.sendId, x.state]));
  expect(states[vague.sendId]).toBe("unknown");
  expect(states[definite.sendId]).toBe("failed");
});
