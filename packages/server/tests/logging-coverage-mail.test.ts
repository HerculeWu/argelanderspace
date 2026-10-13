/**
 * The user-level log and the mail servers (desktop-app ticket 07, revision).
 *
 * 1. The production wiring: an app that is given a log and NO mail services builds them itself
 *    (`mountMailRoutes(…, log)` → `createDefaultMail*Service(log)`), and their calls must be in that log — a `log`
 *    that is not passed on would leave it silent. Only the protocol objects and the keychain are replaced (infra's
 *    factories are mocked to hand out fakes); the services, the account store and the routes are the real ones, over
 *    the isolated global directories.
 * 2. A mail server's host is never written: a preset's server is recorded by the preset's name, every other as
 *    `custom` — also for the unsaved input of the account dialog's test.
 * 3. `observedMail` itself, call by call: whatever the arguments and the result carry, the record has the same few
 *    fields.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIL_PRESETS } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { createLogger, type LogJson } from "@argelanderspace/infra";
import { afterAll, describe, expect, test, vi } from "vitest";
import { createMemorySink, type MemorySink } from "../../infra/tests/log-memory-sink.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import { MAIL_CALLS, mailProvider, observedMail } from "../src/log-observers.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { markersInText } from "./log-markers.js";

const MARK = {
  host: "mail.zqxmark-institute.test",
  smtpHost: "smtp.zqxmark-institute.test",
  dialogHost: "imap.zqxmark-unsaved.test",
  login: "zqxmark.login@zqxmark-institute.test",
  address: "zqxmark.person@zqxmark-institute.test",
  otherAddress: "zqxmark.second@zqxmark-institute.test",
  password: "ZqxMarkMailPassword5c2e",
  folder: "ZqxMarkFolder/Referee reports",
  subject: "ZqxMarkSubject about the grant",
  body: "ZqxMarkBody the proposal was rejected",
  search: "ZqxMarkSearch supervisor",
  recipient: "zqxmark.recipient@zqxmark-other.test",
  messageId: "<zqxmark-message-id@zqxmark-institute.test>",
  reply: "ZqxMarkServerReply mailbox of dr.someone is locked",
  thrown: "ZqxMarkThrown connect to mail.zqxmark-institute.test failed",
} as const;

type LogRecord = Record<string, LogJson>;
type Target = { host: string; user: string; password: string };

// --------------------------------------------------------------------------- //
// The fakes infra's factories hand out (hoisted: the mock below is installed before any import)
// --------------------------------------------------------------------------- //

const fakes = vi.hoisted(() => {
  const keychain = new Map<string, string>();
  const state = {
    keychain,
    /** What each protocol object was called with: the calls do reach the fakes, with everything in them. */
    seen: [] as Array<{ call: string; target: unknown }>,
    throwOn: null as string | null,
    thrown: "",
  };
  const note = (call: string, target: unknown): void => {
    state.seen.push({ call, target });
    if (state.throwOn === call) throw new Error(state.thrown);
  };
  return {
    state,
    backend: {
      get: (account: string) => keychain.get(account) ?? null,
      set: (account: string, password: string) => void keychain.set(account, password),
      delete: (account: string) => keychain.delete(account),
    },
    protocol: {
      verifyImapLogin: async (t: { host: string }) => {
        note("verifyImapLogin", t);
        return t.host.includes("unsaved")
          ? { ok: false as const, code: "host_not_found" }
          : { ok: true as const };
      },
      verifySmtpLogin: async (t: { host: string }) => {
        note("verifySmtpLogin", t);
        return t.host.includes("unsaved")
          ? { ok: false as const, code: "auth_failed" }
          : { ok: true as const };
      },
    },
    mailbox: {
      listFolders: async (t: unknown) => {
        note("listFolders", t);
        return {
          ok: true as const,
          value: [
            {
              path: "INBOX",
              name: "INBOX",
              delimiter: "/",
              specialUse: "\\Inbox",
              selectable: true,
              unread: 1,
              total: 1,
            },
          ],
        };
      },
      listHeaders: async (t: unknown) => {
        note("listHeaders", t);
        return { ok: false as const, code: "auth_failed" };
      },
      openMessage: async (t: unknown) => {
        note("openMessage", t);
        return { ok: false as const, code: "not_found" };
      },
    },
    manage: {
      search: async (t: unknown) => {
        note("search", t);
        return { ok: false as const, code: "timeout" };
      },
    },
    outgoing: {
      deleteDraft: async (t: unknown) => {
        note("deleteDraft", t);
        return { ok: true as const, value: { removed: 0 } };
      },
    },
  };
});

vi.mock("@argelanderspace/infra", async (original) => {
  const actual = await original<typeof import("@argelanderspace/infra")>();
  return {
    ...actual,
    createNodeMailProtocol: () => fakes.protocol,
    createNodeMailMailbox: () => fakes.mailbox,
    createNodeMailManage: () => fakes.manage,
    createNodeMailOutgoing: () => fakes.outgoing,
    createCredentialStore: (options: Parameters<typeof actual.createCredentialStore>[0] = {}) =>
      actual.createCredentialStore({ ...options, backend: fakes.backend }),
  };
});

function memoryLog(): { sink: MemorySink; log: ServerLog } {
  const sink = createMemorySink();
  return { sink, log: createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" }) };
}
const calls = (sink: MemorySink, from = 0): LogRecord[] =>
  sink
    .records()
    .slice(from)
    .filter((record) => record.event === "mail.remote_call");
function expectNoMarkers(sink: MemorySink): void {
  expect(markersInText(sink.lines.join("\n"), Object.values(MARK))).toEqual([]);
}
const CALL_KEYS = ["call", "duration_ms", "event", "level", "outcome", "protocol", "provider", "t"];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// --------------------------------------------------------------------------- //
// 1 + 2. The production wiring, and the provider instead of the host
// --------------------------------------------------------------------------- //

describe("an app with a log and no mail services of its own", () => {
  const root = mkdtempSync(join(tmpdir(), "aspace-logging-mail-"));
  roots.push(root);
  const { sink, log } = memoryLog();
  const app = createApp({
    paths: libraryPaths(join(root, "project")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    log,
  });
  const ids: { gmail?: string; custom?: string } = {};

  test("adding an account with a preset: the login checks are recorded under the preset's name", async () => {
    const res = await app.request(
      "/api/mail/accounts",
      json("POST", {
        preset: "gmail",
        address: MARK.address,
        displayName: "Zqxmark Person",
        password: MARK.password,
      })
    );
    expect(res.status).toBe(201);
    ids.gmail = ((await res.json()) as { account: { id: string } }).account.id;
    // the fake protocol was really asked, with the host, the login name and the password
    expect(fakes.state.seen.map((s) => s.call)).toEqual(["verifyImapLogin", "verifySmtpLogin"]);
    expect(fakes.state.seen[0]?.target).toMatchObject({
      host: "imap.gmail.com",
      user: MARK.address,
      password: MARK.password,
    });
    expect(calls(sink)).toMatchObject([
      {
        level: "debug",
        protocol: "imap",
        call: "verifyImapLogin",
        provider: "gmail",
        outcome: "ok",
      },
      {
        level: "debug",
        protocol: "smtp",
        call: "verifySmtpLogin",
        provider: "gmail",
        outcome: "ok",
      },
    ]);
    for (const call of calls(sink)) expect(Object.keys(call).sort()).toEqual(CALL_KEYS);
    // the keychain answered: recorded by the credential store the service was built with
    expect(sink.records().filter((r) => r.event === "credentials.keychain_state")).toMatchObject([
      { level: "info", state: "available" },
    ]);
    expectNoMarkers(sink);
  });

  test("an account on a server of the user's own: `custom`, and the host nowhere", async () => {
    const from = sink.lines.length;
    const res = await app.request(
      "/api/mail/accounts",
      json("POST", {
        preset: "custom",
        address: MARK.otherAddress,
        displayName: "Zqxmark Person",
        imap: { host: MARK.host, port: 993, security: "tls" },
        smtp: { host: MARK.smtpHost, port: 587, security: "starttls" },
        imapUser: MARK.login,
        smtpUser: MARK.login,
        password: MARK.password,
      })
    );
    expect(res.status).toBe(201);
    ids.custom = ((await res.json()) as { account: { id: string } }).account.id;
    expect(fakes.state.seen.at(-2)?.target).toMatchObject({ host: MARK.host, user: MARK.login });
    expect(fakes.state.seen.at(-1)?.target).toMatchObject({ host: MARK.smtpHost });
    expect(calls(sink, from)).toMatchObject([
      { protocol: "imap", call: "verifyImapLogin", provider: "custom", outcome: "ok" },
      { protocol: "smtp", call: "verifySmtpLogin", provider: "custom", outcome: "ok" },
    ]);
    expectNoMarkers(sink);
  });

  test("reading goes through the default reading service: its calls are in the same log", async () => {
    const from = sink.lines.length;
    const folders = await app.request(`/api/mail/accounts/${ids.custom}/folders`);
    expect(folders.status).toBe(200);
    const refused = await app.request(`/api/mail/accounts/${ids.gmail}/messages?folder=INBOX`);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ code: "auth_failed" });
    expect(calls(sink, from)).toMatchObject([
      { level: "debug", call: "listFolders", provider: "custom", outcome: "ok" },
      {
        level: "warn",
        call: "listHeaders",
        provider: "gmail",
        outcome: "failed",
        code: "auth_failed",
      },
    ]);
    expectNoMarkers(sink);
  });

  test("searching and discarding a draft go through the default managing and writing services: same log", async () => {
    const from = sink.lines.length;
    const searched = await app.request(
      `/api/mail/accounts/${ids.custom}/messages/search`,
      json("POST", { folder: "INBOX", criteria: { text: MARK.search } })
    );
    expect(searched.status).toBe(502);
    expect(await searched.json()).toMatchObject({ code: "timeout" });
    const discarded = await app.request(
      `/api/mail/compose/accounts/${ids.gmail}/draft/discard`,
      json("POST", {
        messageId: MARK.messageId,
        inReplyTo: null,
        references: [],
        to: MARK.recipient,
        cc: "",
        bcc: "",
        subject: MARK.subject,
        text: MARK.body,
        attachments: [],
      })
    );
    expect(discarded.status).toBe(200);
    expect(fakes.state.seen.slice(-2).map((s) => s.call)).toEqual(["search", "deleteDraft"]);
    expect(calls(sink, from)).toMatchObject([
      {
        level: "warn",
        protocol: "imap",
        call: "search",
        provider: "custom",
        outcome: "failed",
        code: "timeout",
      },
      { level: "debug", protocol: "imap", call: "deleteDraft", provider: "gmail", outcome: "ok" },
    ]);
    expectNoMarkers(sink);
  });

  test("the account dialog's test of unsaved input: the typed host is not written, IMAP and SMTP each by their own", async () => {
    const from = sink.lines.length;
    const res = await app.request(
      "/api/mail/accounts/test",
      json("POST", {
        preset: "custom",
        address: MARK.address,
        // a host the user typed and never saved — and, for SMTP, a preset's server in capitals
        imap: { host: MARK.dialogHost, port: 993, security: "tls" },
        smtp: { host: "SMTP.Mail.Me.Com", port: 587, security: "starttls" },
        imapUser: MARK.login,
        smtpUser: MARK.login,
        password: MARK.password,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imap: { ok: false, code: "host_not_found" } });
    expect(fakes.state.seen.some((s) => (s.target as Target).host === MARK.dialogHost)).toBe(true);
    const recorded = calls(sink, from);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        level: "warn",
        protocol: "imap",
        call: "verifyImapLogin",
        provider: "custom",
        outcome: "failed",
        code: "host_not_found",
      })
    );
    expect(recorded).toContainEqual(
      expect.objectContaining({ protocol: "smtp", call: "verifySmtpLogin", provider: "icloud" })
    );
    for (const call of recorded)
      expect(Object.keys(call).sort()).toEqual(
        [...CALL_KEYS, ...("code" in call ? ["code"] : [])].sort()
      );
    expectNoMarkers(sink);
  });

  test("a protocol object that throws: `threw`, and nothing of what it threw", async () => {
    const from = sink.lines.length;
    fakes.state.throwOn = "listFolders";
    fakes.state.thrown = MARK.thrown;
    try {
      const res = await app.request(`/api/mail/accounts/${ids.custom}/folders`);
      expect(res.status).toBe(500);
      // the route answers with its fixed text, as it does without a log
      expect(await res.json()).toEqual({ code: "storage", detail: "mail account storage failed" });
    } finally {
      fakes.state.throwOn = null;
    }
    const [threw] = calls(sink, from);
    expect(threw).toMatchObject({
      level: "warn",
      protocol: "imap",
      call: "listFolders",
      provider: "custom",
      outcome: "threw",
    });
    expect(Object.keys(threw ?? {}).sort()).toEqual(CALL_KEYS);
    // the failed request is recorded too, without the error's text
    expect(sink.records().slice(from)).toContainEqual(
      expect.objectContaining({ event: "request.failed", status: 500, code: "storage" })
    );
    expectNoMarkers(sink);
  });
});

// --------------------------------------------------------------------------- //
// 2. Which servers have a name
// --------------------------------------------------------------------------- //

describe("the provider a mail server is recorded as", () => {
  test("a preset's server by the preset's name — the whole host name, in either case, per protocol", () => {
    expect(mailProvider("imap", { host: "imap.gmail.com" })).toBe("gmail");
    expect(mailProvider("smtp", { host: "smtp.gmail.com" })).toBe("gmail");
    expect(mailProvider("imap", { host: "imap.mail.me.com" })).toBe("icloud");
    expect(mailProvider("smtp", { host: "smtp.mail.me.com" })).toBe("icloud");
    expect(mailProvider("imap", { host: "IMAP.GMAIL.COM" })).toBe("gmail");
    // every preset that has a server is recognized by it: the table is the dialog's own
    for (const preset of Object.values(MAIL_PRESETS)) {
      if (preset.imap) expect(mailProvider("imap", preset.imap)).toBe(preset.id);
      if (preset.smtp) expect(mailProvider("smtp", preset.smtp)).toBe(preset.id);
    }
  });

  test("everything else is `custom`: no suffix, no substring, not the other protocol's host", () => {
    for (const host of [
      MARK.host,
      "gmail.com",
      "mail.gmail.com",
      "imap.gmail.com.zqxmark-institute.test",
      "zqxmark.imap.gmail.com",
      "imap.gmail.com.",
      " imap.gmail.com",
      "127.0.0.1",
      "",
    ])
      expect(mailProvider("imap", { host }), host).toBe("custom");
    // the SMTP host of a preset is not its IMAP host
    expect(mailProvider("imap", { host: "smtp.gmail.com" })).toBe("custom");
    expect(mailProvider("smtp", { host: "imap.gmail.com" })).toBe("custom");
    for (const target of [undefined, null, {}, { host: 7 }, "imap.gmail.com"])
      expect(mailProvider("imap", target)).toBe("custom");
  });
});

// --------------------------------------------------------------------------- //
// 3. observedMail, call by call
// --------------------------------------------------------------------------- //

describe("observedMail: every call of the four protocol interfaces", () => {
  const target = {
    host: MARK.host,
    port: 993,
    security: "tls",
    user: MARK.login,
    password: MARK.password,
  };
  const raw = Buffer.from(`Subject: ${MARK.subject}\r\n\r\n${MARK.body}`);
  const ref = { folder: MARK.folder, uid: 7, uidValidity: 3 };
  /** Each call with arguments a real caller passes, all of them marked. */
  const ARGUMENTS: Record<(typeof MAIL_CALLS)[number], unknown> = {
    verifyImapLogin: undefined,
    verifySmtpLogin: undefined,
    listFolders: undefined,
    listHeaders: { folder: MARK.folder, limit: 50 },
    openMessage: { ...ref, wantSource: true, markSeen: true, maxBytes: 1000 },
    setFlag: { ...ref, flag: "seen", value: true },
    move: { ...ref, destination: MARK.folder },
    remove: { ...ref, permanent: false },
    search: { folder: MARK.folder, criteria: { text: MARK.search, from: MARK.address }, limit: 50 },
    saveDraft: { raw, messageId: MARK.messageId },
    findDraft: { messageId: MARK.messageId },
    deleteDraft: { messageId: MARK.messageId },
    appendSent: { raw },
    sendSmtp: { from: MARK.address, to: [MARK.recipient], raw },
  };
  /** What a protocol object might answer with, were it to carry everything it saw. */
  const marked = {
    folder: MARK.folder,
    headers: [{ subject: MARK.subject, from: { name: "Zqxmark", address: MARK.address } }],
    source: raw,
    detail: MARK.reply,
    response: MARK.reply,
  };
  const implementation = (answer: () => unknown) => {
    const seen: Array<{ call: string; args: unknown[] }> = [];
    const impl = Object.fromEntries(
      MAIL_CALLS.map((call) => [
        call,
        async (...args: unknown[]) => {
          seen.push({ call, args });
          return answer();
        },
      ])
    );
    return { impl, seen };
  };

  test("the table covers every call the log knows", () => {
    expect(Object.keys(ARGUMENTS).sort()).toEqual([...MAIL_CALLS].sort());
    expect(MAIL_CALLS).toHaveLength(14);
  });

  test.each(MAIL_CALLS.map((call) => [call] as const))(
    "%s: succeeded, failed and threw — the same few fields each time",
    async (call) => {
      const { sink, log } = memoryLog();
      const protocol = call === "verifySmtpLogin" || call === "sendSmtp" ? "smtp" : "imap";
      const invoke = (object: object): Promise<unknown> =>
        (object as Record<string, (...args: unknown[]) => Promise<unknown>>)[call]?.(
          target,
          ARGUMENTS[call]
        ) as Promise<unknown>;

      // it worked: the result goes back as it was given
      const ok = { ok: true, value: marked };
      const worked = implementation(() => ok);
      expect(await invoke(observedMail(worked.impl, log))).toBe(ok);
      expect(worked.seen).toEqual([{ call, args: [target, ARGUMENTS[call]] }]);
      // it failed: a code of the table is written, the rest of the answer is not looked at
      const failure = { ok: false, code: "auth_failed", ...marked };
      expect(await invoke(observedMail(implementation(() => failure).impl, log))).toBe(failure);
      // a code that is not in the table is not written as it is
      const strange = { ok: false, code: MARK.reply };
      expect(await invoke(observedMail(implementation(() => strange).impl, log))).toBe(strange);
      // it threw: the same error is thrown on
      const error = new Error(MARK.thrown);
      const throwing = implementation(() => {
        throw error;
      });
      await expect(invoke(observedMail(throwing.impl, log))).rejects.toBe(error);

      const records = calls(sink);
      expect(records).toMatchObject([
        { level: "debug", protocol, call, provider: "custom", outcome: "ok" },
        {
          level: "warn",
          protocol,
          call,
          provider: "custom",
          outcome: "failed",
          code: "auth_failed",
        },
        {
          level: "warn",
          protocol,
          call,
          provider: "custom",
          outcome: "failed",
          code: "<invalid-enum>",
        },
        { level: "warn", protocol, call, provider: "custom", outcome: "threw" },
      ]);
      expect(sink.lines).toHaveLength(4);
      expect(Object.keys(records[0] ?? {}).sort()).toEqual(CALL_KEYS);
      expect(Object.keys(records[1] ?? {}).sort()).toEqual([...CALL_KEYS, "code"].sort());
      expect(Object.keys(records[2] ?? {}).sort()).toEqual([...CALL_KEYS, "code"].sort());
      expect(Object.keys(records[3] ?? {}).sort()).toEqual(CALL_KEYS);
      expectNoMarkers(sink);
    }
  );

  test("anything that is not one of the calls is passed through unrecorded", async () => {
    const { sink, log } = memoryLog();
    const watched = observedMail({ other: async () => MARK.body, value: MARK.subject }, log);
    expect(await watched.other()).toBe(MARK.body);
    expect(watched.value).toBe(MARK.subject);
    expect(sink.lines).toEqual([]);
  });
});
