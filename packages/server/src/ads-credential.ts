/**
 * The ADS credential endpoints (desktop-app ticket 12; shapes in contracts `ads-credential-api.ts`). The token lives
 * in the credential store's `ads` purpose — the OS keychain, or the restricted file only with the user's consent, the
 * same rules as a mail password — never in config.toml. Every answer is `no-store` and none carries the token: the
 * status says where it is, a test says what ADS answered, an import says what was saved. The token is not logged
 * (the store is wrapped only for whether the keychain answered; the test request is logged by host and status).
 *
 * The import reads `~/.ads/dev_key` and saves its content; the file is opened for reading only and never written,
 * moved or removed (its bytes and modification time stay as they were). Nothing reads the file afterwards (the
 * find-papers skill searches with the saved token since release-0.2 ticket 12).
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ADS_CREDENTIAL_BODY_MAX_BYTES,
  type AdsCredentialChangeResponse,
  type AdsCredentialRefusal,
  type AdsCredentialStatus,
  type AdsTokenTestResponse,
  isAdsTokenShaped,
} from "@argelanderspace/contracts";
import {
  ADS_TOKEN_ID,
  type CredentialStore,
  type FetchImpl,
  type SetCredentialResult,
  testAdsToken,
} from "@argelanderspace/infra";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readLimited } from "./page-errors.js";
import type { ProtectedRoutes } from "./protected-app.js";
import { shownPath } from "./settings.js";

export interface AdsCredentialRouteOptions {
  /** The `ads` credential store (production: over the OS keychain, wrapped for the log). */
  store: CredentialStore;
  /** The HTTP implementation of the token test (production: the global fetch, observed for the log). */
  fetchImpl?: FetchImpl | undefined;
  /** Where `~/.ads/dev_key` is; default under the home directory, asked at each request. */
  devKeyPath?: (() => string) | undefined;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** The largest `~/.ads/dev_key` the import reads; a token is far shorter. */
const DEV_KEY_MAX_BYTES = 8192;

const STATUS_OF: Record<AdsCredentialRefusal, ContentfulStatusCode> = {
  invalid_request: 400,
  invalid_token: 400,
  keychain_unavailable: 422,
  not_saved: 409,
  no_dev_key: 404,
  dev_key_unreadable: 500,
  file_unreadable: 500,
  storage_failed: 500,
};

/** The body as JSON, within the size limit; null when it is not. */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    const bytes = await readLimited(c, ADS_CREDENTIAL_BODY_MAX_BYTES);
    if (bytes === null) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `~/.ads/dev_key`: the content, or why it could not be had. Read-only: opened for reading, nothing else. Opened
 * non-blocking, so a FIFO (or a device) there does not hang the request: anything but a regular file is "no key file".
 * A symbolic link is followed, as before.
 */
function readDevKey(
  path: string
): { ok: true; text: string } | { ok: false; reason: AdsCredentialRefusal } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "no_dev_key" : "dev_key_unreadable",
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "no_dev_key" };
    if (stat.size > DEV_KEY_MAX_BYTES) return { ok: false, reason: "invalid_token" };
    const buffer = Buffer.alloc(DEV_KEY_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > DEV_KEY_MAX_BYTES) return { ok: false, reason: "invalid_token" };
    }
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
    };
  } catch {
    return { ok: false, reason: "dev_key_unreadable" };
  } finally {
    closeSync(fd);
  }
}

function devKeyExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function mountAdsCredentialRoutes(
  routes: ProtectedRoutes,
  options: AdsCredentialRouteOptions
): void {
  const app = routes.withDefaults({ noStore: true });
  const { store } = options;
  const devKeyPath = options.devKeyPath ?? (() => join(homedir(), ".ads", "dev_key"));

  const status = async (): Promise<AdsCredentialStatus> => {
    const s = await store.status(ADS_TOKEN_ID);
    const path = devKeyPath();
    return {
      version: 1,
      saved:
        s.status === "stored" ? s.protection : s.status === "not-found" ? "none" : "unreadable",
      // A damaged file says nothing of the keychain; the next save tries it first anyway.
      keychain: s.status === "error" ? "unavailable" : s.keychain,
      devKey: { exists: devKeyExists(path), path: shownPath(path) },
    };
  };

  const refuse = (c: Context, reason: AdsCredentialRefusal) =>
    c.json(
      { ok: false, reason } satisfies AdsCredentialChangeResponse,
      STATUS_OF[reason],
      NO_STORE
    );

  /** Save a token by the store's rules; the answer is the status after it, never the token. */
  const save = async (c: Context, token: string, consent: boolean) => {
    const result: SetCredentialResult = await store.set(ADS_TOKEN_ID, token, {
      fileFallbackConsent: consent,
    });
    if (result.status === "keychain-unavailable") return refuse(c, "keychain_unavailable");
    if (result.status === "error")
      return refuse(c, result.code === "file-unreadable" ? "file_unreadable" : "storage_failed");
    return c.json(
      { ok: true, status: await status() } satisfies AdsCredentialChangeResponse,
      200,
      NO_STORE
    );
  };

  app.get("/api/credentials/ads", async (c) => c.json(await status(), 200, NO_STORE));

  app.put("/api/credentials/ads", async (c) => {
    const body = await jsonBody(c);
    if (!isObject(body) || typeof body.token !== "string") return refuse(c, "invalid_request");
    const token = body.token.trim();
    if (!isAdsTokenShaped(token)) return refuse(c, "invalid_token");
    return save(c, token, body.fileFallbackConsent === true);
  });

  app.delete("/api/credentials/ads", async (c) => {
    const result = await store.delete(ADS_TOKEN_ID);
    if (result.status === "keychain-unavailable") return refuse(c, "keychain_unavailable");
    if (result.status === "error")
      return refuse(c, result.code === "file-unreadable" ? "file_unreadable" : "storage_failed");
    return c.json(
      { ok: true, status: await status() } satisfies AdsCredentialChangeResponse,
      200,
      NO_STORE
    );
  });

  app.post("/api/credentials/ads/test", async (c) => {
    const body = await jsonBody(c);
    if (!isObject(body) || (body.token !== undefined && typeof body.token !== "string"))
      return refuse(c, "invalid_request");
    let token: string;
    if (typeof body.token === "string") {
      token = body.token.trim();
      if (!isAdsTokenShaped(token)) return refuse(c, "invalid_token");
    } else {
      const got = await store.get(ADS_TOKEN_ID);
      if (got.status === "error")
        return refuse(c, got.code === "file-unreadable" ? "file_unreadable" : "storage_failed");
      if (got.status !== "ok" || got.password.trim() === "") return refuse(c, "not_saved");
      token = got.password.trim();
    }
    const result = await testAdsToken(
      token,
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
    );
    return c.json({ ok: true, result } satisfies AdsTokenTestResponse, 200, NO_STORE);
  });

  app.post("/api/credentials/ads/import", async (c) => {
    const body = await jsonBody(c);
    if (!isObject(body)) return refuse(c, "invalid_request");
    const read = readDevKey(devKeyPath());
    if (!read.ok) return refuse(c, read.reason);
    const token = read.text.trim();
    if (!isAdsTokenShaped(token)) return refuse(c, "invalid_token");
    return save(c, token, body.fileFallbackConsent === true);
  });
}
