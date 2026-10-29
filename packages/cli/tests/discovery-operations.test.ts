/**
 * The CLI commands derived from the discovery domain of the operation catalog (release-0.2 ticket 09):
 * `argelanderspace discovery search-ads` and `discovery explore`. They are registered from the catalog, reject bad
 * parameters with exit code 2 before anything runs, and with a running workbench hand the search to it (the ADS token
 * and the network client are the workbench's, here an offline stub with an injected token).
 *
 * The in-process path of the same operations (no workbench) is covered in the server package
 * (`discovery-operations.test.ts`, `createLocalOperationRuntime` with an injected token and ADS stub): a CLI child
 * process would read the real credential store of the machine running the tests, which a test must not do.
 */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  realAdsSearch,
  registerWorkbench,
} from "@argelanderspace/server";
import { afterEach, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const roots: string[] = [];
const closers: (() => unknown)[] = [];
const TOKEN = "SYNTHETIC-ADS-TOKEN";

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-ads-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  const run = (args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [BIN, ...args, "--data-dir", dataDir],
        { env, encoding: "utf8", timeout: 60_000 },
        (error, stdout, stderr) =>
          resolve({
            status: error === null ? 0 : ((error as { code?: number }).code ?? 1),
            stdout,
            stderr,
          })
      );
    });
  return { root, dataDir, run };
}

function fileCount(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    count += statSync(full).isDirectory() ? fileCount(full) : 1;
  }
  return count;
}

test("the catalog's discovery operations are CLI commands; interface actions are not", async () => {
  const { run } = setup();
  const help = await run(["discovery", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("search-ads");
  expect(help.stdout).toContain("explore");
  for (const ui of ["filter-discovery", "select-candidate", "read-discovery", "save-candidate"])
    expect(help.stdout).not.toContain(ui);
  const search = await run(["discovery", "search-ads", "--help"]);
  for (const flag of ["--query", "--limit", "--fields", "--json"])
    expect(search.stdout).toContain(flag);
  expect(OPERATION_CATALOG.map((op) => op.id)).toEqual(
    expect.arrayContaining(["discovery.search_ads", "discovery.explore"])
  );
});

test("bad parameters exit 2 with unsupported, before any search or token read", async () => {
  const { run, dataDir } = setup();
  const before = fileCount(dataDir);
  for (const args of [
    ["discovery", "search-ads"],
    ["discovery", "search-ads", "--query", "x", "--limit", "51"],
    ["discovery", "search-ads", "--query", "x", "--limit", "two"],
    ["discovery", "search-ads", "--query", "x", "--fields", "title,password"],
    ["discovery", "explore"],
  ]) {
    const result = await run(args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout), args.join(" ")).toMatchObject({
      ok: false,
      status: "unsupported",
    });
  }
  expect(fileCount(dataDir)).toBe(before);
});

test("with a running workbench the search goes through it: records on stdout, no_token as exit 1, nothing written", async () => {
  const { dataDir, run } = setup();
  let token: string | null = TOKEN;
  const sent: { method: string; auth: string | undefined; url: string }[] = [];
  const operationToken = newWorkbenchToken();
  const srv = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken,
    deps: {
      makeAdsSearch: () =>
        realAdsSearch({
          adsToken: async () => token,
          fetchImpl: (async (url: string, init?: RequestInit) => {
            sent.push({
              method: init?.method ?? "GET",
              auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
              url: String(url),
            });
            return new Response(
              JSON.stringify({
                response: {
                  numFound: 2,
                  docs: [{ bibcode: "2020A", title: ["T"], year: "2020" }],
                },
              }),
              { status: 200 }
            );
          }) as unknown as typeof fetch,
        }),
    },
  });
  closers.push(() => srv.close());
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token: operationToken });
  closers.push(() => registration.revoke());
  const before = fileCount(dataDir);

  const found = await run([
    "discovery",
    "search-ads",
    "--query",
    "title:cluster",
    "--limit",
    "3",
    "--fields",
    "title,year",
  ]);
  expect(found.status).toBe(0);
  expect(JSON.parse(found.stdout)).toEqual({
    ok: true,
    status: "ok",
    query: "title:cluster",
    numFound: 2,
    returned: 1,
    records: [{ bibcode: "2020A", title: "T", year: 2020 }],
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "GET", auth: `Bearer ${TOKEN}` });
  expect(sent[0]?.url).toContain("rows=3");
  expect(found.stdout + found.stderr).not.toContain(TOKEN);

  const viaJson = await run(["discovery", "search-ads", "--json", "-"]);
  expect(viaJson.status).toBe(2); // stdin is not a JSON object here (empty): refused, nothing run
  expect(sent).toHaveLength(1);

  token = null;
  const none = await run(["discovery", "search-ads", "--query", "x"]);
  expect(none.status).toBe(1);
  expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, status: "error", reason: "no_token" });
  expect(none.stdout + none.stderr).not.toContain(TOKEN);
  expect(sent).toHaveLength(1); // no token: no request
  expect(fileCount(dataDir)).toBe(before);
});
