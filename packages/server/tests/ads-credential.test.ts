/**
 * The ADS credential endpoints over HTTP (desktop-app ticket 12): a real server in a temporary project, real requests.
 * The keychain is a fake handed in (`adsCredentials`), the fallback file goes to a temporary directory, the network
 * is an offline stub (`fetchImpl`): nothing here reaches the real keychain, the real `~/.ads/dev_key` or ADS. The
 * import reads a fake key file in a temporary directory handed in as `adsDevKeyPath`; the one test that needs the
 * file at the home directory (the old source must not count) first checks that the home is a temporary one.
 *
 * Every answer is searched for the token (a marked value): none may carry it.
 */

import { execFileSync } from "node:child_process";
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
import { dirname, join, sep } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  type FetchImpl,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { realSources } from "../src/deps.js";
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
let devKeyDir: string;
/** Set by a test to make the keychain's read hang (a locked keychain waiting for the user). */
let keychainHangs = false;
let keychainReads = 0;
let requests: Array<{ url: string; auth: string | null }>;
const answers: string[] = [];

const backend: KeychainBackend = {
  get: (id, service) => {
    keychainReads += 1;
    if (keychainHangs) return new Promise<never>(() => {});
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

/** Every temporary directory a start made (a test may start twice); all removed after each test. */
const made: string[] = [];

async function start(extra: Partial<Parameters<typeof createServer>[0]> = {}): Promise<void> {
  dataDir = makeDataDir();
  globalDir = mkdtempSync(join(tmpdir(), "aspace-ads-cred-global-"));
  devKeyDir = mkdtempSync(join(tmpdir(), "aspace-ads-cred-home-"));
  made.push(dirname(dataDir), globalDir, devKeyDir);
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    fetchImpl: fetchStub,
    configPath: join(dataDir, "config.toml"),
    adsCredentials: createCredentialStore({ purpose: "ads", backend, dataDir: globalDir }),
    adsDevKeyPath: devKeyPath,
    ...extra,
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

/** The fake `~/.ads/dev_key` of these tests: in a temporary directory, never the home directory. */
const devKeyPath = () => join(devKeyDir, ".ads", "dev_key");
const writeDevKey = (content: string | Buffer) => {
  mkdirSync(join(devKeyDir, ".ads"), { recursive: true });
  writeFileSync(devKeyPath(), content);
};
/** Only a home directory below the temporary directory may be written to (isolate-user-dirs.ts sets one). */
const homeIsTemporary = () => homedir().startsWith(tmpdir() + sep);

beforeEach(async () => {
  keychainUp = true;
  keychainHangs = false;
  keychainReads = 0;
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
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    writeDevKey(`${TOKEN}\n`);
    const when = new Date("2024-01-02T03:04:05Z");
    utimesSync(devKeyPath(), when, when);
    const bytes = readFileSync(devKeyPath());
    const before = statSync(devKeyPath());

    const status = await call("GET", "/api/credentials/ads");
    expect(status.body).toMatchObject({ saved: "none", devKey: { exists: true } });
    expect((status.body.devKey as { path: { path: string } }).path.path).toBe(devKeyPath());

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
    writeDevKey("  \n");
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
      // The old source is the file at the home directory itself: written only when that home is a temporary one.
      expect(homeIsTemporary()).toBe(true);
      if (!homeIsTemporary()) return;
      mkdirSync(join(homedir(), ".ads"), { recursive: true });
      writeFileSync(join(homedir(), ".ads", "dev_key"), "old-file-token-111\n");
      expect(await discover()).toBe(503);
      expect(requests).toEqual([]);
    } finally {
      if (homeIsTemporary()) rmSync(join(homedir(), ".ads"), { recursive: true, force: true });
      if (saved === undefined) delete process.env.ADS_DEV_KEY;
      else process.env.ADS_DEV_KEY = saved;
    }
  });
});

describe("ticket 12 revision", () => {
  test("refusals are no-store too", async () => {
    keychainUp = false;
    const refused = await call("PUT", "/api/credentials/ads", { token: TOKEN });
    expect(refused.status).toBe(422);
    expect(refused.cache).toBe("no-store");
    const bad = await call("PUT", "/api/credentials/ads", { token: " " });
    expect(bad.cache).toBe("no-store");
    const missing = await call("POST", "/api/credentials/ads/import", {});
    expect(missing.status).toBe(404);
    expect(missing.cache).toBe("no-store");
    const notSaved = await call("POST", "/api/credentials/ads/test", {});
    expect(notSaved.cache).toBe("no-store");
  });

  test("import: only a literal true is consent to the file", async () => {
    keychainUp = false;
    writeDevKey(`${TOKEN}\n`);
    for (const consent of ["true", 1, {}, [true]]) {
      const r = await call("POST", "/api/credentials/ads/import", { fileFallbackConsent: consent });
      expect(r.body).toEqual({ ok: false, reason: "keychain_unavailable" });
    }
    expect(() => statSync(join(globalDir, "ads-credentials.json"))).toThrow();
  });

  test("import: a key file over 8 KiB is refused and not saved", async () => {
    writeDevKey("a".repeat(8 * 1024 + 1));
    const r = await call("POST", "/api/credentials/ads/import", {});
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, reason: "invalid_token" });
    expect(keychain.size).toBe(0);
    // exactly 8 KiB of a too-long token: read, then refused by the token rule (over 1024 characters)
    writeDevKey("a".repeat(8 * 1024));
    expect((await call("POST", "/api/credentials/ads/import", {})).body).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    // A good token padded with whitespace past 8 KiB: it would be accepted after trimming, but the file is too large.
    writeDevKey(`${TOKEN}${" ".repeat(8 * 1024)}`);
    expect((await call("POST", "/api/credentials/ads/import", {})).body).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(keychain.size).toBe(0);
    writeDevKey(`${TOKEN}${" ".repeat(100)}\n`);
    expect((await call("POST", "/api/credentials/ads/import", {})).body).toMatchObject({
      ok: true,
    });
  });

  test("import: a FIFO at ~/.ads/dev_key is not a key file and does not block the server", async () => {
    mkdirSync(join(devKeyDir, ".ads"), { recursive: true });
    execFileSync("mkfifo", [devKeyPath()]);
    const status = await call("GET", "/api/credentials/ads");
    expect(status.body).toMatchObject({ devKey: { exists: false } });
    const r = await call("POST", "/api/credentials/ads/import", {});
    expect(r.body).toEqual({ ok: false, reason: "no_dev_key" });
    expect(keychain.size).toBe(0);
  }, 10_000);

  test("a damaged restricted file: status unreadable, never a value", async () => {
    keychainUp = false;
    writeFileSync(join(globalDir, "ads-credentials.json"), "{ not json");
    const r = await call("GET", "/api/credentials/ads");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ saved: "unreadable" });
  });

  test("the default key file is ~/.ads/dev_key (shown with ~), looked for without writing anything", async () => {
    await srv?.close();
    await start({ adsDevKeyPath: undefined });
    const r = await call("GET", "/api/credentials/ads");
    expect((r.body.devKey as { path: { display: string } }).path.display).toBe("~/.ads/dev_key");
  });

  test("a keychain whose read hangs: the request answers anyway, as without a token", async () => {
    await call("PUT", "/api/credentials/ads", { token: TOKEN });
    keychainHangs = true;
    const started = Date.now();
    const status = await fetch(`${base}/api/library/discovery?bibcode=2016ApJ...818...46F`).then(
      (r) => r.status
    );
    expect(status).toBe(503);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(requests).toEqual([]);
  }, 15_000);

  test("an offline refresh reads the ADS credential like an online one: the summary says ok, not no-token", async () => {
    await srv?.close();
    await start({ deps: {} });
    await call("PUT", "/api/credentials/ads", { token: TOKEN });
    keychainReads = 0;
    const offline = await fetch(`${base}/api/library/refresh?offline=true`, { method: "POST" });
    expect(offline.status).toBe(200);
    expect(((await offline.json()) as { ads_status: string }).ads_status).toBe("ok");
    expect(keychainReads).toBeGreaterThan(0);
    // and no request left the machine: offline sends nothing, to ADS or anywhere
    expect(requests).toEqual([]);
  }, 30_000);
});

describe("the composition (also the CLI's, which composes the same way)", () => {
  test("offline (`--offline`, an offline refresh) reads the token as online does; without one, no-token", async () => {
    let reads = 0;
    let saved: string | null = TOKEN;
    const adsToken = async () => {
      reads += 1;
      return saved;
    };
    const paths = libraryPaths(dataDir);
    const offline = await realSources(paths, true, { adsToken });
    expect(reads).toBe(1);
    expect(offline.ads.status).toBe("ok");
    const online = await realSources(paths, false, { adsToken, fetchImpl: fetchStub });
    expect(reads).toBe(2);
    expect(online.ads.status).toBe("ok");
    saved = null;
    expect((await realSources(paths, true, { adsToken })).ads.status).toBe("no-token");
  });
});
