/**
 * The ADS credential endpoints over HTTP (desktop-app ticket 12): a real server in a temporary project, real requests.
 * The keychain is a fake handed in (`adsCredentials`), the fallback file goes to a temporary directory, the network
 * is an offline stub (`fetchImpl`): nothing here reaches the real keychain, the real `~/.ads/dev_key` (HOME is the
 * isolated one of isolate-user-dirs.ts; the file there is a fake written by the test) or ADS.
 *
 * Every answer is searched for the token (a marked value): none may carry it.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  type FetchImpl,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubSources } from "./helpers.js";

const TOKEN = "zqxAdsTokenMARK0123456789abcdef";
const OTHER = "zqxOtherTokenMARK9876543210";

let srv: RunningServer | undefined;
let base: string;
let dataDir: string;
let globalDir: string;
let keychainUp = true;
let keychain: Map<string, string>;
let adsAnswer: () => Response;
let requests: Array<{ url: string; auth: string | null }>;
const answers: string[] = [];

const backend: KeychainBackend = {
  get: (id, service) => {
    if (!keychainUp) throw new Error(`no secret service (${service})`);
    return keychain.get(`${service}/${id}`) ?? null;
  },
  set: (id, password, service) => {
    if (!keychainUp) throw new Error(`no secret service ${password}`);
    keychain.set(`${service}/${id}`, password);
  },
  delete: (id, service) => {
    if (!keychainUp) throw new Error("no secret service");
    return keychain.delete(`${service}/${id}`);
  },
};

const fetchStub: FetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (url.includes("adsabs.harvard.edu")) return adsAnswer();
  return new Response("not found", { status: 404 });
}) as FetchImpl;

async function start(): Promise<void> {
  dataDir = makeDataDir();
  globalDir = mkdtempSync(join(tmpdir(), "aspace-ads-cred-global-"));
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    fetchImpl: fetchStub,
    configPath: join(dataDir, "config.toml"),
    adsCredentials: createCredentialStore({ purpose: "ads", backend, dataDir: globalDir }),
  });
  base = `http://127.0.0.1:${await srv.ready()}`;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  answers.push(text);
  return {
    status: res.status,
    cache: res.headers.get("cache-control"),
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

const devKeyPath = () => join(homedir(), ".ads", "dev_key");

beforeEach(async () => {
  keychainUp = true;
  keychain = new Map();
  requests = [];
  adsAnswer = () => new Response('{"response":{"docs":[]}}', { status: 200 });
  answers.length = 0;
  await start();
});

afterEach(async () => {
  // No answer of any endpoint ever carries the token.
  for (const text of answers) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(OTHER);
  }
  await srv?.close();
  srv = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(join(homedir(), ".ads"), { recursive: true, force: true });
});

describe("status, save, remove", () => {
  test("not saved → saved in the keychain → removed; every answer no-store", async () => {
    const none = await call("GET", "/api/credentials/ads");
    expect(none.status).toBe(200);
    expect(none.cache).toBe("no-store");
    expect(none.body).toMatchObject({
      version: 1,
      saved: "none",
      keychain: "available",
      devKey: { exists: false },
    });

    const saved = await call("PUT", "/api/credentials/ads", { token: `  ${TOKEN}\n` });
    expect(saved.status).toBe(200);
    expect(saved.cache).toBe("no-store");
    expect(saved.body).toMatchObject({
      ok: true,
      status: { saved: "keychain", keychain: "available" },
    });
    expect(keychain.get("argelanderspace.ads/token")).toBe(TOKEN);

    expect((await call("GET", "/api/credentials/ads")).body).toMatchObject({ saved: "keychain" });

    const removed = await call("DELETE", "/api/credentials/ads");
    expect(removed.status).toBe(200);
    expect(removed.cache).toBe("no-store");
    expect(removed.body).toMatchObject({ ok: true, status: { saved: "none" } });
    expect(keychain.size).toBe(0);
  });

  test("keychain unavailable and no consent: refused with the reason, nothing written; with consent: the file", async () => {
    keychainUp = false;
    expect((await call("GET", "/api/credentials/ads")).body).toMatchObject({
      saved: "none",
      keychain: "unavailable",
    });
    const refused = await call("PUT", "/api/credentials/ads", { token: TOKEN });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ ok: false, reason: "keychain_unavailable" });
    // Anything but a literal true is no consent.
    const notTrue = await call("PUT", "/api/credentials/ads", {
      token: TOKEN,
      fileFallbackConsent: "true",
    });
    expect(notTrue.body).toEqual({ ok: false, reason: "keychain_unavailable" });
    expect(() => statSync(join(globalDir, "ads-credentials.json"))).toThrow();

    const consented = await call("PUT", "/api/credentials/ads", {
      token: TOKEN,
      fileFallbackConsent: true,
    });
    expect(consented.status).toBe(200);
    expect(consented.body).toMatchObject({
      ok: true,
      status: { saved: "file", keychain: "unavailable" },
    });
    const file = join(globalDir, "ads-credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
    expect((await call("GET", "/api/credentials/ads")).body).toMatchObject({ saved: "file" });

    const removed = await call("DELETE", "/api/credentials/ads");
    expect(removed.body).toMatchObject({ ok: true, status: { saved: "none" } });
  });

  test("bad requests: not JSON, no token, a blank or malformed token", async () => {
    expect((await call("PUT", "/api/credentials/ads", "{not json")).body).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect((await call("PUT", "/api/credentials/ads", {})).status).toBe(400);
    expect((await call("PUT", "/api/credentials/ads", { token: "   " })).body).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect((await call("PUT", "/api/credentials/ads", { token: "two words" })).body).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect((await call("PUT", "/api/credentials/ads", { token: "x".repeat(1025) })).status).toBe(
      400
    );
    expect(keychain.size).toBe(0);
  });

  test("a cross-site write is refused like every other write", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await call("PUT", "/api/credentials/ads", { token: TOKEN }, evil)).status).toBe(403);
    expect((await call("DELETE", "/api/credentials/ads", undefined, evil)).status).toBe(403);
    expect((await call("POST", "/api/credentials/ads/test", {}, evil)).status).toBe(403);
    expect((await call("POST", "/api/credentials/ads/import", {}, evil)).status).toBe(403);
    expect(keychain.size).toBe(0);
    expect(requests).toEqual([]);
  });
});

describe("test", () => {
  test.each([
    [200, "valid"],
    [401, "rejected"],
    [403, "rejected"],
    [429, "rate_limited"],
    [502, "unreachable"],
  ] as const)("ADS answers %i: %s (saved token)", async (status, result) => {
    await call("PUT", "/api/credentials/ads", { token: TOKEN });
    adsAnswer = () => new Response("{}", { status });
    const r = await call("POST", "/api/credentials/ads/test", {});
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.body).toEqual({ ok: true, result });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.url).not.toContain(TOKEN);
  });

  test("a network failure is unreachable; an input not yet saved is tested without saving it", async () => {
    adsAnswer = () => {
      throw new TypeError("fetch failed");
    };
    expect((await call("POST", "/api/credentials/ads/test", { token: OTHER })).body).toEqual({
      ok: true,
      result: "unreachable",
    });
    expect(requests[0]?.auth).toBe(`Bearer ${OTHER}`);
    expect(keychain.size).toBe(0);
  });

  test("nothing saved: not_saved, no request", async () => {
    const r = await call("POST", "/api/credentials/ads/test");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: "not_saved" });
    keychainUp = false;
    expect((await call("POST", "/api/credentials/ads/test", {})).body).toEqual({
      ok: false,
      reason: "not_saved",
    });
    expect(requests).toEqual([]);
  });
});

describe("import from ~/.ads/dev_key", () => {
  test("saves the file's token; the file's bytes and modification time are unchanged", async () => {
    mkdirSync(join(homedir(), ".ads"), { recursive: true });
    writeFileSync(devKeyPath(), `${TOKEN}\n`);
    const when = new Date("2024-01-02T03:04:05Z");
    utimesSync(devKeyPath(), when, when);
    const bytes = readFileSync(devKeyPath());
    const before = statSync(devKeyPath());

    const status = await call("GET", "/api/credentials/ads");
    expect(status.body).toMatchObject({ saved: "none", devKey: { exists: true } });
    expect((status.body.devKey as { path: { display: string } }).path.display).toBe(
      "~/.ads/dev_key"
    );

    const imported = await call("POST", "/api/credentials/ads/import", {});
    expect(imported.status).toBe(200);
    expect(imported.cache).toBe("no-store");
    expect(imported.body).toMatchObject({
      ok: true,
      status: { saved: "keychain", devKey: { exists: true } },
    });
    expect(keychain.get("argelanderspace.ads/token")).toBe(TOKEN);

    const after = statSync(devKeyPath());
    expect(readFileSync(devKeyPath()).equals(bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mtimeMs).toBe(when.getTime());
  });

  test("no file, an empty file, no keychain without consent", async () => {
    expect((await call("POST", "/api/credentials/ads/import", {})).body).toEqual({
      ok: false,
      reason: "no_dev_key",
    });
    mkdirSync(join(homedir(), ".ads"), { recursive: true });
    writeFileSync(devKeyPath(), "  \n");
    expect((await call("POST", "/api/credentials/ads/import", {})).body).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    writeFileSync(devKeyPath(), `${TOKEN}\n`);
    keychainUp = false;
    const refused = await call("POST", "/api/credentials/ads/import", {});
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ ok: false, reason: "keychain_unavailable" });
    const consented = await call("POST", "/api/credentials/ads/import", {
      fileFallbackConsent: true,
    });
    expect(consented.body).toMatchObject({ ok: true, status: { saved: "file" } });
  });
});

describe("the sources take the token at each use, without a restart", () => {
  const discover = () =>
    fetch(`${base}/api/library/discovery?bibcode=2016ApJ...818...46F`).then((r) => r.status);

  test("discovery: no token → 503 and no request; saved → the request carries it; removed → no token again", async () => {
    expect(await discover()).toBe(503);
    expect(requests).toEqual([]);

    await call("PUT", "/api/credentials/ads", { token: TOKEN });
    await discover();
    const sent = requests.filter((r) => r.url.includes("adsabs.harvard.edu"));
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) expect(r.auth).toBe(`Bearer ${TOKEN}`);

    await call("PUT", "/api/credentials/ads", { token: OTHER });
    requests = [];
    await fetch(`${base}/api/library/discovery?bibcode=2020ApJ...900....1X`);
    expect(
      requests.filter((r) => r.url.includes("adsabs")).every((r) => r.auth === `Bearer ${OTHER}`)
    ).toBe(true);
    expect(requests.length).toBeGreaterThan(0);

    await call("DELETE", "/api/credentials/ads");
    requests = [];
    expect(
      await fetch(`${base}/api/library/discovery?bibcode=2021ApJ...901....2Y`).then((r) => r.status)
    ).toBe(503);
    expect(requests).toEqual([]);
  });

  test("the old sources do not count: $ADS_DEV_KEY, config ads_dev_key and ~/.ads/dev_key with an empty store", async () => {
    const saved = process.env.ADS_DEV_KEY;
    process.env.ADS_DEV_KEY = "old-env-token-333";
    try {
      writeFileSync(join(dataDir, "config.toml"), 'ads_dev_key = "old-config-token-222"\n');
      mkdirSync(join(homedir(), ".ads"), { recursive: true });
      writeFileSync(devKeyPath(), "old-file-token-111\n");
      expect(await discover()).toBe(503);
      expect(requests).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ADS_DEV_KEY;
      else process.env.ADS_DEV_KEY = saved;
    }
  });
});
