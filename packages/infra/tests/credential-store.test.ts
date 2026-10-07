/**
 * Credential store (Mail ticket 02, ADR 0008). The keychain backend is always
 * injected: no test touches a real OS keychain or a real mailbox.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CREDENTIAL_FILE_NAME,
  createCredentialStore,
  createNapiKeychainBackend,
  type KeychainBackend,
} from "../src/credential-store.js";

const PW = "s3cret-Passw0rd-XYZ";
const tmps: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cred-store-"));
  tmps.push(d);
  return d;
}

afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** In-memory keychain. */
function memoryBackend(): KeychainBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (a) => map.get(a) ?? null,
    set: (a, p) => void map.set(a, p),
    delete: (a) => map.delete(a),
  };
}

/** Headless Linux: no Secret Service; every call throws, leaking the secret in the message. */
function brokenBackend(): KeychainBackend {
  const boom = (secret?: string) => {
    throw new Error(
      `Platform secure storage failure: DBus error: no secret service${secret ? ` (value ${secret})` : ""}`
    );
  };
  return { get: () => boom(), set: (_a, p) => boom(p), delete: () => boom() };
}

describe("keychain available", () => {
  test("set/get/delete go through the keychain and never write a file", async () => {
    const dir = tmpDir();
    const backend = memoryBackend();
    const store = createCredentialStore({ backend, dataDir: dir });
    expect(await store.set("acc1", PW)).toEqual({
      status: "stored",
      protection: "keychain",
      keychainProtected: true,
    });
    expect(backend.map.get("acc1")).toBe(PW);
    expect(existsSync(join(dir, CREDENTIAL_FILE_NAME))).toBe(false);
    expect(await store.get("acc1")).toEqual({
      status: "ok",
      password: PW,
      protection: "keychain",
      keychainProtected: true,
    });
    expect(await store.delete("acc1")).toEqual({ status: "deleted" });
    expect(await store.get("acc1")).toEqual({ status: "not-found" });
    expect(await store.delete("acc1")).toEqual({ status: "not-found" });
  });

  test("rejects an empty account id or empty password without echoing input", async () => {
    const store = createCredentialStore({ backend: memoryBackend(), dataDir: tmpDir() });
    expect(await store.set("", PW)).toEqual({ status: "error", code: "invalid-input" });
    expect(await store.set("acc", "")).toEqual({ status: "error", code: "invalid-input" });
    expect(await store.get("")).toEqual({ status: "error", code: "invalid-input" });
  });
});

describe("keychain unavailable (headless Linux failure path)", () => {
  test("set without consent reports keychain-unavailable and writes nothing", async () => {
    const dir = tmpDir();
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    const r = await store.set("acc1", PW);
    expect(r).toEqual({ status: "keychain-unavailable" });
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(existsSync(join(dir, CREDENTIAL_FILE_NAME))).toBe(false);
  });

  test("consent must be exactly true; truthy look-alikes do not count", async () => {
    const dir = tmpDir();
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong type from an untrusted caller
    const r = await store.set("acc1", PW, { fileFallbackConsent: "yes" as any });
    expect(r).toEqual({ status: "keychain-unavailable" });
    expect(existsSync(join(dir, CREDENTIAL_FILE_NAME))).toBe(false);
  });

  test("get/delete report keychain-unavailable and no error carries the secret", async () => {
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: tmpDir() });
    const g = await store.get("acc1");
    const d = await store.delete("acc1");
    expect(g).toEqual({ status: "keychain-unavailable" });
    expect(d).toEqual({ status: "keychain-unavailable" });
  });

  test("a native module that fails to load is also 'unavailable'", async () => {
    const backend = createNapiKeychainBackend(async () => {
      throw new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'");
    });
    const store = createCredentialStore({ backend, dataDir: tmpDir() });
    expect(await store.get("a")).toEqual({ status: "keychain-unavailable" });
    expect(await store.set("a", PW)).toEqual({ status: "keychain-unavailable" });
  });
});

describe("consented file fallback", () => {
  test("writes a 0600 file with no plaintext and reports 'not keychain protected'", async () => {
    const dir = tmpDir();
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    const r = await store.set("acc1", PW, { fileFallbackConsent: true });
    expect(r).toEqual({ status: "stored", protection: "file", keychainProtected: false });
    expect(JSON.stringify(r)).not.toContain(PW);

    const file = join(dir, CREDENTIAL_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(PW);
    expect(Buffer.from(raw).toString("base64")).not.toContain(Buffer.from(PW).toString("base64"));

    expect(await store.get("acc1")).toEqual({
      status: "ok",
      password: PW,
      protection: "file",
      keychainProtected: false,
    });
  });

  test("a new store instance reads the file back; other accounts are independent", async () => {
    const dir = tmpDir();
    const a = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    await a.set("acc1", PW, { fileFallbackConsent: true });
    await a.set("acc2", "other-pw", { fileFallbackConsent: true });
    const b = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    expect(await b.get("acc1")).toMatchObject({ status: "ok", password: PW });
    expect(await b.get("acc2")).toMatchObject({ status: "ok", password: "other-pw" });
    expect(await b.get("acc3")).toEqual({ status: "keychain-unavailable" });
    // file copy gone, keychain unreachable: reported honestly, not as a plain delete
    expect(await b.delete("acc1")).toEqual({ status: "deleted", keychainUnavailable: true });
    expect(await b.get("acc1")).toEqual({ status: "keychain-unavailable" });
    expect(await b.get("acc2")).toMatchObject({ status: "ok", password: "other-pw" });
  });

  test("a working keychain with a file entry: file value still readable, flagged unprotected", async () => {
    const dir = tmpDir();
    await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).set("acc1", PW, {
      fileFallbackConsent: true,
    });
    const store = createCredentialStore({ backend: memoryBackend(), dataDir: dir });
    expect(await store.get("acc1")).toEqual({
      status: "ok",
      password: PW,
      protection: "file",
      keychainProtected: false,
    });
  });

  test("setting into a now-working keychain migrates: file entry is removed", async () => {
    const dir = tmpDir();
    await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).set("acc1", PW, {
      fileFallbackConsent: true,
    });
    const backend = memoryBackend();
    const store = createCredentialStore({ backend, dataDir: dir });
    expect(await store.set("acc1", "new-pw")).toMatchObject({ protection: "keychain" });
    expect(await store.get("acc1")).toMatchObject({ password: "new-pw", protection: "keychain" });
    // file no longer yields the account
    const fileOnly = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    expect(await fileOnly.get("acc1")).toEqual({ status: "keychain-unavailable" });
  });

  test("delete removes from both keychain and file", async () => {
    const dir = tmpDir();
    await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).set("acc1", PW, {
      fileFallbackConsent: true,
    });
    const backend = memoryBackend();
    backend.map.set("acc1", "kc");
    const store = createCredentialStore({ backend, dataDir: dir });
    expect(await store.delete("acc1")).toEqual({ status: "deleted" });
    expect(backend.map.has("acc1")).toBe(false);
    expect(await store.get("acc1")).toEqual({ status: "not-found" });
  });

  test("a corrupt file yields a code-only error, never contents or a throw", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, CREDENTIAL_FILE_NAME), `{"v":1,"entries":{"acc1":"${PW}"`);
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    const g = await store.get("acc1");
    expect(g).toEqual({ status: "error", code: "file-unreadable" });
    expect(JSON.stringify(g)).not.toContain(PW);
    const s = await store.set("acc1", PW, { fileFallbackConsent: true });
    expect(s).toEqual({ status: "error", code: "file-unreadable" });
    // the corrupt file is left untouched (not silently overwritten)
    expect(readFileSync(join(dir, CREDENTIAL_FILE_NAME), "utf8")).toContain(PW);
  });

  test("a tampered ciphertext is an error, not a wrong password", async () => {
    const dir = tmpDir();
    const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    await store.set("acc1", PW, { fileFallbackConsent: true });
    const file = join(dir, CREDENTIAL_FILE_NAME);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.entries.acc1.ct = Buffer.from("tampered-bytes").toString("base64");
    writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    expect(await store.get("acc1")).toEqual({ status: "error", code: "file-unreadable" });
  });

  test("file write failure is a code-only error", async () => {
    const dir = tmpDir();
    // dataDir is a file, so mkdir/write cannot succeed (root-safe failure mode)
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const store = createCredentialStore({
      backend: brokenBackend(),
      dataDir: join(blocker, "sub"),
    });
    const r = await store.set("acc1", PW, { fileFallbackConsent: true });
    expect(r).toEqual({ status: "error", code: "file-write-failed" });
    expect(JSON.stringify(r)).not.toContain(PW);
  });
});

describe("napi backend adapter", () => {
  test("maps the native Entry API onto the narrow interface", async () => {
    const store = new Map<string, string>();
    const calls: string[] = [];
    const opts: unknown[] = [];
    class FakeEntry {
      constructor(
        readonly service: string,
        readonly user: string,
        options?: unknown
      ) {
        calls.push(`${service}/${user}`);
        opts.push(options);
      }
      getPassword() {
        return store.get(this.user) ?? null;
      }
      setPassword(p: string) {
        store.set(this.user, p);
      }
      deletePassword() {
        return store.delete(this.user);
      }
    }
    const backend = createNapiKeychainBackend(async () => ({ Entry: FakeEntry }));
    await backend.set("acc1", PW);
    expect(await backend.get("acc1")).toBe(PW);
    expect(await backend.get("nope")).toBeNull();
    expect(await backend.delete("acc1")).toBe(true);
    expect(await backend.delete("acc1")).toBe(false);
    expect(calls.every((c) => c.startsWith("argelanderspace.mail/"))).toBe(true);
    // Linux must never fall back silently to the in-memory kernel keyutils store.
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o).toEqual({ linux: { store: "secret-service" } });
  });

  test("a constructor that throws (no Secret Service) surfaces as keychain-unavailable", async () => {
    class NoSecretService {
      constructor() {
        throw new Error(`no Secret Service available (value ${PW})`);
      }
    }
    const backend = createNapiKeychainBackend(async () => ({
      Entry: NoSecretService as never,
    }));
    const store = createCredentialStore({ backend, dataDir: tmpDir() });
    const r = await store.set("a", PW);
    expect(r).toEqual({ status: "keychain-unavailable" });
    expect(JSON.stringify(r)).not.toContain(PW);
  });
});

describe("prototype-key account ids", () => {
  for (const id of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    test(`${id} behaves as a plain account id`, async () => {
      const dir = tmpDir();
      const store = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
      // before anything is stored, inherited properties must not look like entries
      expect(await store.get(id)).toEqual({ status: "keychain-unavailable" });
      expect(await store.set(id, PW, { fileFallbackConsent: true })).toMatchObject({
        status: "stored",
        protection: "file",
      });
      const again = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
      expect(await again.get(id)).toMatchObject({ status: "ok", password: PW });
      expect(await again.get("other")).toEqual({ status: "keychain-unavailable" });
      expect(await again.delete(id)).toEqual({ status: "deleted", keychainUnavailable: true });
      expect(await again.get(id)).toEqual({ status: "keychain-unavailable" });
    });
  }
});

describe("file cleanup failures are reported", () => {
  test("delete: a failed rewrite is file-write-failed", async () => {
    const dir = tmpDir();
    await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).set("acc1", PW, {
      fileFallbackConsent: true,
    });
    // make the tmp file impossible to create: replace the directory with a read-only one
    chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() === 0) return; // root bypasses permissions; not simulatable
      const r = await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).delete(
        "acc1"
      );
      expect(r).toEqual({ status: "error", code: "file-write-failed" });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("set into a working keychain flags a stale file copy that could not be removed", async () => {
    const dir = tmpDir();
    await createCredentialStore({ backend: brokenBackend(), dataDir: dir }).set("acc1", PW, {
      fileFallbackConsent: true,
    });
    chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() === 0) return;
      const r = await createCredentialStore({ backend: memoryBackend(), dataDir: dir }).set(
        "acc1",
        "new-pw"
      );
      expect(r).toEqual({
        status: "stored",
        protection: "keychain",
        keychainProtected: true,
        staleFileCopy: true,
      });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
