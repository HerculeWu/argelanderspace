/**
 * What the server logs about jobs, external programs, web services, mail servers, the mail watcher and the Copilot
 * (desktop-app ticket 07) — and, above all, what it does not: the reverse privacy test.
 *
 * Every flow below is run over HTTP against a real server writing a real log FILE at level `debug` (the level that
 * writes the most). The data that goes through carries marker strings: an ADS token, a mailbox password, a mail's
 * body / subject / sender, a Doc's text, an annotation, a note, a manuscript cell, a Copilot conversation, a
 * discovery seed, TeX source that fails to compile, a mail server's reply, a Work title (from which the Work id and
 * the Doc id are made). After each flow two things are checked: the records this ticket added are there (a log that
 * is silent would pass any "no marker" test), and no marker, in any spelling, is anywhere in the log directory.
 *
 * Only the edges are replaced: the model provider is scripted, the mail servers are the fake IMAP / SMTP servers of
 * infra's tests, and the web services are an offline `fetch`. TeX is the real one.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  AnnotationsFile,
  ConversationSnapshot,
  Job,
  MailAccount,
  PageContext,
} from "@argelanderspace/contracts";
import {
  emptyWork,
  LibraryStore,
  libraryPaths,
  plansPath,
  uploadDocId,
} from "@argelanderspace/core";
import {
  createCredentialStore,
  createLogger,
  createMailAccountStore,
  createNodeMailInboxWatcher,
  createNodeMailMailbox,
  createNodeMailProtocol,
  type FetchImpl,
  haveLatexmk,
  type KeychainBackend,
  type LogFile,
  type LogJson,
  locateToolchain,
  openLogFile,
} from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  type FakeIdleMailbox,
  startFakeIdleMailbox,
} from "../../infra/tests/mail/fake-idle-mailbox.js";
import {
  type FakeMailbox,
  plainMail,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import {
  type Fake,
  startFakeImap,
  startFakeSmtp,
  TEST_PASSWORD,
  TEST_USER,
} from "../../infra/tests/mail/fake-servers.js";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import {
  jobLogger,
  logEnvironment,
  observedCredentials,
  observedMail,
} from "../src/log-observers.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { MailCache } from "../src/mail-cache.js";
import { MailReadService } from "../src/mail-read.js";
import { ProviderSettings } from "../src/providers.js";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeZip, stubPipelines, stubSources } from "./helpers.js";
import { logText, markersInText, ROOT } from "./log-markers.js";

// --------------------------------------------------------------------------- //
// Markers
// --------------------------------------------------------------------------- //

const MARK = {
  adsToken: "ZqxMarkAdsToken7f3a91",
  mailPassword: "ZqxMarkMailPassword5c2e",
  mailBody: "ZqxMarkMailBody the grant was rejected",
  mailSubject: "ZqxMarkMailSubject about the referee",
  mailFrom: "zqxmark.sender@zqxmark-mail.test",
  mailFromName: "Zqxmark Sender",
  // A login name is usually the mail address itself.
  mailLogin: "zqxmark.login@zqxmark-login.test",
  serverReply: "ZqxMarkServerReply mailbox of dr.someone is locked",
  docBody: "ZqxMarkDocBody an unpublished result",
  annotation: "ZqxMarkAnnotation this proof is wrong",
  note: "ZqxMarkNote ask the supervisor",
  cell: "ZqxMarkCell draft paragraph of the thesis",
  chat: "ZqxMarkChat please summarize my secret plan",
  chatReply: "ZqxMarkChatReply here is the summary",
  toolArgument: "ZqxMarkToolArgument",
  providerError: "ZqxMarkProviderError the account of someone@zqxmark-lab.test is suspended",
  discoverySeed: "2026ZqxMarkSeed.....A",
  texSource: "zqxmarkundefinedmacro",
  title: "Zqxmark Hidden Thesis Title",
  networkError: "ZqxMarkNetworkError connect to proxy.private.example",
  serviceBody: "ZqxMarkServiceBody",
} as const;
// The Work has no DOI or arXiv number, so its id is made from its title — and the upload Doc id from that.
const WORK_ID = "work:zqxmark-hidden-thesis-title-2001";
const DOC_ID = uploadDocId(WORK_ID);
const BROKEN_WORK_ID = "work:zqxmark-broken-source-2002";
// A Doc made from a local folder: its id is the folder's name.
const LOCAL_DOC_ID = "latex-zqxmark-local-folder";
const hashOf = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);

/** Every marker spelling found in the directory's files (empty = the log can be handed on). */
function markersIn(dir: string): string[] {
  return markersInText(logText(dir), [
    ...Object.values(MARK),
    WORK_ID,
    DOC_ID,
    BROKEN_WORK_ID,
    LOCAL_DOC_ID,
    TEST_PASSWORD,
  ]);
}

// --------------------------------------------------------------------------- //
// The server under test
// --------------------------------------------------------------------------- //

type LogRecord = Record<string, LogJson>;
let root: string;
let logDir: string;
let dataDir: string;
let globalData: string;
let file: LogFile;
let log: ServerLog;
let srv: RunningServer;
let settings: ProviderSettings;
let script: Array<() => { text?: string; call?: Record<string, unknown>; error?: string }> = [];
let adsKeyFile: string;

const records = (): LogRecord[] =>
  logText(logDir)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogRecord);
const eventsNamed = (name: string, from = 0): LogRecord[] =>
  records()
    .slice(from)
    .filter((record) => record.event === name);
const mark = (): number => records().length;

/** A stack frame as it is written: the location of code — a file and a line and column, no function name. */
const FRAME = /^(?:node:[A-Za-z0-9_/.-]+|(?:~|[A-Za-z]:)?[\\/][^\s()]*):\d+:\d+$/;

/** After a flow: nothing of any marker is in the log directory. */
function expectNoMarkers(): void {
  expect(markersIn(logDir)).toEqual([]);
}

// ---- the web services: an offline fetch ---------------------------------------
const requests: Array<{ url: string; authorization: string | null }> = [];
const web = { ads: "ok" as "ok" | "error" | "down" };
const fetchStub: FetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
  const host = new URL(url).host;
  if (host === "api.adsabs.harvard.edu") {
    if (web.ads === "down") {
      // What undici throws: a TypeError whose cause names the address.
      throw new TypeError(`fetch failed ${MARK.networkError}`, {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${MARK.networkError}`), {
          code: "ECONNREFUSED",
        }),
      });
    }
    if (web.ads === "error") return new Response(`upstream ${MARK.serviceBody}`, { status: 500 });
    return Response.json({
      response: { docs: [{ bibcode: "2001ZqxM....1....A", title: [MARK.title], year: "2001" }] },
    });
  }
  if (host === "api.crossref.org") return new Response(MARK.serviceBody, { status: 404 });
  if (host === "api.openalex.org") return new Response(MARK.serviceBody, { status: 503 });
  return new Response(MARK.serviceBody, { status: 404 });
};

// ---- mail: fake servers, an isolated account list, a keychain that is a Map ------
const keychain = new Map<string, string>();
const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});
const GOOD = "acc-0123456789ab";
const REFUSED = "acc-ba9876543210";
let idle: FakeIdleMailbox;
let mailbox: FakeMailbox;
let fakeImap: Fake;
let fakeSmtp: Fake;
let mailApp: ReturnType<typeof createApp>;

const account = (id: string, port: number, user: string = TEST_USER): MailAccount => ({
  id: id as never,
  displayName: MARK.mailFromName,
  address: MARK.mailFrom,
  preset: "custom",
  imap: { host: "127.0.0.1", port, security: "tls" },
  smtp: { host: "127.0.0.1", port: 1, security: "tls" },
  imapUser: user,
  smtpUser: user,
  credentialRef: id as never,
  credentialProtection: "keychain",
});

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const waitJob = async (id: string): Promise<Job> => srv.runner.waitFor(id);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aspace-logging-coverage-"));
  logDir = join(root, "global", "logs");
  dataDir = join(root, "project", "literatures");
  globalData = join(root, "global");
  mkdirSync(dataDir, { recursive: true });

  // 1. the ADS token: in the isolated home's key file, imported below into the credential store through the settings
  //    endpoint (desktop-app ticket 12; the clients no longer read the file itself)
  adsKeyFile = join(homedir(), ".ads", "dev_key");
  expect(adsKeyFile.startsWith(tmpdir() + sep)).toBe(true);
  mkdirSync(join(homedir(), ".ads"), { recursive: true });
  writeFileSync(adsKeyFile, `${MARK.adsToken}\n`);

  // the library: two Works known only by their titles
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir ?? join(dataDir, "library"), { recursive: true });
  const store = LibraryStore.load(paths);
  store.works = [
    { ...emptyWork(WORK_ID), title: MARK.title, cite_key: "zqx2001", year: 2001 },
    {
      ...emptyWork(BROKEN_WORK_ID),
      title: "Zqxmark Broken Source",
      cite_key: "zqx2002",
      year: 2002,
    },
  ];
  store.save(paths);
  mkdirSync(statusDirFor(dataDir), { recursive: true });
  writeFileSync(
    plansPath(statusDirFor(dataDir)),
    JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2)
  );

  // the log: a real file, at the level that writes the most
  file = openLogFile({ dir: logDir, process: "serve" });
  expect(file.path).not.toBeNull();
  log = createLogger({ events: SERVER_LOG_EVENTS, sink: file, level: "debug" });

  // the model: scripted
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, _context: TranscriptContext) {
      const step = script.shift();
      const out: ReturnType<(typeof script)[number]> = step ? step() : { text: "done" };
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: out.call
          ? [
              {
                type: "toolCall",
                id: `call_${randomUUID()}`,
                name: "plan",
                arguments: out.call as never,
              },
            ]
          : [{ type: "text", text: out.text ?? "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: out.call ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        if (out.error !== undefined) {
          // The provider failed, with a text of its own.
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message, content: [], stopReason: "error", errorMessage: out.error },
          });
          return;
        }
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      });
      return stream;
    },
  });

  // mail: one account whose login the server refuses with a text of its own, watched by the server
  idle = await startFakeIdleMailbox(2, 1);
  idle.loginRefusal = `[AUTHENTICATIONFAILED] ${MARK.serverReply}`;
  const accounts = createMailAccountStore({ dataDir: globalData });
  const credentials = createCredentialStore({ backend: backend(), dataDir: globalData });
  await credentials.set(REFUSED, MARK.mailPassword, { fileFallbackConsent: false });
  await accounts.update(0, async () => ({
    accounts: [account(REFUSED, idle.port, MARK.mailLogin)],
    result: null,
  }));

  srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    webDist: null,
    heartbeatMs: 0,
    log,
    fetchImpl: fetchStub,
    providerSettings: settings,
    adsCredentials: createCredentialStore({
      purpose: "ads",
      backend: backend(),
      dataDir: globalData,
    }),
    mailWatch: {
      accounts,
      credentials,
      inbox: createNodeMailInboxWatcher({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    },
  });
  await srv.ready();
  // The ADS token goes into the credential store the way a user puts it there: the import from ~/.ads/dev_key.
  const imported = await srv.app.request("/api/credentials/ads/import", json("POST", {}));
  expect(imported.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await srv?.close();
  file?.close();
  await Promise.all([idle?.close(), mailbox?.close(), fakeImap?.close(), fakeSmtp?.close()]);
  rmSync(adsKeyFile, { force: true });
  rmSync(root, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- //
// The flows
// --------------------------------------------------------------------------- //

test("the start: which tools were found and from where, by name only; whether the keychain can be used", async () => {
  const from = mark();
  const bin = join(root, "bin");
  const texDir = join(root, "texbin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(texDir, { recursive: true });
  writeFileSync(join(bin, "pdftocairo"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(texDir, "latexmk"), "#!/bin/sh\n", { mode: 0o755 });
  // desktop-app ticket 13: the full lookup (the TeX directory, then PATH), and the keychain probe (a fake here)
  await logEnvironment(log, {
    toolchain: locateToolchain({ texDir, platform: "linux", env: { PATH: bin } }),
    keychain: async () => ({ state: "unavailable", reason: "no_bus" }),
  });
  const [record] = eventsNamed("server.environment", from);
  // bubblewrap is also looked for in the system directories (where the sandbox runs it from): found there or not
  const bwrapHere = (record?.tools_found as string[] | undefined)?.includes("bwrap") === true;
  expect(record).toMatchObject({
    level: "info",
    tools_found: bwrapHere ? ["latexmk", "pdftocairo", "bwrap"] : ["latexmk", "pdftocairo"],
    tools_from_tex_dir: ["latexmk"],
    tools_from_common: bwrapHere ? ["bwrap"] : [],
    tex_dir: "ok",
    keychain: "unavailable",
    keychain_reason: "no_bus",
  });
  expect(record?.tools_missing).toContain("ghostscript");
  expect(JSON.stringify(record)).not.toContain(bin);
  expect(JSON.stringify(record)).not.toContain(texDir);
  expectNoMarkers();
});

test("the start record names what is the matter with the TeX directory: missing, no latexmk, not absolute", async () => {
  const empty = join(root, "empty-texdir");
  mkdirSync(empty, { recursive: true });
  const cases: [string, string][] = [
    [join(root, "no-such-texdir"), "missing"],
    [empty, "no_latexmk"],
    ["relative/texdir", "not_absolute"],
  ];
  for (const [texDir, state] of cases) {
    const from = mark();
    await logEnvironment(log, {
      toolchain: locateToolchain({ texDir, platform: "linux", env: { PATH: join(root, "bin") } }),
      keychain: async () => ({ state: "unknown", reason: "no_probe" }),
    });
    const [record] = eventsNamed("server.environment", from);
    expect(record?.tex_dir).toBe(state);
    expect(JSON.stringify(record)).not.toContain(texDir);
  }
});

test("mail watcher: a refused login is a state and a code — not the server's reply, the address or the password", async () => {
  await vi.waitFor(
    () => expect(eventsNamed("mail_watch.state_changed").at(-1)?.state).toBe("auth_failed"),
    { timeout: 10_000 }
  );
  expect(eventsNamed("mail_watch.state_changed").at(-1)).toMatchObject({
    level: "warn",
    account: REFUSED,
    state: "auth_failed",
    previous: "connecting",
  });
  expect(eventsNamed("mail_watch.connection_ended").at(-1)).toMatchObject({
    account: REFUSED,
    code: "auth_failed",
    temporary_refusal: "no",
  });
  // the keychain answered (the fake one): recorded from what the watcher read anyway
  expect(eventsNamed("credentials.keychain_state")[0]).toMatchObject({ state: "available" });
  // the watch state is what the page gets too
  const unread = (await (await srv.app.request("/api/mail/unread")).json()) as {
    accounts: { watch: string }[];
  };
  expect(unread.accounts[0]?.watch).toBe("auth_failed");
  expectNoMarkers();
});

test("mail servers: every call by name, provider and code; nothing of the mail, the address, the login name or the reply", async () => {
  const from = mark();
  mailbox = await startFakeMailbox([
    {
      path: "INBOX",
      uidValidity: 7,
      messages: [
        plainMail({
          uid: 1,
          subject: MARK.mailSubject,
          from: [MARK.mailFromName, MARK.mailFrom],
          date: "Tue, 01 Sep 2026 10:00:00 +0000",
          body: MARK.mailBody,
        }),
      ],
    },
  ]);
  fakeImap = await startFakeImap("tls");
  fakeSmtp = await startFakeSmtp("tls");
  const mailData = join(root, "mail-global");
  const store = createMailAccountStore({ dataDir: mailData });
  const credentials = observedCredentials(
    createCredentialStore({ backend: backend(), dataDir: mailData }),
    log
  );
  await credentials.set(GOOD, TEST_PASSWORD, { fileFallbackConsent: false });
  await credentials.set(REFUSED, MARK.mailPassword, { fileFallbackConsent: false });
  await store.update(0, async () => ({
    accounts: [account(GOOD, mailbox.port), account(REFUSED, mailbox.port, MARK.mailLogin)],
    result: null,
  }));
  const tls = { timeoutMs: 3000, tls: { rejectUnauthorized: false } };
  // The services as `createDefaultMail*Service(log)` builds them, over the fake servers instead of the real ones.
  mailApp = createApp({
    paths: libraryPaths(join(root, "mail-project")),
    statusDir: join(root, "mail-status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "mail-jobs") }),
    mailRead: new MailReadService({
      accounts: store,
      credentials,
      mailbox: observedMail(createNodeMailMailbox(tls), log),
      cache: new MailCache(() => join(root, "mail-cache")),
    }),
    mailAccounts: new MailAccountService({
      store,
      credentials,
      protocol: observedMail(createNodeMailProtocol(tls), log),
      cacheDir: () => join(root, "mail-cache"),
    }),
    log,
  });

  // reading: the list and the message itself reach the page …
  const headers = await mailApp.request(`/api/mail/accounts/${GOOD}/messages?folder=INBOX`);
  expect(headers.status).toBe(200);
  expect(await headers.text()).toContain(MARK.mailSubject);
  const opened = await mailApp.request(
    `/api/mail/accounts/${GOOD}/messages/open`,
    json("POST", { folder: "INBOX", uid: 1, uidValidity: 7, unread: true })
  );
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain(MARK.mailBody);
  // … a login the server refuses (the stored password is the marker) …
  const refused = await mailApp.request(`/api/mail/accounts/${REFUSED}/folders`);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject({ code: "auth_failed" });
  // … and the login test of the account dialog, IMAP and SMTP, with a wrong password.
  const probe = await mailApp.request(
    "/api/mail/accounts/test",
    json("POST", {
      preset: "custom",
      address: MARK.mailFrom,
      imap: { host: "127.0.0.1", port: fakeImap.port, security: "tls" },
      smtp: { host: "127.0.0.1", port: fakeSmtp.port, security: "tls" },
      imapUser: MARK.mailLogin,
      smtpUser: MARK.mailLogin,
      password: MARK.mailPassword,
    })
  );
  expect(probe.status).toBe(200);
  expect(await probe.json()).toMatchObject({
    imap: { ok: false, code: "auth_failed" },
    smtp: { ok: false, code: "auth_failed" },
  });

  const calls = eventsNamed("mail.remote_call", from);
  expect(calls).toContainEqual(
    expect.objectContaining({
      level: "debug",
      protocol: "imap",
      call: "listHeaders",
      outcome: "ok",
      // 127.0.0.1 is no preset's server
      provider: "custom",
    })
  );
  expect(calls).toContainEqual(expect.objectContaining({ call: "openMessage", outcome: "ok" }));
  expect(calls).toContainEqual(
    expect.objectContaining({
      level: "warn",
      call: "listFolders",
      outcome: "failed",
      code: "auth_failed",
    })
  );
  expect(calls).toContainEqual(
    expect.objectContaining({ protocol: "imap", call: "verifyImapLogin", code: "auth_failed" })
  );
  expect(calls).toContainEqual(
    expect.objectContaining({
      protocol: "smtp",
      call: "verifySmtpLogin",
      outcome: "failed",
      code: "auth_failed",
      provider: "custom",
    })
  );
  // a mail call is recorded by these fields and no others
  for (const call of calls)
    expect(Object.keys(call).sort()).toEqual(
      [
        "call",
        "code",
        "duration_ms",
        "event",
        "level",
        "outcome",
        "protocol",
        "provider",
        "t",
      ].filter((key) => key !== "code" || "code" in call)
    );
  expectNoMarkers();
});

test("web services: host, status and duration; no query, token or body — answered, refused and unreachable", async () => {
  const from = mark();
  const seed = encodeURIComponent(MARK.discoverySeed);
  // 6. a discovery whose seed is the marker: the request really goes out, with the token
  web.ads = "ok";
  await srv.app.request(`/api/library/discovery?bibcode=${seed}`);
  const sent = requests.filter((r) => r.url.includes("api.adsabs.harvard.edu"));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]?.authorization).toBe(`Bearer ${MARK.adsToken}`);
  expect(decodeURIComponent(sent[0]?.url ?? "")).toContain(MARK.discoverySeed);
  expect(eventsNamed("external_service.answered", from)).toContainEqual(
    expect.objectContaining({
      level: "debug",
      service: "ads",
      host: "https://api.adsabs.harvard.edu",
      status: 200,
    })
  );
  // the service answers 500 with a body of its own
  web.ads = "error";
  const failed = await srv.app.request(`/api/library/discovery?bibcode=${seed}B`);
  expect(failed.status).toBeGreaterThanOrEqual(500);
  expect(eventsNamed("external_service.answered", from)).toContainEqual(
    expect.objectContaining({ level: "warn", service: "ads", status: 500 })
  );
  // no answer at all: the error (its message and its cause name an address) is recorded as a reason only
  web.ads = "down";
  const down = await srv.app.request(`/api/library/discovery?bibcode=${seed}C`);
  expect(down.status).toBeGreaterThanOrEqual(500);
  const [none] = eventsNamed("external_service.no_answer", from);
  expect(none).toMatchObject({ level: "warn", service: "ads", reason: "network" });
  expect(Object.keys(none ?? {}).sort()).toEqual(
    ["duration_ms", "event", "host", "level", "reason", "service", "t"].sort()
  );
  web.ads = "ok";
  expectNoMarkers();
});

test("the ADS credential endpoints (ticket 12): saving, testing, importing, removing log no token", async () => {
  const from = mark();
  const other = `${MARK.adsToken}Other`;
  const put = await srv.app.request("/api/credentials/ads", json("PUT", { token: other }));
  expect(put.status).toBe(200);
  expect(await (await srv.app.request("/api/credentials/ads")).text()).not.toContain(MARK.adsToken);
  // the saved token and an input not yet saved, each tested against the offline ADS
  for (const body of [{}, { token: `${MARK.adsToken}Unsaved` }]) {
    const tested = await srv.app.request("/api/credentials/ads/test", json("POST", body));
    expect(await tested.json()).toEqual({ ok: true, result: "valid" });
  }
  expect(requests.filter((r) => r.authorization === `Bearer ${other}`).length).toBeGreaterThan(0);
  expect(eventsNamed("external_service.answered", from)).toContainEqual(
    expect.objectContaining({ service: "ads", host: "https://api.adsabs.harvard.edu", status: 200 })
  );
  expect((await srv.app.request("/api/credentials/ads", { method: "DELETE" })).status).toBe(200);
  // back to the token the other flows use, by the import again
  expect((await srv.app.request("/api/credentials/ads/import", json("POST", {}))).status).toBe(200);
  expectNoMarkers();
});

const upload = async (workId: string, tex: string): Promise<Response> =>
  srv.app.request(`/api/library/upload?id=${encodeURIComponent(workId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: makeZip({ "main.tex": tex }),
  });

test("an annotation and a note (no TeX needed): the requests by route pattern, the Doc's folder-made id never", async () => {
  const from = mark();
  // A Doc as an ingest of a local folder leaves it: the id is the folder's name, the text is the user's.
  const dir = join(dataDir, "output", LOCAL_DOC_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${LOCAL_DOC_ID}.json`),
    JSON.stringify({
      version: 1,
      docId: LOCAL_DOC_ID,
      sections: [],
      refsManifest: [],
      bib: [],
      citationsByBlock: {},
      source: { type: "latex", origin: dir, main_tex: "main.tex" },
      meta: { title: MARK.title, abstract: MARK.docBody },
    })
  );
  const read = await srv.app.request(`/api/paper/${LOCAL_DOC_ID}/annotations`);
  expect(read.status).toBe(200);
  const current = (await read.json()) as AnnotationsFile;
  const saved = await srv.app.request(
    `/api/paper/${LOCAL_DOC_ID}/annotations`,
    json("PUT", {
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: [
        {
          id: "a_0123abcd",
          target: { type: "document" },
          body: MARK.annotation,
          created_at: "2026-09-10T10:00:00.000Z",
          updated_at: "2026-09-10T10:00:00.000Z",
        },
      ],
    })
  );
  expect(saved.status).toBe(200);
  // the annotation is on disk, with its text
  const stored = await srv.app.request(`/api/paper/${LOCAL_DOC_ID}/annotations`);
  expect(await stored.text()).toContain(MARK.annotation);
  // a refused write too (a stale rev): a failed request, by pattern, status and code
  const stale = await srv.app.request(
    `/api/paper/${LOCAL_DOC_ID}/annotations`,
    json("PUT", {
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: [],
    })
  );
  expect(stale.status).toBe(409);
  // a note on a Work
  const noted = await srv.app.request(
    "/api/library/refs",
    json("PATCH", { id: WORK_ID, note: MARK.note })
  );
  expect(noted.status).toBe(200);
  expect(readFileSync(libraryPaths(dataDir).libraryJson, "utf8")).toContain(MARK.note);

  // the requests themselves: by route pattern, never by path (the Doc id is in the path)
  expect(eventsNamed("request.completed", from)).toContainEqual(
    expect.objectContaining({ method: "PUT", route: "/api/paper/:doc_id/annotations", status: 200 })
  );
  expect(eventsNamed("request.completed", from)).toContainEqual(
    expect.objectContaining({ method: "PATCH", route: "/api/library/refs", status: 200 })
  );
  expect(eventsNamed("request.failed", from)).toContainEqual(
    expect.objectContaining({ method: "PUT", route: "/api/paper/:doc_id/annotations", status: 409 })
  );
  expect(logText(logDir)).not.toContain(LOCAL_DOC_ID);
  expectNoMarkers();
});

test.skipIf(!haveLatexmk())(
  "a Doc: the job and latexmk are recorded, the title-made ids as hashes",
  async () => {
    const from = mark();
    const res = await upload(
      WORK_ID,
      [
        "\\documentclass{article}",
        `\\title{${MARK.title}}`,
        "\\begin{document}",
        "\\maketitle",
        `${MARK.docBody}.`,
        "\\end{document}",
        "",
      ].join("\n")
    );
    expect(res.status).toBe(202);
    const { job: queued } = (await res.json()) as { job: Job };
    const job = await waitJob(queued.id);
    expect(job.status).toBe("done");
    // the Doc is there, with its text
    const ir = await srv.app.request(`/api/paper/${DOC_ID}/ir`);
    expect(ir.status).toBe(200);
    expect(await ir.text()).toContain(MARK.docBody);

    const mine = (name: string) => eventsNamed(name, from).filter((r) => r.job === job.id);
    expect(mine("job.created")[0]).toMatchObject({
      level: "info",
      kind: "upload",
      // the Work id is made from the title: written as its hash, the same one every time
      work: `work:#${hashOf(WORK_ID)}`,
    });
    expect(mine("job.started")).toHaveLength(1);
    expect(mine("job.progress").length).toBeGreaterThan(0);
    expect(mine("job.progress").every((r) => r.level === "debug")).toBe(true);
    expect(mine("job.done")[0]).toMatchObject({ level: "info", kind: "upload" });
    expect(typeof mine("job.done")[0]?.duration_ms).toBe("number");
    expect(eventsNamed("external_program.exited", from)).toContainEqual(
      expect.objectContaining({
        level: "info",
        program: "latexmk",
        sandboxed: "no",
        exit_code: 0,
        timed_out: "no",
      })
    );
    // The library rebuild that follows asks the three services about the Work — by its title, in the query. What is
    // recorded is each service's host and status: "not known" (404) at debug, a refusal (503) as a warning.
    expect(requests.some((r) => decodeURIComponent(r.url).toLowerCase().includes(ROOT))).toBe(true);
    const asked = eventsNamed("external_service.answered", from);
    expect(asked).toContainEqual(
      expect.objectContaining({
        level: "debug",
        service: "crossref",
        host: "https://api.crossref.org",
        status: 404,
      })
    );
    expect(asked).toContainEqual(
      expect.objectContaining({
        level: "warn",
        service: "openalex",
        host: "https://api.openalex.org",
        status: 503,
      })
    );
    // the requests themselves: by route pattern, never by path (the Doc id is in the path)
    expect(eventsNamed("request.completed", from)).toContainEqual(
      expect.objectContaining({ method: "GET", route: "/api/paper/:doc_id/ir" })
    );
    expect(logText(logDir)).not.toContain(DOC_ID);
    // At the default level this whole flow (an upload, a compile, a library rebuild that asks three services)
    // is a handful of records, not hundreds.
    const kept = records()
      .slice(from)
      .filter((record) => record.level !== "debug");
    expect(kept.length).toBeLessThan(12);
    expectNoMarkers();
  },
  180_000
);

test.skipIf(!haveLatexmk())(
  "a compile that fails: the job by id, kind, stage, category and the error's name and stack — not its text; latexmk by its exit code",
  async () => {
    const from = mark();
    const res = await upload(
      BROKEN_WORK_ID,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        `Before \\${MARK.texSource}{x} after.`,
        "\\end{document}",
        "",
      ].join("\n")
    );
    expect(res.status).toBe(202);
    const { job: queued } = (await res.json()) as { job: Job };
    const job = await waitJob(queued.id);
    expect(job.status).toBe("failed");
    // the job record (and the page) keep the excerpt of the TeX log, with the source in it …
    expect(job.error).toContain(MARK.texSource);

    // … the log has the job's id, kind, stage and category, what was thrown by name and stack, and nothing else.
    const [failed] = eventsNamed("job.failed", from);
    expect(failed).toMatchObject({
      level: "warn",
      job: job.id,
      kind: "upload",
      stage: "compile",
      category: "unclassified",
    });
    expect(Object.keys(failed ?? {}).sort()).toEqual(
      ["category", "duration_ms", "error", "event", "job", "kind", "level", "stage", "t"].sort()
    );
    const thrown = failed?.error as { name: string; stack: string[] };
    expect(Object.keys(thrown).sort()).toEqual(["name", "stack"]);
    expect(thrown.name).toBe("Error");
    expect(thrown.stack.length).toBeGreaterThan(0);
    for (const frame of thrown.stack) expect(frame).toMatch(FRAME);
    const runs = eventsNamed("external_program.exited", from).filter(
      (r) => r.program === "latexmk"
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.level === "warn" && r.exit_code !== 0)).toBe(true);
    expectNoMarkers();
  },
  240_000
);

test.skipIf(!haveLatexmk())(
  "a manuscript: its render is a latexmk run in the log, its cells are not",
  async () => {
    const from = mark();
    const created = await srv.app.request(
      "/api/writer/manuscripts",
      json("POST", { template: "report", title: MARK.title })
    );
    expect(created.status).toBe(201);
    const manuscript = (await created.json()) as {
      id: string;
      rev: number;
      cells: { id: string; type: string; data: Record<string, unknown> }[];
    };
    const cells = [
      ...manuscript.cells,
      { id: "c_0123abcd", type: "latex", data: { source: MARK.cell } },
    ];
    expect(JSON.stringify(cells)).toContain(MARK.cell);
    const put = await srv.app.request(
      `/api/writer/manuscripts/${manuscript.id}`,
      json("PUT", { ...manuscript, cells })
    );
    expect(put.status).toBe(200);
    const render = await srv.app.request(
      `/api/writer/manuscripts/${manuscript.id}/numbering/refresh`,
      json("POST", {})
    );
    expect(render.status).toBe(200);
    expect(((await render.json()) as { lastError: string | null }).lastError).toBeNull();
    const runs = eventsNamed("external_program.exited", from).filter(
      (r) => r.program === "latexmk"
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.sandboxed).toMatch(/^(yes|no)$/);
    expectNoMarkers();
  },
  240_000
);

const planPage = (viewId: string): PageContext =>
  ({
    version: 1,
    viewId,
    revision: 1,
    paneId: 1,
    view: "plan",
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 1,
      mode: "list",
      selectedPlanId: null,
      saveState: "saved",
      groups: [],
      detail: null,
      plans: [],
    },
  }) as unknown as PageContext;

test("Copilot: the run and each tool call by id, tool and result; nothing that was said", async () => {
  const from = mark();
  const created = await srv.app.request(
    "/api/copilot/conversations",
    json("POST", { model: { provider: "openai", model: "gpt-4.1", thinking: null } })
  );
  expect(created.status).toBe(201);
  const { conversation } = (await created.json()) as ConversationSnapshot;
  const viewId = randomUUID();
  const page = planPage(viewId);
  expect((await srv.app.request(`/api/copilot/views/${viewId}`, json("PUT", page))).status).toBe(
    200
  );
  script = [
    () => ({ call: { action: "read" } }),
    // a call the tool answers without doing it: a plan that is not there
    () => ({ call: { action: "read", planId: "plan-that-is-not-there" } }),
    // a call the tool refuses: its argument is the user's text
    () => ({ call: { action: MARK.toolArgument, planId: MARK.toolArgument } }),
    () => ({ text: MARK.chatReply }),
  ];
  const sent = await srv.app.request(
    `/api/copilot/conversations/${conversation.id}/messages`,
    json("POST", { clientMessageId: randomUUID(), text: MARK.chat, viewId, contextRevision: 1 })
  );
  expect(sent.status).toBe(202);
  const { runId } = (await sent.json()) as { runId: string };
  await vi.waitFor(() => expect(eventsNamed("copilot.run_finished", from)).toHaveLength(1), {
    timeout: 20_000,
  });
  // the conversation itself holds what was said
  const snapshot = await srv.app.request(`/api/copilot/conversations/${conversation.id}`);
  const told = await snapshot.text();
  expect(told).toContain(MARK.chat);
  expect(told).toContain(MARK.chatReply);

  expect(eventsNamed("copilot.run_started", from)[0]).toMatchObject({
    level: "info",
    conversation: conversation.id,
    run: runId,
  });
  expect(eventsNamed("copilot.run_finished", from)[0]).toMatchObject({
    level: "info",
    conversation: conversation.id,
    run: runId,
    status: "completed",
  });
  const tools = eventsNamed("copilot.tool_called", from);
  expect(tools).toHaveLength(3);
  // a call that did what was asked: one of many, at debug
  expect(tools[0]).toMatchObject({ level: "debug", run: runId, tool: "plan", result: "ok" });
  // every other end is kept at the default level, by its result category: answered "not there" …
  expect(tools[1]).toMatchObject({ level: "info", tool: "plan", result: "not_found" });
  // … and a call the tool refused by throwing (its argument was the user's text)
  expect(tools[2]).toMatchObject({ level: "info", tool: "plan", result: "thrown" });
  for (const tool of tools)
    expect(Object.keys(tool).sort()).toEqual(
      ["conversation", "duration_ms", "event", "level", "result", "run", "t", "tool"].sort()
    );
  expectNoMarkers();
}, 60_000);

test("Copilot: a run the provider fails is `failed` with a code from the list — not the provider's text", async () => {
  const from = mark();
  const created = await srv.app.request(
    "/api/copilot/conversations",
    json("POST", { model: { provider: "openai", model: "gpt-4.1", thinking: null } })
  );
  expect(created.status).toBe(201);
  const { conversation } = (await created.json()) as ConversationSnapshot;
  const viewId = randomUUID();
  expect(
    (await srv.app.request(`/api/copilot/views/${viewId}`, json("PUT", planPage(viewId)))).status
  ).toBe(200);
  // the provider fails every time it is asked (the host asks again once on its own)
  script = Array.from({ length: 6 }, () => () => ({ error: MARK.providerError }));
  const sent = await srv.app.request(
    `/api/copilot/conversations/${conversation.id}/messages`,
    json("POST", { clientMessageId: randomUUID(), text: MARK.chat, viewId, contextRevision: 1 })
  );
  expect(sent.status).toBe(202);
  const { runId } = (await sent.json()) as { runId: string };
  await vi.waitFor(() => expect(eventsNamed("copilot.run_finished", from)).toHaveLength(1), {
    timeout: 30_000,
  });
  script = [];
  const [finished] = eventsNamed("copilot.run_finished", from);
  expect(finished).toMatchObject({
    level: "warn",
    conversation: conversation.id,
    run: runId,
    status: "failed",
  });
  // the code is one of the list written in code (what the provider's failure was reduced to)
  expect(["provider_capacity", "rate_limit", "transient", "quota", "unavailable"]).toContain(
    finished?.code
  );
  expect(Object.keys(finished ?? {}).sort()).toEqual(
    ["code", "conversation", "duration_ms", "event", "level", "run", "status", "t"].sort()
  );
  // the page is told the same state
  const snapshot = (await (
    await srv.app.request(`/api/copilot/conversations/${conversation.id}`)
  ).json()) as ConversationSnapshot;
  expect(snapshot.conversation.run).toMatchObject({ status: "failed", error: finished?.code });
  expectNoMarkers();
}, 60_000);

test("a job the last run left unfinished is recorded as interrupted; a watcher that throws changes no job", async () => {
  const from = mark();
  const dir = join(root, "interrupted-jobs");
  mkdirSync(dir, { recursive: true });
  const id = `ingest-${randomUUID()}`;
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      kind: "ingest",
      status: "running",
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:01.000Z",
      finishedAt: null,
      progress: [{ at: "2026-10-01T00:00:02.000Z", message: `Compiling ${MARK.texSource}` }],
      result: null,
      error: null,
      payload: { workId: WORK_ID },
    })
  );
  const observe = jobLogger(log);
  const runner = new JobRunner({
    dir,
    observe: (transition) => {
      observe?.(transition);
      throw new Error("a watcher that fails");
    },
  });
  expect(eventsNamed("job.interrupted", from)).toEqual([
    expect.objectContaining({ level: "warn", job: id, kind: "ingest", stage: "compile" }),
  ]);
  // the same runner, the watcher still throwing: jobs run and fail exactly as they would unwatched
  const done = await runner.waitFor(runner.submit("refresh", async () => ({ ok: true })).id);
  expect(done).toMatchObject({ status: "done", result: { ok: true } });
  const unreadable = `/home/someone/papers/${MARK.title}/output/${DOC_ID}/main.tex`;
  const failed = await runner.waitFor(
    runner.submit("refresh", async () => {
      // What Node throws when a file of the user's cannot be opened: the message and `path` name the file — here
      // in a folder called after a paper, inside a Doc whose id is made from the Work's title.
      throw Object.assign(new Error(`ENOENT: no such file, open '${unreadable}'`), {
        code: "ENOENT",
        syscall: "open",
        path: unreadable,
      });
    }).id
  );
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed.error).toContain(MARK.title);
  const record = eventsNamed("job.failed", from).at(-1);
  expect(record).toMatchObject({
    job: failed.id,
    stage: "start",
    category: "file_system",
    // the system call and the code, but not the path
    error: { name: "Error", code: "ENOENT", syscall: "open" },
  });
  expect(Object.keys(record?.error ?? {}).sort()).toEqual(["code", "name", "stack", "syscall"]);
  expectNoMarkers();
});

// --------------------------------------------------------------------------- //
// The whole log, and the proof that the search can find something
// --------------------------------------------------------------------------- //

test("the records this ticket added carry no path and no text field; only a failed job carries an error, without message or path", () => {
  const added = records().filter((record) =>
    /^(job|external_program|external_service|mail|mail_watch|credentials|copilot\.run|copilot\.tool|server\.environment)/.test(
      String(record.event)
    )
  );
  expect(added.length).toBeGreaterThan(10);
  const fields = new Set(added.flatMap((record) => Object.keys(record)));
  for (const forbidden of ["stack", "message", "path", "detail", "args", "url", "query"])
    expect(fields.has(forbidden)).toBe(false);
  expect(added.filter((record) => "error" in record).every((r) => r.event === "job.failed")).toBe(
    true
  );
  // A mail server's host is nowhere: the web services' hosts are constants of the code.
  expect(
    added
      .filter((record) => "host" in record)
      .every((r) => /^external_service\./.test(`${r.event}`))
  ).toBe(true);
  // What a failed job threw: a name, a code, a system call, code locations, and the same of its causes.
  const checkError = (error: LogJson | undefined): void => {
    const e = error as Record<string, LogJson>;
    for (const key of Object.keys(e))
      expect(["name", "code", "syscall", "stack", "cause", "thrown"]).toContain(key);
    expect(String(e.name)).toMatch(/^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/);
    for (const frame of (e.stack ?? []) as string[]) expect(frame).toMatch(FRAME);
    if (e.cause !== undefined) checkError(e.cause);
  };
  // every other value is a short token, a number or a list of names: nothing a sentence fits in
  for (const record of added)
    for (const [name, value] of Object.entries(record)) {
      if (name === "t") continue;
      if (name === "error") {
        checkError(value);
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        expect(["string", "number"]).toContain(typeof item);
        if (typeof item === "string") expect(item).toMatch(/^[A-Za-z0-9_.:#/<>-]{1,80}$/);
      }
    }
  expect(logText(logDir)).not.toContain("<invalid");
  expectNoMarkers();
});

test("the search is not blind: a marker written through a call site of this ticket is found", () => {
  // A second log directory, so the log under test stays what the flows above wrote.
  const dir = join(root, "control", "logs");
  const control = openLogFile({ dir, process: "serve" });
  const controlLog = createLogger({ events: SERVER_LOG_EVENTS, sink: control, level: "debug" });
  try {
    expect(markersIn(dir)).toEqual([]);
    // The job logger writes the Work a job is about by the Work id rules, and those write an id of the shape of a
    // DOI as it is. Had a call site put a marker where such an id goes, the search must report it.
    const job = (id: string, workId: string): Job => ({
      id,
      kind: "refresh",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
      payload: { workId },
    });
    const id = `refresh-${randomUUID()}`;
    jobLogger(controlLog)?.({ type: "created", job: job(id, `doi:10.1234/${MARK.adsToken}`) });
    expect(logText(dir)).toContain("job.created");
    expect(markersIn(dir)).toEqual([`<${ROOT}>`, MARK.adsToken]);
    // … and in a respelling: the slug a title becomes on its way into an id.
    jobLogger(controlLog)?.({
      type: "created",
      job: job(id, "doi:10.1234/zqxmark-hidden-thesis-title"),
    });
    expect(markersIn(dir)).toContain("zqxmark-hidden-thesis-title");
  } finally {
    control.close();
  }
});
