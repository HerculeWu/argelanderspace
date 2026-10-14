/**
 * The ADS token in the built CLI (desktop-app ticket 12). The CLI reads the token only from the workbench's credential
 * store, when a command needs it; the old sources — `$ADS_DEV_KEY`, config.toml's `ads_dev_key`, `~/.ads/dev_key` —
 * no longer count. Missing, the summary's hint points at the settings page.
 *
 * Hermetic: the child gets a throwaway HOME and XDG directories, and the session-bus isolation of the test setup
 * (isolate-user-dirs.ts; set again here explicitly), so the OS keychain reads as unavailable and the store falls back
 * to its restricted file in the child's global data directory — written by the test, with a fake token. The network
 * is an offline stub loaded into the child with `--import`: it answers every request itself and records what went to
 * ADS. Nothing reaches the real ADS, the real keychain or the real `~/.ads/dev_key`.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ADS_TOKEN_ID, createCredentialStore } from "@argelanderspace/infra";
import { afterEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const TOKEN = "zqxADSTOKENmark0123456789";
const HINT =
  "  Save an ADS token on the workbench's settings page (Literature services & credentials) to enable astro citation counts;";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The network of the child: every request answered here; what went to ADS recorded (host, auth header). */
const FETCH_STUB = `
import { appendFileSync } from "node:fs";
const record = process.env.ADS_STUB_RECORD;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const auth = new Headers(init?.headers).get("authorization");
  if (url.host.endsWith("adsabs.harvard.edu")) {
    appendFileSync(record, JSON.stringify({ host: url.host, auth }) + "\\n");
    return new Response(JSON.stringify({ response: { docs: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};
`;

interface Sandbox {
  root: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  record: string;
  globalDir: string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-ads-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  mkdirSync(home);
  mkdirSync(runtime, { mode: 0o700 });
  const dataDir = join(root, "data");
  const docDir = join(dataDir, "output", "arxiv-2501.17225");
  mkdirSync(docDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "tests", "golden", "tex", "arxiv-2501.17225.json"),
    join(docDir, "arxiv-2501.17225.json")
  );
  const stub = join(root, "fetch-stub.mjs");
  writeFileSync(stub, FETCH_STUB);
  const record = join(root, "ads-requests.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
    NODE_OPTIONS: `--import ${pathToFileURL(stub).href}`,
    ADS_STUB_RECORD: record,
  };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.ADS_DEV_KEY;
  return {
    root,
    dataDir,
    env,
    record,
    globalDir: join(home, ".local", "share", "argelanderspace"),
  };
}

function build(s: Sandbox, offline: boolean) {
  const r = spawnSync(
    process.execPath,
    [BIN, "library", "build", "--data-dir", s.dataDir, ...(offline ? ["--offline"] : [])],
    { env: s.env, encoding: "utf8", timeout: 120_000 }
  );
  const stdout = r.stdout ?? "";
  const summary = JSON.parse(stdout.slice(0, stdout.indexOf("\n}\n") + 3)) as {
    ads_status: string;
  };
  return { status: r.status, stdout, stderr: r.stderr ?? "", summary };
}

function adsRequests(s: Sandbox): Array<{ host: string; auth: string | null }> {
  if (!existsSync(s.record)) return [];
  return readFileSync(s.record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { host: string; auth: string | null });
}

/** The token in the child's credential store: its restricted file, as a save with consent writes it. */
async function saveToken(s: Sandbox, token: string): Promise<void> {
  const store = createCredentialStore({
    purpose: "ads",
    backend: {
      get: () => {
        throw new Error("no keychain in the test");
      },
      set: () => {
        throw new Error("no keychain in the test");
      },
      delete: () => {
        throw new Error("no keychain in the test");
      },
    },
    dataDir: s.globalDir,
  });
  expect(await store.set(ADS_TOKEN_ID, token, { fileFallbackConsent: true })).toMatchObject({
    status: "stored",
    protection: "file",
  });
}

describe("the ADS token of the built CLI", () => {
  test("CLI is built", () => {
    expect(existsSync(BIN)).toBe(true);
  });

  test("no token: no-token, and the hint points at the settings page (no error, keychain unavailable)", () => {
    const s = sandbox();
    const r = build(s, true);
    expect(r.status).toBe(0);
    expect(r.summary.ads_status).toBe("no-token");
    expect(r.stdout).toContain("⚠ ADS enrichment was not applied (status: no-token).");
    expect(r.stdout).toContain(`${HINT}\n`);
    expect(r.stdout).not.toContain("dev_key");
    expect(r.stdout).not.toContain("ADS_DEV_KEY");
  }, 120_000);

  test("the old sources do not count: $ADS_DEV_KEY, config ads_dev_key and ~/.ads/dev_key with an empty store", () => {
    const s = sandbox();
    const home = s.env.HOME as string;
    mkdirSync(join(home, ".ads"));
    writeFileSync(join(home, ".ads", "dev_key"), "old-file-token-111\n");
    mkdirSync(join(home, ".config", "argelanderspace"), { recursive: true });
    writeFileSync(
      join(home, ".config", "argelanderspace", "config.toml"),
      'ads_dev_key = "old-config-token-222"\n'
    );
    s.env.ADS_DEV_KEY = "old-env-token-333";
    const r = build(s, false);
    expect(r.status).toBe(0);
    expect(r.summary.ads_status).toBe("no-token");
    expect(r.stdout).toContain(HINT);
    expect(adsRequests(s)).toEqual([]);
  }, 120_000);

  test("a token in the credential store: the enrichment request to ADS carries it (offline stub)", async () => {
    const s = sandbox();
    await saveToken(s, TOKEN);
    // An old source with another value is set too: the store's token is the one used.
    s.env.ADS_DEV_KEY = "old-env-token-333";
    const r = build(s, false);
    expect(r.status).toBe(0);
    expect(r.summary.ads_status).toBe("ok");
    expect(r.stdout).not.toContain(HINT);
    const sent = adsRequests(s);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent)
      expect(req).toEqual({ host: "api.adsabs.harvard.edu", auth: `Bearer ${TOKEN}` });
    // The token is not printed.
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  }, 120_000);
});
