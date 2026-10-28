/**
 * The discovery-domain catalog operations (release-0.2 ticket 09): `discovery.search_ads` (read-only ADS search) and
 * `discovery.explore`. Everything runs against an offline ADS stub with an injected token; no real credential store
 * or network is touched. The search must send only GETs, keep the token in the Authorization header, and leave the
 * data folder byte-identical; each failure kind must be distinguishable; the in-process run, the running workbench's
 * route and the Copilot `library` tool must give the same answer.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { type AdsDiscoverySource, libraryPaths } from "@argelanderspace/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { jsonResponse, type StubCall, stubFetch } from "../../infra/tests/helpers.js";
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { realAdsSearch } from "../src/deps.js";
import {
  createLocalOperationRuntime,
  createServer,
  newWorkbenchToken,
  type RunningServer,
  runCatalogOperation,
  runOnWorkbench,
} from "../src/index.js";
import { AsyncLock } from "../src/lock.js";
import { isolatedGlobalDirs, stubSources } from "./helpers.js";

const TOKEN = "SYNTHETIC-ADS-TOKEN";
const DOC = {
  bibcode: "2020ApJ...900....1H",
  title: ["Open clusters"],
  author: ["Hunt, E. L.", "Reffert, S."],
  year: "2020",
  pub: "ApJ",
  citation_count: 3,
  doi: ["10.1/x"],
  abstract: "An abstract.",
  identifier: ["arXiv:2001.00001"],
};

let root: string;
let dataDir: string;
let calls: StubCall[];
let token_: string | null;
let handler: (call: StubCall) => Response | Promise<Response>;
const servers: RunningServer[] = [];

const healthy = (call: StubCall): Response => {
  const url = new URL(call.url);
  if (url.pathname !== "/v1/search/query") return new Response("", { status: 404 });
  const q = url.searchParams.get("q") ?? "";
  if (q.includes("((")) return new Response("syntax", { status: 400 });
  return jsonResponse({ response: { numFound: 41, start: 0, docs: [DOC] } });
};

/** The wiring of the network clients: the stub as `fetch`, the injected token (the real credential store is never read). */
function wiring() {
  return {
    adsToken: async () => token_,
    fetchImpl: ((url: never, init?: never) => {
      const stub = stubFetch((call) => handler(call));
      const answered = stub.fetchImpl(url, init).then((response) => {
        calls.push(...stub.calls.splice(0));
        return response;
      });
      const signal = (init as RequestInit | undefined)?.signal;
      if (!signal) return answered;
      // Like the real fetch: an aborted request rejects.
      return Promise.race([
        answered,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          )
        ),
      ]);
    }) as typeof fetch,
  };
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      out.push(
        stat.isDirectory()
          ? `${relative(dir, full)}/`
          : `${relative(dir, full)} ${readFileSync(full).toString("base64")}`
      );
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

const resultSchema = (id: string) => {
  const op = OPERATION_CATALOG.find((entry) => entry.id === id);
  if (!op) throw new Error(id);
  return op.result;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ads-search-"));
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(import.meta.dirname, "..", "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  calls = [];
  token_ = TOKEN;
  handler = healthy;
});
afterEach(async () => {
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const local = () => createLocalOperationRuntime(libraryPaths(dataDir), wiring());
const search = (params: Record<string, unknown>) =>
  runCatalogOperation(local(), "discovery.search_ads", params);

test("search_ads in this process: records and numFound, only GETs, token in the header only, nothing written", async () => {
  const before = listing(dataDir);
  const answer = await search({ query: 'author:"Hunt, E"', limit: 5, fields: "title,arxiv_id" });
  expect(answer).toEqual({
    ok: true,
    status: "ok",
    query: 'author:"Hunt, E"',
    numFound: 41,
    returned: 1,
    records: [{ bibcode: DOC.bibcode, title: "Open clusters", arxivId: "2001.00001" }],
  });
  expect(resultSchema("discovery.search_ads").safeParse(answer).success).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(calls[0]?.bodyText).toBeUndefined();
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(calls[0]?.url).not.toContain(TOKEN);
  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("rows")).toBe("5");
  expect(url.searchParams.get("fl")).toBe("bibcode,title,identifier");
  expect(JSON.stringify(answer)).not.toContain(TOKEN);
  expect(listing(dataDir)).toEqual(before);
});

test("search_ads defaults: ten rows and the compact field set; a blank query is refused without a request", async () => {
  await search({ query: "dark matter" });
  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("rows")).toBe("10");
  expect(url.searchParams.get("fl")).toBe("bibcode,title,author,year,pub,citation_count,doi");
  calls = [];
  expect(await search({ query: "   " })).toMatchObject({
    ok: false,
    status: "unsupported",
    reason: "bad_query",
  });
  expect(calls).toHaveLength(0);
});

test("search_ads failure kinds are told apart, carry no token, and write nothing", async () => {
  const before = listing(dataDir);
  const reasons: Record<string, unknown> = {};

  token_ = null;
  reasons.no_token = await search({ query: "x" });
  expect(calls).toHaveLength(0); // no token: no request
  token_ = TOKEN;

  handler = () => new Response(`BODY ${TOKEN}`, { status: 401 });
  reasons.unauthorized = await search({ query: "x" });
  handler = () => new Response("", { status: 429, headers: { "retry-after": "17" } });
  reasons.rate_limited = await search({ query: "x" });
  handler = () => new Response("", { status: 400 });
  reasons.bad_query = await search({ query: "x" });
  handler = () => new Response("", { status: 503 });
  reasons.server = await search({ query: "x" });
  handler = () => {
    throw new TypeError(`ECONNREFUSED ${TOKEN}`);
  };
  reasons.network = await search({ query: "x" });
  handler = () => new Response("not json", { status: 200 });
  reasons.invalid = await search({ query: "x" });

  const reasonOf = (name: string) => (reasons[name] as { reason: string }).reason;
  expect(["no_token", "unauthorized", "rate_limited", "bad_query"].map(reasonOf)).toEqual([
    "no_token",
    "unauthorized",
    "rate_limited",
    "bad_query",
  ]);
  expect([reasonOf("server"), reasonOf("network"), reasonOf("invalid")]).toEqual([
    "unreachable",
    "unreachable",
    "invalid_response",
  ]);
  expect(reasons.rate_limited).toMatchObject({ http: 429, retryAfter: "17", status: "error" });
  expect(reasons.unauthorized).toMatchObject({ http: 401, status: "error" });
  for (const answer of Object.values(reasons)) {
    expect(resultSchema("discovery.search_ads").safeParse(answer).success).toBe(true);
    expect(JSON.stringify(answer)).not.toMatch(/SYNTHETIC|BODY|ECONNREFUSED/);
  }
  expect(new Set(Object.values(reasons).map((a) => (a as { detail: string }).detail)).size).toBe(
    Object.keys(reasons).length - 1 // server and network share the "could not be reached" text
  );
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect(listing(dataDir)).toEqual(before);
});

test("search_ads: a host without the search says unsupported, and the token is read afresh at each use", async () => {
  const runtime = local();
  const bare = { ...runtime, library: { ...runtime.library, adsSearch: undefined } };
  expect(await runCatalogOperation(bare, "discovery.search_ads", { query: "x" })).toMatchObject({
    ok: false,
    status: "unsupported",
    reason: "unavailable",
  });
  token_ = null;
  expect(await runCatalogOperation(runtime, "discovery.search_ads", { query: "x" })).toMatchObject({
    reason: "no_token",
  });
  token_ = TOKEN; // saved in Settings in the meantime: the very next call uses it, no restart
  expect(await runCatalogOperation(runtime, "discovery.search_ads", { query: "x" })).toMatchObject({
    ok: true,
  });
});

test("search_ads on a running workbench answers exactly what the in-process run answers, with the same write-free behaviour", async () => {
  const token = newWorkbenchToken();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources(), makeAdsSearch: () => realAdsSearch(wiring()) },
    operationToken: token,
  });
  servers.push(srv);
  const port = await srv.ready();
  const before = listing(dataDir);
  const cases: Record<string, unknown>[] = [
    { query: "open clusters", limit: 3 },
    { query: "x", fields: "title,abstract" },
  ];
  for (const params of cases) {
    const viaRoute = await runOnWorkbench({ port, token }, { id: "discovery.search_ads", params });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body).toEqual(JSON.parse(JSON.stringify(await search(params))));
  }
  // The failures are answers on the route too (HTTP 200, ok:false), told apart the same way.
  token_ = null;
  const none = await runOnWorkbench(
    { port, token },
    { id: "discovery.search_ads", params: { query: "x" } }
  );
  expect(none.status).toBe(200);
  expect(none.body).toMatchObject({ ok: false, reason: "no_token", status: "error" });
  token_ = TOKEN;
  // A parameter the operation does not have is refused by the route before anything runs.
  const refused = await runOnWorkbench(
    { port, token },
    { id: "discovery.search_ads", params: { query: "x", token: "abc" } }
  );
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ ok: false, status: "unsupported" });
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect(listing(dataDir)).toEqual(before);
});

test("search_ads through the Copilot library tool: the same answer, failures as results, Stop is interrupted, extra parameters are refused", async () => {
  const buildTool = () =>
    createLibraryTool({
      library: {
        paths: libraryPaths(dataDir),
        libraryLock: new AsyncLock(),
        onChanged: () => {
          throw new Error("a read must not change the library");
        },
        readPayload: async () => {
          throw new Error("unused");
        },
        adsSearch: () => realAdsSearch(wiring()),
      },
      viewAction: async () => ({ ok: true }) as never,
      admitting: () => true,
    } as never);
  const run = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await buildTool().execute(
      "call-1",
      args as never,
      signal as never,
      undefined as never,
      undefined as never
    );
    const first = result.content[0];
    return {
      payload: JSON.parse(first && first.type === "text" ? first.text : "{}") as Record<
        string,
        unknown
      >,
      details: result.details as { status: string; action: string },
    };
  };
  const before = listing(dataDir);
  const viaTool = await run({
    action: "search_ads",
    query: 'author:"Hunt, E"',
    limit: 5,
    fields: "title,arxiv_id",
  });
  expect(viaTool.payload).toEqual(
    await search({ query: 'author:"Hunt, E"', limit: 5, fields: "title,arxiv_id" })
  );
  expect(viaTool.details).toMatchObject({ action: "search_ads", status: "ok" });

  token_ = null;
  const none = await run({ action: "search_ads", query: "x" });
  expect(none.payload).toMatchObject({ ok: false, reason: "no_token" });
  expect(none.details.status).toBe("error");
  token_ = TOKEN;

  for (const bad of [
    { action: "search_ads" },
    { action: "search_ads", query: "x", limit: 51 },
    { action: "search_ads", query: "x", fields: "password" },
    { action: "search_ads", query: "x", token: "abc" },
    { action: "search_ads", query: "x", libraryId: "L" },
  ]) {
    const refused = await run(bad);
    expect(refused.payload, JSON.stringify(bad)).toMatchObject({
      ok: false,
      status: "unsupported",
    });
    expect(refused.details.status).toBe("unsupported");
  }

  const controller = new AbortController();
  handler = (_call) =>
    new Promise<Response>(() => {
      /* never answers */
    });
  const pending = run({ action: "search_ads", query: "x" }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const stopped = await pending;
  expect(stopped.payload).toMatchObject({ ok: false, status: "interrupted", reason: "stopped" });
  expect(stopped.details.status).toBe("interrupted");

  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect(listing(dataDir)).toEqual(before);
});

// ---- explore ------------------------------------------------------------- //

const SEED = "2023A&A...673A.114H";
const rec = (bibcode: string, references: string[] = []) => ({
  bibcode,
  title: `Paper ${bibcode}`,
  authors: ["Doe, J."],
  year: 2020,
  venue: "A&A",
  abstract: "An abstract.",
  citation_count: 7,
  doi: null,
  arxiv_id: null,
  references,
});
const discovery: AdsDiscoverySource = {
  getByBibcode: async (b) => (b === SEED ? rec(SEED, ["R1"]) : null),
  similar: async () => [rec("R1", [SEED])],
  useful: async () => [],
};

test("explore returns the page's graph as data, answers not_found for an unknown seed and refuses a non-bibcode", async () => {
  const before = readFileSync(join(dataDir, "library", "library.json"));
  const runtime = local();
  runtime.library.discoverySource = () => discovery;
  const graph = await runCatalogOperation(runtime, "discovery.explore", { bibcode: SEED });
  expect(graph).toMatchObject({ ok: true, status: "ok", graph: { provider: "ads", seed: SEED } });
  expect(resultSchema("discovery.explore").safeParse(graph).success).toBe(true);
  expect(
    await runCatalogOperation(runtime, "discovery.explore", { bibcode: "2000X...1....Z" })
  ).toMatchObject({ ok: false, status: "not_found", reason: "not_found" });
  expect(await runCatalogOperation(runtime, "discovery.explore", { bibcode: 'a"b' })).toMatchObject(
    { ok: false, status: "unsupported" }
  );
  expect(readFileSync(join(dataDir, "library", "library.json"))).toEqual(before);
  // without a source the host says so
  const bare = createLocalOperationRuntime(libraryPaths(dataDir), wiring());
  bare.library.discoverySource = undefined as never;
  expect(await runCatalogOperation(bare, "discovery.explore", { bibcode: SEED })).toMatchObject({
    reason: "unavailable",
  });
});
