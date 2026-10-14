/**
 * The credential store addressed by purpose and id (desktop-app ticket 12). The keychain backend is always injected:
 * no test here touches a real OS keychain. The mail passwords saved before the store was generalized — in the
 * keychain under the service `argelanderspace.mail`, and in the fallback file `credentials.json` — are written here
 * the way the earlier code wrote them (an independent copy of its format), and must still be read without migration.
 */

import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ADS_CREDENTIAL_FILE_NAME,
  ADS_TOKEN_ID,
  CREDENTIAL_FILE_NAME,
  CREDENTIAL_STORE_METHODS,
  createCredentialStore,
  createNapiKeychainBackend,
  type KeychainBackend,
  type NapiKeyringModule,
} from "../src/credential-store.js";

const MAIL_PW = "mail-Passw0rd-MARK";
const ADS_TOKEN = "ads-token-MARK-0123456789";
const tmps: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cred-purpose-"));
  tmps.push(d);
  return d;
}

afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** One in-memory keychain shared by every store, keyed the way an OS keychain is: service and account. */
function sharedKeychain(): KeychainBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const k = (account: string, service: string) => `${service}\u0000${account}`;
  return {
    map,
    get: (a, s) => map.get(k(a, s)) ?? null,
    set: (a, p, s) => void map.set(k(a, s), p),
    delete: (a, s) => map.delete(k(a, s)),
  };
}

function brokenBackend(): KeychainBackend {
  const boom = () => {
    throw new Error("no secret service");
  };
  return { get: boom, set: boom, delete: boom };
}

/** The fallback file exactly as the code before ticket 12 wrote it (Mail ticket 02's format). */
function writePreGeneralizationFile(dir: string, accountId: string, password: string): void {
  let who = "";
  try {
    who = `${userInfo().username}@${hostname()}`;
  } catch {
    // as the original
  }
  const salt = randomBytes(16);
  const key = scryptSync(`argelanderspace.mail.credentials|${who}`, salt, 32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(accountId));
  const ct = Buffer.concat([c.update(password, "utf8"), c.final()]);
  const body = JSON.stringify({
    v: 1,
    salt: salt.toString("base64"),
    entries: {
      [accountId]: {
        iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      },
    },
  });
  writeFileSync(join(dir, "credentials.json"), `${body}\n`, { mode: 0o600 });
}

describe("purposes do not interfere", () => {
  test("an ADS token and a mail password with the same id live side by side in one keychain", async () => {
    const dir = tmpDir();
    const keychain = sharedKeychain();
    const mail = createCredentialStore({ backend: keychain, dataDir: dir });
    const ads = createCredentialStore({ purpose: "ads", backend: keychain, dataDir: dir });
    await mail.set(ADS_TOKEN_ID, MAIL_PW);
    await ads.set(ADS_TOKEN_ID, ADS_TOKEN);
    expect(keychain.map.get(`argelanderspace.mail\u0000${ADS_TOKEN_ID}`)).toBe(MAIL_PW);
    expect(keychain.map.get(`argelanderspace.ads\u0000${ADS_TOKEN_ID}`)).toBe(ADS_TOKEN);
    expect(await mail.get(ADS_TOKEN_ID)).toMatchObject({ status: "ok", password: MAIL_PW });
    expect(await ads.get(ADS_TOKEN_ID)).toMatchObject({ status: "ok", password: ADS_TOKEN });
    expect(await ads.delete(ADS_TOKEN_ID)).toEqual({ status: "deleted" });
    expect(await mail.get(ADS_TOKEN_ID)).toMatchObject({ status: "ok", password: MAIL_PW });
    expect(await ads.get(ADS_TOKEN_ID)).toEqual({ status: "not-found" });
  });

  test("the fallback files are separate: an ADS write never rewrites the mail file", async () => {
    const dir = tmpDir();
    const mail = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    const ads = createCredentialStore({ purpose: "ads", backend: brokenBackend(), dataDir: dir });
    await mail.set("acc-000000000001", MAIL_PW, { fileFallbackConsent: true });
    const mailBytes = readFileSync(join(dir, CREDENTIAL_FILE_NAME));
    expect(await ads.set(ADS_TOKEN_ID, ADS_TOKEN, { fileFallbackConsent: true })).toEqual({
      status: "stored",
      protection: "file",
      keychainProtected: false,
    });
    expect(readFileSync(join(dir, CREDENTIAL_FILE_NAME)).equals(mailBytes)).toBe(true);
    expect(existsSync(join(dir, ADS_CREDENTIAL_FILE_NAME))).toBe(true);
    expect(readFileSync(join(dir, ADS_CREDENTIAL_FILE_NAME), "utf8")).not.toContain(ADS_TOKEN);
    expect(await ads.get(ADS_TOKEN_ID)).toMatchObject({
      status: "ok",
      password: ADS_TOKEN,
      protection: "file",
    });
    expect(await mail.get("acc-000000000001")).toMatchObject({ status: "ok", password: MAIL_PW });
    expect(await ads.delete(ADS_TOKEN_ID)).toEqual({
      status: "deleted",
      keychainUnavailable: true,
    });
    expect(await mail.get("acc-000000000001")).toMatchObject({ status: "ok", password: MAIL_PW });
  });

  test("without consent the ADS store writes no file", async () => {
    const dir = tmpDir();
    const ads = createCredentialStore({ purpose: "ads", backend: brokenBackend(), dataDir: dir });
    expect(await ads.set(ADS_TOKEN_ID, ADS_TOKEN)).toEqual({ status: "keychain-unavailable" });
    expect(
      await ads.set(ADS_TOKEN_ID, ADS_TOKEN, { fileFallbackConsent: "yes" as unknown as boolean })
    ).toEqual({
      status: "keychain-unavailable",
    });
    expect(existsSync(join(dir, ADS_CREDENTIAL_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, CREDENTIAL_FILE_NAME))).toBe(false);
    expect(await ads.get(ADS_TOKEN_ID)).toEqual({ status: "keychain-unavailable" });
  });
});

describe("mail passwords saved before the generalization", () => {
  test("a keychain entry under the service argelanderspace.mail is read as before", async () => {
    const dir = tmpDir();
    const keychain = sharedKeychain();
    keychain.map.set(`argelanderspace.mail\u0000acc-0123456789ab`, MAIL_PW);
    const mail = createCredentialStore({ backend: keychain, dataDir: dir });
    expect(await mail.get("acc-0123456789ab")).toEqual({
      status: "ok",
      password: MAIL_PW,
      protection: "keychain",
      keychainProtected: true,
    });
  });

  test("the native backend still opens mail entries under argelanderspace.mail, ADS under argelanderspace.ads", async () => {
    const opened: Array<[string, string]> = [];
    const load = async (): Promise<NapiKeyringModule> => ({
      Entry: class {
        constructor(service: string, username: string) {
          opened.push([service, username]);
        }
        getPassword() {
          return null;
        }
        setPassword() {}
        deletePassword() {
          return false;
        }
      },
    });
    const backend = createNapiKeychainBackend(load);
    const dir = tmpDir();
    await createCredentialStore({ backend, dataDir: dir }).get("acc-0123456789ab");
    await createCredentialStore({ purpose: "ads", backend, dataDir: dir }).get(ADS_TOKEN_ID);
    expect(opened).toEqual([
      ["argelanderspace.mail", "acc-0123456789ab"],
      ["argelanderspace.ads", ADS_TOKEN_ID],
    ]);
  });

  test("a fallback file written by the earlier code is read, and its bytes are not touched by reading", async () => {
    const dir = tmpDir();
    writePreGeneralizationFile(dir, "acc-0123456789ab", MAIL_PW);
    const before = readFileSync(join(dir, "credentials.json"));
    const mail = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    expect(await mail.get("acc-0123456789ab")).toEqual({
      status: "ok",
      password: MAIL_PW,
      protection: "file",
      keychainProtected: false,
    });
    // The ADS store does not see the mail file's entries.
    const ads = createCredentialStore({ purpose: "ads", backend: brokenBackend(), dataDir: dir });
    expect(await ads.get("acc-0123456789ab")).toEqual({ status: "keychain-unavailable" });
    expect(readFileSync(join(dir, "credentials.json")).equals(before)).toBe(true);
  });
});

describe("status: what is saved, never the value", () => {
  test("not saved / keychain / file, and whether the keychain answered", async () => {
    const dir = tmpDir();
    const keychain = sharedKeychain();
    const ads = createCredentialStore({ purpose: "ads", backend: keychain, dataDir: dir });
    expect(await ads.status(ADS_TOKEN_ID)).toEqual({ status: "not-found", keychain: "available" });
    await ads.set(ADS_TOKEN_ID, ADS_TOKEN);
    const saved = await ads.status(ADS_TOKEN_ID);
    expect(saved).toEqual({ status: "stored", protection: "keychain", keychain: "available" });
    expect(JSON.stringify(saved)).not.toContain(ADS_TOKEN);

    const noKeychain = createCredentialStore({
      purpose: "ads",
      backend: brokenBackend(),
      dataDir: tmpDir(),
    });
    expect(await noKeychain.status(ADS_TOKEN_ID)).toEqual({
      status: "not-found",
      keychain: "unavailable",
    });
    await noKeychain.set(ADS_TOKEN_ID, ADS_TOKEN, { fileFallbackConsent: true });
    const inFile = await noKeychain.status(ADS_TOKEN_ID);
    expect(inFile).toEqual({ status: "stored", protection: "file", keychain: "unavailable" });
    expect(JSON.stringify(inFile)).not.toContain(ADS_TOKEN);
  });

  test("the store's methods are the listed ones (a wrapper built from the list loses none)", () => {
    const store = createCredentialStore({ backend: sharedKeychain(), dataDir: tmpDir() });
    expect(Object.keys(store).sort()).toEqual([...CREDENTIAL_STORE_METHODS].sort());
  });
});

describe("a damaged ADS fallback file (ticket 12 revision)", () => {
  test("status and get report the file as unreadable; nothing of it is returned; the mail file is not involved", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ADS_CREDENTIAL_FILE_NAME), "{ not json");
    const ads = createCredentialStore({ purpose: "ads", backend: brokenBackend(), dataDir: dir });
    expect(await ads.status(ADS_TOKEN_ID)).toEqual({ status: "error", code: "file-unreadable" });
    expect(await ads.get(ADS_TOKEN_ID)).toEqual({ status: "error", code: "file-unreadable" });
    const mail = createCredentialStore({ backend: brokenBackend(), dataDir: dir });
    expect(await mail.get("acc-0123456789ab")).toEqual({ status: "keychain-unavailable" });
    expect(readFileSync(join(dir, ADS_CREDENTIAL_FILE_NAME), "utf8")).toBe("{ not json");
  });
});
