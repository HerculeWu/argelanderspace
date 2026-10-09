import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  createMailAccountStore,
  type KeychainBackend,
  type MailLoginTarget,
  type MailProtocol,
} from "@argelanderspace/infra";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { stubPipelines, stubSources } from "./helpers.js";

const GOOD = "synthetic-good-password";
const BAD = "synthetic-bad-password";

let root: string;
let globalData: string;
let globalCache: string;
let keychain: Map<string, string>;
let keychainDown: boolean;
let calls: { kind: "imap" | "smtp"; t: MailLoginTarget }[];
let app: ReturnType<typeof createApp>;

const backend = (): KeychainBackend => ({
  get: (a) => {
    if (keychainDown) throw new Error("no secret service");
    return keychain.get(a) ?? null;
  },
  set: (a, p) => {
    if (keychainDown) throw new Error("no secret service");
    keychain.set(a, p);
  },
  delete: (a) => {
    if (keychainDown) throw new Error("no secret service");
    return keychain.delete(a);
  },
});

/** Honest stand-in for the protocol port: only GOOD logs in. Records every call. */
const protocol: MailProtocol = {
  async verifyImapLogin(t) {
    calls.push({ kind: "imap", t });
    return t.password === GOOD ? { ok: true } : { ok: false, code: "auth_failed" };
  },
  async verifySmtpLogin(t) {
    calls.push({ kind: "smtp", t });
    return t.password === GOOD ? { ok: true } : { ok: false, code: "auth_failed" };
  },
};

function build(): ReturnType<typeof createApp> {
  const service = new MailAccountService({
    store: createMailAccountStore({ dataDir: globalData }),
    credentials: createCredentialStore({ backend: backend(), dataDir: globalData }),
    protocol,
    cacheDir: () => globalCache,
  });
  return createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    mailAccounts: service,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-accounts-"));
  globalData = join(root, "global");
  globalCache = join(root, "gcache");
  keychain = new Map();
  keychainDown = false;
  calls = [];
  app = build();
});

const req = (path: string, method = "GET", body?: unknown, origin?: string) =>
  app.request(`/api/mail${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
  });
// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const json = async (r: Response): Promise<any> => r.json();

const draft = (over: Record<string, unknown> = {}) => ({
  preset: "custom",
  displayName: "Work",
  address: "me@example.test",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: "me",
  smtpUser: "me",
  password: GOOD,
  ...over,
});

async function add(over: Record<string, unknown> = {}) {
  const r = await req("/accounts", "POST", draft(over));
  return { status: r.status, body: await json(r) };
}

test("presets endpoint lists Gmail/iCloud/custom", async () => {
  const b = await json(await req("/presets"));
  expect(b.presets.map((p: { id: string }) => p.id)).toEqual(["gmail", "icloud", "custom"]);
  const gmail = b.presets.find((p: { id: string }) => p.id === "gmail");
  expect(gmail.imap).toEqual({ host: "imap.gmail.com", port: 993, security: "tls" });
  expect(gmail.smtp).toEqual({ host: "smtp.gmail.com", port: 465, security: "tls" });
});

test("add: tests IMAP and SMTP, stores the account without a password, password goes to the keychain", async () => {
  const { status, body } = await add();
  expect(status).toBe(201);
  expect(body.rev).toBe(1);
  expect(body.account.credentialProtection).toBe("keychain");
  expect(calls.map((c) => c.kind).sort()).toEqual(["imap", "smtp"]);
  expect(keychain.get(body.account.id)).toBe(GOOD);
  const stored = readFileSync(join(globalData, "mail", "accounts.json"), "utf8");
  expect(stored).not.toContain(GOOD);
  expect(JSON.stringify(body)).not.toContain(GOOD);
  const list = await json(await req("/accounts"));
  expect(list.accounts).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain(GOOD);
});

test("add with a preset fills hosts and login names (iCloud: local part for IMAP, full address for SMTP)", async () => {
  const { status, body } = await add({
    preset: "icloud",
    address: "jane@icloud.com",
    imap: undefined,
    smtp: undefined,
    imapUser: undefined,
    smtpUser: undefined,
  });
  expect(status).toBe(201);
  expect(body.account.imap).toEqual({ host: "imap.mail.me.com", port: 993, security: "tls" });
  expect(body.account.smtp).toEqual({ host: "smtp.mail.me.com", port: 587, security: "starttls" });
  expect(body.account.imapUser).toBe("jane");
  expect(body.account.smtpUser).toBe("jane@icloud.com");
  expect(calls.find((c) => c.kind === "imap")?.t.user).toBe("jane");
  expect(calls.find((c) => c.kind === "smtp")?.t.user).toBe("jane@icloud.com");
});

test("add with a failing login saves nothing and reports each protocol readably without echoing the password", async () => {
  const { status, body } = await add({
    password: BAD,
    preset: "gmail",
    address: "g@gmail.com",
    imap: undefined,
    smtp: undefined,
    imapUser: undefined,
    smtpUser: undefined,
  });
  expect(status).toBe(422);
  expect(body.code).toBe("connection_failed");
  expect(body.test.imap).toMatchObject({ ok: false, code: "auth_failed" });
  expect(body.test.smtp).toMatchObject({ ok: false, code: "auth_failed" });
  expect(body.test.imap.detail).toMatch(/app-specific password/);
  expect(JSON.stringify(body)).not.toContain(BAD);
  expect(existsSync(join(globalData, "mail", "accounts.json"))).toBe(false);
  expect(keychain.size).toBe(0);
});

test("test endpoint reports IMAP and SMTP separately", async () => {
  const split: MailProtocol = {
    verifyImapLogin: async () => ({ ok: true }),
    verifySmtpLogin: async () => ({ ok: false, code: "timeout" }),
  };
  const svc = new MailAccountService({
    store: createMailAccountStore({ dataDir: globalData }),
    credentials: createCredentialStore({ backend: backend(), dataDir: globalData }),
    protocol: split,
    cacheDir: () => globalCache,
  });
  const a = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    mailAccounts: svc,
  });
  const { password, displayName: _n, ...rest } = draft();
  const r = await a.request("/api/mail/accounts/test", {
    method: "POST",
    body: JSON.stringify({ ...rest, password }),
    headers: { "Content-Type": "application/json" },
  });
  const b = await json(r);
  expect(b.imap).toEqual({ ok: true });
  expect(b.smtp).toMatchObject({ ok: false, code: "timeout" });
  expect(existsSync(join(globalData, "mail", "accounts.json"))).toBe(false);
});

test("keychain unavailable: 422 without consent writes no file; with consent stores in the 0600 file and flags it", async () => {
  keychainDown = true;
  const refused = await add();
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe("keychain_unavailable");
  expect(existsSync(join(globalData, "credentials.json"))).toBe(false);
  expect(existsSync(join(globalData, "mail", "accounts.json"))).toBe(false);
  const ok = await add({ fileFallbackConsent: true });
  expect(ok.status).toBe(201);
  expect(ok.body.account.credentialProtection).toBe("file");
  expect(readFileSync(join(globalData, "credentials.json"), "utf8")).not.toContain(GOOD);
});

test("duplicate address is a 409 duplicate_address and leaves no credential behind", async () => {
  await add();
  const dup = await add({ displayName: "Again", address: "ME@example.test" });
  expect(dup.status).toBe(409);
  expect(dup.body.code).toBe("duplicate_address");
  expect(keychain.size).toBe(1);
});

test("edit: display-name change needs no re-test; host change re-tests with the stored password; wrong new password is rejected", async () => {
  const { body: created } = await add();
  const id = created.account.id;
  calls = [];
  const r1 = await req(`/accounts/${id}`, "PUT", {
    ...draft({ displayName: "Renamed" }),
    password: undefined,
    rev: 1,
  });
  expect(r1.status).toBe(200);
  expect((await json(r1)).account.displayName).toBe("Renamed");
  expect(calls).toHaveLength(0);

  const r2 = await req(`/accounts/${id}`, "PUT", {
    ...draft({ imap: { host: "imap2.example.test", port: 993, security: "tls" } }),
    password: undefined,
    rev: 2,
  });
  expect(r2.status).toBe(200);
  expect(calls.find((c) => c.kind === "imap")?.t).toMatchObject({
    host: "imap2.example.test",
    password: GOOD,
  });

  const r3 = await req(`/accounts/${id}`, "PUT", { ...draft({ password: BAD }), rev: 3 });
  expect(r3.status).toBe(422);
  expect(keychain.get(id)).toBe(GOOD);

  const r4 = await req(`/accounts/${id}`, "PUT", { ...draft(), password: GOOD, rev: 3 });
  expect(r4.status).toBe(200);
});

test("closing review U1: serverSavesSent is optional, stored when given, kept by edits that omit it, changed by one that sends it", async () => {
  const { body: plain } = await add();
  expect("serverSavesSent" in plain.account).toBe(false); // an account without the setting stays as it was
  const { body: other } = await add({ address: "two@example.test", serverSavesSent: true });
  expect(other.account.serverSavesSent).toBe(true);
  const id = other.account.id;
  const keep = await req(`/accounts/${id}`, "PUT", {
    ...draft({ address: "two@example.test", displayName: "Renamed" }),
    password: undefined,
    rev: 2,
  });
  expect((await json(keep)).account.serverSavesSent).toBe(true);
  const change = await req(`/accounts/${id}`, "PUT", {
    ...draft({ address: "two@example.test", serverSavesSent: false }),
    password: undefined,
    rev: 3,
  });
  expect(change.status).toBe(200);
  expect((await json(change)).account.serverSavesSent).toBe(false);
});

test("stale rev on edit/delete is a 409 carrying the current rev, and nothing is overwritten", async () => {
  const { body: created } = await add();
  const id = created.account.id;
  const other = build(); // a second "process" sharing the same global data
  const raced = await other.request(`/api/mail/accounts/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...draft({ displayName: "Other process" }),
      password: undefined,
      rev: 1,
    }),
    headers: { "Content-Type": "application/json" },
  });
  expect(raced.status).toBe(200);

  const stale = await req(`/accounts/${id}`, "PUT", {
    ...draft({ displayName: "Stale writer" }),
    password: undefined,
    rev: 1,
  });
  expect(stale.status).toBe(409);
  expect(await json(stale)).toMatchObject({ code: "rev_mismatch", rev: 2 });
  const del = await req(`/accounts/${id}?rev=1`, "DELETE");
  expect(del.status).toBe(409);
  const list = await json(await req("/accounts"));
  expect(list.accounts[0].displayName).toBe("Other process");
  expect(keychain.has(id)).toBe(true);
});

test("delete removes account, credential and that account's cache only, with no mail-server traffic", async () => {
  const a = (await add()).body.account;
  const b = (await add({ address: "second@example.test", displayName: "Second" })).body.account;
  for (const id of [a.id, b.id]) {
    mkdirSync(join(globalCache, "mail", id), { recursive: true });
    writeFileSync(join(globalCache, "mail", id, "list.json"), "{}");
  }
  calls = [];
  const r = await req(`/accounts/${a.id}?rev=2`, "DELETE");
  expect(r.status).toBe(200);
  expect(await json(r)).toEqual({ rev: 3, warnings: [] });
  expect(calls).toHaveLength(0);
  expect(keychain.has(a.id)).toBe(false);
  expect(keychain.has(b.id)).toBe(true);
  expect(existsSync(join(globalCache, "mail", a.id))).toBe(false);
  expect(readdirSync(join(globalCache, "mail"))).toEqual([b.id]);
  expect((await json(await req("/accounts"))).accounts.map((x: { id: string }) => x.id)).toEqual([
    b.id,
  ]);
});

test("delete with an unreachable keychain is refused and keeps the account", async () => {
  const a = (await add()).body.account;
  keychainDown = true;
  const r = await req(`/accounts/${a.id}?rev=1`, "DELETE");
  expect(r.status).toBeGreaterThanOrEqual(500);
  keychainDown = false;
  expect((await json(await req("/accounts", "GET"))).accounts).toHaveLength(1);
  expect((await req(`/accounts/${a.id}?rev=1`, "DELETE")).status).toBe(200);
});

test("unknown or malformed ids are 404; invalid bodies are 400 naming fields only", async () => {
  expect((await req("/accounts/acc-000000000000?rev=0", "DELETE")).status).toBe(404);
  expect((await req("/accounts/..%2Fetc?rev=0", "DELETE")).status).toBe(404);
  const bad = await req(
    "/accounts",
    "POST",
    draft({ imap: { host: "x y", port: 0, security: "none" }, password: "" })
  );
  expect(bad.status).toBe(400);
  const b = await json(bad);
  expect(b.fields).toEqual(
    expect.arrayContaining(["imap.host", "imap.port", "imap.security", "password"])
  );
  const custom = await req("/accounts", "POST", draft({ imap: undefined }));
  expect(custom.status).toBe(400);
  expect((await json(custom)).fields).toEqual(["imap"]);
});

test("cross-site writes are rejected", async () => {
  const r = await req("/accounts", "POST", draft(), "https://evil.example");
  expect(r.status).toBe(403);
});

test("a corrupt accounts file is a 500 that is never overwritten", async () => {
  await add();
  const p = join(globalData, "mail", "accounts.json");
  writeFileSync(p, "garbage");
  expect((await req("/accounts")).status).toBe(500);
  expect((await add({ address: "n@example.test" })).status).toBe(500);
  expect(readFileSync(p, "utf8")).toBe("garbage");
});

test("test endpoint uses the stored password only for the stored endpoints and users", async () => {
  const { body } = await add();
  const id = body.account.id;
  const { password: _p, displayName: _n, ...rest } = draft();
  const probe = async (over: Record<string, unknown>) =>
    req("/accounts/test", "POST", { ...rest, accountId: id, ...over });
  expect((await probe({})).status).toBe(200);
  const moved = await probe({ imap: { host: "evil.example.test", port: 993, security: "tls" } });
  expect(moved.status).toBe(400);
  expect((await probe({ smtpUser: "other" })).status).toBe(400);
  expect((await probe({ accountId: "acct-missing" })).status).toBe(400);
});
