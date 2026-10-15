/**
 * Switching projects with a project open (desktop-app ticket 19), in this process: a recent project or a folder the
 * shell picked is left for at once when nothing would be interrupted; otherwise the server asks for the user's
 * confirmation (409 `confirmation_required` for a recent project, a `host.switch-confirmation` message for a picked
 * folder) and checks again when the confirmation arrives. Cancelling changes nothing. A mail send in its undo window
 * is interrupted by the switch and never sent. The built program as a child process is
 * `packages/cli/tests/desktop-welcome.test.ts`; the Copilot part of the impact is `copilot-switch-impact.test.ts`.
 *
 * Everything below the home directory is the throwaway one of the isolation setup (checked by `isolated`).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import type { HostSwitchImpact, WsHostSwitchConfirmation } from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  configFilePath,
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailOutgoing,
  type KeychainBackend,
  readRecentProjects,
  recordRecentProject,
  resolveRecentProjectsPath,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  type FakeFolder,
  type FakeMailbox,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { type RecordingSmtp, startRecordingSmtp } from "../../infra/tests/mail/fake-smtp.js";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import { type DesktopHost, type HostOutLine, runDesktopHost } from "../src/desktop-host.js";
import { MailComposeService } from "../src/mail-compose.js";
import { MailOutbox } from "../src/mail-outbox.js";
import { disposeMailSendServices, MailSendService } from "../src/mail-send.js";
import type { RunningServer } from "../src/server.js";

beforeAll(() => __setWriterSandboxForTests(false));
afterAll(() => __setWriterSandboxForTests(null));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEYCHAIN = async () => ({ state: "unavailable" as const, reason: "no_bus" as const });
const cwd = process.cwd();
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
let web: string;
/** The project the host opens (its working directory). */
let current: string;

function isolated(path: string): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  const rel = relative(isolation.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("a per-user path of this test run is outside its throwaway home");
  }
  return path;
}

const recentFile = () => isolated(resolveRecentProjectsPath());

function folder(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `aspace-switch-${name}-`));
  roots.push(root);
  return realpathSync(root);
}

beforeEach(() => {
  web = join(folder("web"), "dist");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>switch test</title><div id=root>");
  current = folder("current");
  process.chdir(current);
  const config = isolated(configFilePath());
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "port = 0\n");
});

afterEach(async () => {
  disposeMailSendServices();
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(configFilePath()), { force: true });
  rmSync(recentFile(), { force: true });
});

interface Running {
  host: DesktopHost;
  server: RunningServer;
  input: PassThrough;
  lines: HostOutLine[];
  next<T extends HostOutLine["type"]>(type: T): Promise<Extract<HostOutLine, { type: T }>>;
  url: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Picks a folder the way the shell does: the page asks, the shell answers the request line. */
  pick(path: string | null): Promise<void>;
  log(): Array<Record<string, unknown>>;
}

async function startHost(): Promise<Running> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: HostOutLine[] = [];
  const taken = new Set<number>();
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as HostOutLine);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  });
  const next = async <T extends HostOutLine["type"]>(type: T) => {
    for (let i = 0; i < 400; i++) {
      const index = lines.findIndex((line, n) => line.type === type && !taken.has(n));
      if (index !== -1) {
        taken.add(index);
        return lines[index] as Extract<HostOutLine, { type: T }>;
      }
      await sleep(10);
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
  };
  const logDir = join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs");
  const before = new Set(existsSync(logDir) ? readdirSync(logDir) : []);
  const host = await runDesktopHost({
    input,
    output,
    version: "9.9.9-test",
    keychainProbe: KEYCHAIN,
    webDist: web,
  });
  closers.push(() => host.stop());
  const ready = await next("ready");
  const url = ready.type === "ready" ? ready.url.replace(/\/$/, "") : "";
  const mine = readdirSync(logDir).filter((name) => !before.has(name));
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(url + path, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  return {
    host,
    server: host.server as RunningServer,
    input,
    lines,
    next,
    url,
    async get(path) {
      const r = await fetch(url + path);
      const text = await r.text();
      return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    },
    post,
    async pick(path) {
      expect((await post("/api/host/requests/pick_folder")).status).toBe(202);
      const request = (await next("request")) as { id: string };
      input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path })}\n`);
    },
    log: () =>
      readFileSync(join(logDir, mine[0] ?? "missing"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A job that runs until `release` is called (the runner is serial: a second one waits queued behind it). */
function holdJob(server: RunningServer, payload: unknown): { id: string; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const job = server.runner.submit("ingest", () => gate, payload);
  closers.push(async () => release());
  return { id: job.id, release };
}

/** The `host.switch-confirmation` messages a page connected to the server receives. */
async function listen(url: string): Promise<{ messages: WsHostSwitchConfirmation[] }> {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`, { headers: { Origin: url } });
  const messages: WsHostSwitchConfirmation[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as { type: string };
    if (m.type === "host.switch-confirmation") messages.push(m as WsHostSwitchConfirmation);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  closers.push(async () => ws.close());
  return { messages };
}

const NOTHING = { jobs: [], conversations: [], mail: [] };
const ack = (impact: HostSwitchImpact) => ({
  jobs: impact.jobs.map((j) => j.id),
  conversations: impact.conversations.map((c) => c.id),
  mail: impact.mail.map((m) => m.sendId),
});

describe("nothing would be interrupted", () => {
  test("a picked folder: the host stops gracefully and tells its shell the next project; the list has it first", async () => {
    const other = folder("other");
    const h = await startHost();
    expect(h.host.project).toBe("open");
    await h.pick(other);
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
    expect(await h.host.stopped).toBe("switch");
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([other, current]);
    const log = h.log();
    expect(log.find((r) => r.event === "desktop.leaving")).toMatchObject({ source: "picked" });
    expect(log.some((r) => r.event === "desktop.switch_asked")).toBe(false);
    expect(JSON.stringify(log)).not.toContain("aspace-switch-other");
  });

  test("a recent project: 202 and the same leaving; the list marks the open project as current", async () => {
    const other = folder("other");
    recordRecentProject(recentFile(), other, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost();
    expect((await h.get("/api/host/recent-projects")).body).toMatchObject({
      projects: [
        { path: current, current: true },
        { path: other, current: false },
      ],
    });
    expect(await h.post("/api/host/recent-projects/open", { path: other })).toEqual({
      status: 202,
      body: { ok: true },
    });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
  });

  test("the open project itself is not switched to: 409 current_project from the list, a picked one is only logged", async () => {
    const h = await startHost();
    expect(await h.post("/api/host/recent-projects/open", { path: current })).toMatchObject({
      status: 409,
      body: { code: "current_project" },
    });
    await h.pick(current);
    await sleep(100);
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "request"]);
    expect(h.log().find((r) => r.event === "desktop.pick_rejected")).toMatchObject({
      reason: "current_project",
    });
  });

  test("a recent project whose folder is gone is said so and the host does not stop", async () => {
    const gone = folder("gone");
    recordRecentProject(recentFile(), gone, new Date("2026-01-01T00:00:00Z"));
    rmSync(gone, { recursive: true });
    const h = await startHost();
    expect((await h.get("/api/host/recent-projects")).body).toMatchObject({
      projects: [{ path: current }, { path: gone, missing: true }],
    });
    expect(await h.post("/api/host/recent-projects/open", { path: gone })).toMatchObject({
      status: 409,
      body: { code: "folder_missing" },
    });
    await sleep(100);
    expect(h.lines.map((l) => l.type)).toEqual(["ready"]);
    expect((await h.get("/api/library")).status).toBe(200);
  });
});

describe("a job running or queued", () => {
  test("a recent project: 409 with what would be interrupted; nothing stops until the page confirms all of it", async () => {
    const other = folder("other");
    recordRecentProject(recentFile(), other, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost();
    const running = holdJob(h.server, { workId: "w-1", arxivId: "2412.03418" });
    const refused = await h.post("/api/host/recent-projects/open", { path: other });
    expect(refused.status).toBe(409);
    const body = refused.body as { code: string; target: unknown; impact: HostSwitchImpact };
    expect(body).toMatchObject({
      code: "confirmation_required",
      target: { path: other, name: other.split("/").at(-1) },
      impact: {
        jobs: [
          {
            id: running.id,
            kind: "ingest",
            status: "running",
            workId: "w-1",
            format: null,
            arxivId: "2412.03418",
          },
        ],
        conversations: [],
        mail: [],
      },
    });
    expect(h.log().find((r) => r.event === "desktop.switch_asked")).toMatchObject({
      source: "recent",
      jobs: 1,
      conversations: 0,
      mail: 0,
    });
    // Meanwhile a second job was queued: the confirmation of the first impact does not cover it.
    const queued = holdJob(h.server, { workId: "w-2", format: "pdf" });
    const again = await h.post("/api/host/recent-projects/open", {
      path: other,
      acknowledged: ack(body.impact),
    });
    expect(again.status).toBe(409);
    const now = (again.body as { impact: HostSwitchImpact }).impact;
    expect(now.jobs.map((j) => [j.id, j.status])).toEqual(
      expect.arrayContaining([
        [running.id, "running"],
        [queued.id, "queued"],
      ])
    );
    expect(h.lines.map((l) => l.type)).toEqual(["ready"]);
    // Confirming all of it: the host leaves.
    expect(
      (await h.post("/api/host/recent-projects/open", { path: other, acknowledged: ack(now) }))
        .status
    ).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
  });

  test("what ended since the prompt does not matter: the confirmation covers what is left", async () => {
    const other = folder("other");
    recordRecentProject(recentFile(), other, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost();
    const job = holdJob(h.server, {});
    const refused = (await h.post("/api/host/recent-projects/open", { path: other })).body as {
      impact: HostSwitchImpact;
    };
    job.release();
    await h.server.runner.waitFor(job.id);
    expect(
      (await h.post("/api/host/recent-projects/open", { path: other, acknowledged: NOTHING }))
        .status
    ).toBe(202);
    expect(refused.impact.jobs).toHaveLength(1);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
  });

  test("a picked folder is held and announced; cancel changes nothing; a confirmation covering the impact leaves", async () => {
    const other = folder("other");
    const h = await startHost();
    const page = await listen(h.url);
    const job = holdJob(h.server, { workId: "w-1" });
    await h.pick(other);
    for (let i = 0; i < 100 && page.messages.length === 0; i++) await sleep(10);
    const [asked] = page.messages;
    expect(asked).toMatchObject({
      type: "host.switch-confirmation",
      target: { path: other },
      impact: { jobs: [{ id: job.id, status: "running" }], conversations: [], mail: [] },
    });
    if (asked === undefined) throw new Error("no confirmation");
    const listBefore = readFileSync(recentFile(), "utf8");

    // Cancel: nothing else changes — the host runs, the job runs, the list is the same, nothing left for.
    expect(await h.post("/api/host/switch/cancel", { id: asked.id })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(h.server.runner.get(job.id)?.status).toBe("running");
    expect(readFileSync(recentFile(), "utf8")).toBe(listBefore);
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "request"]);
    // The cancelled id is gone.
    expect(
      await h.post("/api/host/switch/confirm", { id: asked.id, acknowledged: ack(asked.impact) })
    ).toMatchObject({ status: 404, body: { code: "unknown_switch" } });
    expect(h.log().some((r) => r.event === "desktop.switch_cancelled")).toBe(true);

    // Picked again: a confirmation without the job is refused with the impact; with it, the host leaves.
    await h.pick(other);
    for (let i = 0; i < 100 && page.messages.length < 2; i++) await sleep(10);
    const second = page.messages[1];
    if (second === undefined) throw new Error("no second confirmation");
    expect(second.id).not.toBe(asked.id);
    expect(
      await h.post("/api/host/switch/confirm", { id: second.id, acknowledged: NOTHING })
    ).toMatchObject({ status: 409, body: { code: "confirmation_required" } });
    expect(
      (
        await h.post("/api/host/switch/confirm", {
          id: second.id,
          acknowledged: ack(second.impact),
        })
      ).status
    ).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
  });

  test("a held folder that is gone at the confirmation: 409 folder_missing, the host does not stop", async () => {
    const other = folder("other");
    const h = await startHost();
    const page = await listen(h.url);
    holdJob(h.server, {});
    await h.pick(other);
    for (let i = 0; i < 100 && page.messages.length === 0; i++) await sleep(10);
    const [asked] = page.messages;
    if (asked === undefined) throw new Error("no confirmation");
    rmSync(other, { recursive: true });
    expect(
      await h.post("/api/host/switch/confirm", { id: asked.id, acknowledged: ack(asked.impact) })
    ).toMatchObject({ status: 409, body: { code: "folder_missing" } });
    await sleep(100);
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
  });

  test("bodies: no id or acknowledged is 400, and the answer says which; the browser form has no switch", async () => {
    const h = await startHost();
    expect(await h.post("/api/host/switch/confirm", { id: "x" })).toEqual({
      status: 400,
      body: { code: "invalid_request", detail: "what was acknowledged is required" },
    });
    expect(await h.post("/api/host/switch/confirm", { acknowledged: NOTHING })).toEqual({
      status: 400,
      body: { code: "invalid_request", detail: "an id is required" },
    });
    expect(
      await h.post("/api/host/recent-projects/open", { path: "/x", acknowledged: { jobs: [1] } })
    ).toEqual({ status: 400, body: { code: "invalid_request", detail: ACK_INVALID } });
    expect(
      await h.post("/api/host/switch/confirm", { id: "x", acknowledged: { mail: "send-1" } })
    ).toEqual({ status: 400, body: { code: "invalid_request", detail: ACK_INVALID } });
    expect(await h.post("/api/host/recent-projects/open", { acknowledged: NOTHING })).toEqual({
      status: 400,
      body: { code: "invalid_request", detail: "a path is required" },
    });
    expect((await h.post("/api/host/switch/cancel", {})).status).toBe(400);
  });

  test("the size limit leaves room for every id acknowledged may hold, however they are written; one more is 400, a larger body 413", async () => {
    const h = await startHost();
    // The longest ids, each character written as an escape (six bytes): the most a body within the id limits takes.
    const longest = (n: number) => `${String(n).padStart(4, "0")}${"\u0001".repeat(60)}`;
    const lists = (count: number) => {
      const ids = Array.from({ length: count }, (_, n) => longest(n));
      return { jobs: ids, conversations: ids, mail: ids };
    };
    const full = lists(1000);
    expect(full.jobs[0]).toHaveLength(64);
    const path = `/${"p".repeat(8000)}`;
    // Taken in whole: the path is read and is not one of the list.
    expect(
      await h.post("/api/host/recent-projects/open", { path, acknowledged: full })
    ).toMatchObject({ status: 404, body: { code: "unknown_project" } });
    expect(await h.post("/api/host/switch/confirm", { id: "x", acknowledged: full })).toMatchObject(
      { status: 404, body: { code: "unknown_switch" } }
    );
    // One id too many, or one character too long: 400, not 413.
    const many = lists(1001);
    expect(
      (await h.post("/api/host/recent-projects/open", { path: "/x", acknowledged: many })).status
    ).toBe(400);
    const long = { ...NOTHING, jobs: ["j".repeat(65)] };
    expect((await h.post("/api/host/switch/confirm", { id: "x", acknowledged: long })).status).toBe(
      400
    );
    // A body past the limit is not read: 413.
    expect(
      (await h.post("/api/host/recent-projects/open", { path: "/x", pad: "x".repeat(1_300_000) }))
        .status
    ).toBe(413);
    // Removing a project and cancelling read a path or an id only: their limit stays 16 KiB.
    expect(
      (await h.post("/api/host/recent-projects/remove", { path: "/x", pad: "x".repeat(17_000) }))
        .status
    ).toBe(413);
    expect(
      (await h.post("/api/host/switch/cancel", { id: "x", pad: "x".repeat(17_000) })).status
    ).toBe(413);
  });

  test("a folder picked while the host is stopping is not held or announced; the log says why", async () => {
    const other = folder("other");
    const h = await startHost();
    const page = await listen(h.url);
    holdJob(h.server, { workId: "w-1" });
    expect((await h.post("/api/host/requests/pick_folder")).status).toBe(202);
    const request = (await h.next("request")) as { id: string };
    // A request whose body never finishes keeps the server's close waiting: the host stays in its stopping phase.
    const port = Number(new URL(h.url).port);
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    closers.push(async () => socket.destroy());
    socket.write(
      `POST /api/host/recent-projects/remove HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${h.url}\r\n` +
        "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
    );
    await sleep(50);
    const stopped = h.host.stop();
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "quit" });
    h.input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path: other })}\n`);
    await sleep(150);
    expect(h.lines.some((l) => l.type === "stopped")).toBe(false);
    const log = h.log();
    expect(log.find((r) => r.event === "desktop.pick_rejected")).toMatchObject({
      reason: "shutting_down",
    });
    expect(log.some((r) => r.event === "desktop.switch_asked")).toBe(false);
    expect(page.messages).toEqual([]);
    socket.destroy();
    expect(await stopped).toBe("quit");
    expect(await h.next("stopped")).toEqual({ type: "stopped" });
  });
});

/** The 400 detail of an `acknowledged` that is not lists of ids within the limits. */
const ACK_INVALID =
  "acknowledged must be lists of ids (at most 1000 each, each at most 64 characters)";

// ---- a mail send in its undo window ------------------------------------------------------------------------------ //

const ACC = "acc-0123456789ab";
const keychain = new Map<string, string>();
const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});

/** A send held in its undo window by a service registered for shutdown, as the server's own Mail services are. */
async function sendInWindow(): Promise<{
  service: MailSendService;
  sendId: string;
  smtp: RecordingSmtp;
  drafts: FakeFolder;
}> {
  const root = folder("mail");
  const drafts: FakeFolder = { path: "Drafts", attrs: ["\\Drafts"], uidValidity: 31, messages: [] };
  const sent: FakeFolder = { path: "Sent", attrs: ["\\Sent"], uidValidity: 32, messages: [] };
  const imap: FakeMailbox = await startFakeMailbox([
    { path: "INBOX", uidValidity: 30, messages: [] },
    drafts,
    sent,
  ]);
  const smtp = await startRecordingSmtp();
  closers.push(
    () => imap.close(),
    () => smtp.close()
  );
  const store = createMailAccountStore({ dataDir: join(root, "global") });
  const credentials = createCredentialStore({ backend: backend(), dataDir: join(root, "global") });
  await credentials.set(ACC, TEST_PASSWORD, { fileFallbackConsent: false });
  await store.update(0, async () => ({
    accounts: [
      {
        id: ACC as never,
        displayName: "Test Person",
        address: "tester@fake.test",
        preset: "custom",
        imap: { host: "127.0.0.1", port: imap.port, security: "tls" },
        smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
        imapUser: TEST_USER,
        smtpUser: TEST_USER,
        credentialRef: ACC as never,
        credentialProtection: "keychain",
      },
    ],
    result: null,
  }));
  const tls = { rejectUnauthorized: false };
  const cache = join(root, "cache");
  const outgoing = createNodeMailOutgoing({ timeoutMs: 3000, tls });
  const compose = new MailComposeService({
    accounts: store,
    credentials,
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls }),
    outgoing,
    cacheDir: () => cache,
  });
  const service = new MailSendService({
    compose,
    outgoing,
    outbox: new MailOutbox(() => cache),
    undoMs: 5000,
    registerForShutdown: true,
  });
  const sendId = "00000000-0000-4000-8000-000000000019";
  await service.start(ACC, {
    sendId,
    draft: {
      messageId: "<draft-switch@fake.test>",
      inReplyTo: null,
      references: [],
      to: "Ada <ada@fake.test>",
      cc: "",
      bcc: "",
      subject: "switch away",
      text: "body",
      attachments: [],
    } as never,
  });
  expect(service.status(ACC, sendId).state).toBe("pending");
  expect(drafts.messages).toHaveLength(1);
  return { service, sendId, smtp, drafts };
}

describe("a mail send in its undo window", () => {
  test("is asked about, and the confirmed switch interrupts it: it stays in Drafts and is never sent", async () => {
    const other = folder("other");
    recordRecentProject(recentFile(), other, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost();
    const mail = await sendInWindow();
    const refused = await h.post("/api/host/recent-projects/open", { path: other });
    expect(refused.status).toBe(409);
    const impact = (refused.body as { impact: HostSwitchImpact }).impact;
    // Only what the prompt shows: the account is not handed to the page.
    expect(impact.mail).toEqual([
      { sendId: mail.sendId, subject: "switch away", endsAt: expect.any(Number) },
    ]);
    expect(impact.mail[0]?.endsAt).toBeGreaterThan(Date.now());
    expect(h.log().find((r) => r.event === "desktop.switch_asked")).toMatchObject({ mail: 1 });
    // Nothing of the mail reaches the user log.
    expect(JSON.stringify(h.log())).not.toContain("switch away");

    expect(
      (await h.post("/api/host/recent-projects/open", { path: other, acknowledged: ack(impact) }))
        .status
    ).toBe(202);
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
    // The close's first step is synchronous: the window is over before anything else stops.
    expect(mail.service.status(ACC, mail.sendId).state).toBe("interrupted");
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: other });
    // Past the end of the window: nothing went out, the draft is still there.
    await sleep(Math.max(0, (impact.mail[0]?.endsAt ?? 0) - Date.now()) + 500);
    expect(mail.smtp.dataStarted.count).toBe(0);
    expect(mail.drafts.messages).toHaveLength(1);
  }, 20_000);
});
