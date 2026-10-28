/**
 * `library` actions `list_ads_libraries` / `read_ads_library` (project intake ticket 02, contracts "项目迁入" / "ADS
 * libraries"): the user's ADS libraries, read-only. The tool runs over the real ADS libraries client and the real
 * `realAdsLibraries` composition, with an offline biblib stub as `fetch` and an injected credential store (the real
 * keychain is never read); the data folder is a temporary directory and must come out of every call byte-identical.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import { type AdsLibrariesSource, readAdsToken } from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import { jsonResponse, type StubCall, stubFetch } from "../../infra/tests/helpers.js";
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { realAdsLibraries } from "../src/deps.js";
import { AsyncLock } from "../src/lock.js";

const TOKEN = "SYNTHETIC-ADS-TOKEN";
const LIB = {
  id: "lib_1-A",
  name: "Thesis",
  description: "all of it",
  num_documents: 230,
  permission: "owner",
};
const bib = (n: number) => `2021MNRAS.${String(n).padStart(4, "0")}....B`;

let root: string;
let dataDir: string;
let calls: StubCall[];
let token: string | null;
let handler: (call: StubCall) => Response | Promise<Response>;
let requestedTools: AdsLibrariesSource | undefined;

const store = {
  get: async () =>
    token === null
      ? ({ status: "not-found" } as const)
      : ({ status: "ok", password: token } as never),
};

function healthy(call: StubCall): Response {
  const url = new URL(call.url);
  if (url.pathname === "/v1/biblib/libraries") return jsonResponse({ count: 1, libraries: [LIB] });
  if (url.pathname === `/v1/biblib/libraries/${LIB.id}`) {
    const start = Number(url.searchParams.get("start"));
    const rows = Math.min(Number(url.searchParams.get("rows")), 100);
    return jsonResponse({
      documents: Array.from({ length: Math.max(0, Math.min(230 - start, rows)) }, (_, i) =>
        bib(start + i)
      ),
      metadata: LIB,
    });
  }
  return new Response("", { status: 410 });
}

function buildTool(withAds = true) {
  return createLibraryTool({
    library: {
      paths: libraryPaths(dataDir),
      libraryLock: new AsyncLock(),
      onChanged: () => {
        throw new Error("a read must not change the library");
      },
      readPayload: async () => {
        throw new Error("unused");
      },
      ...(withAds
        ? {
            adsLibraries: async () => {
              const stub = stubFetch((call) => handler(call));
              const source = await realAdsLibraries({
                adsToken: () => readAdsToken(store as never),
                fetchImpl: ((url: never, init?: never) => {
                  return stub.fetchImpl(url, init).then((r) => {
                    calls.push(...stub.calls.splice(0));
                    return r;
                  });
                }) as typeof fetch,
              });
              requestedTools = source;
              return source;
            },
          }
        : {}),
    },
    viewAction: async () => ({ ok: true }) as never,
    admitting: () => true,
  } as never);
}

type Result = Record<string, unknown> & { ok: boolean; status: string; reason?: string };
async function run(
  tool: ReturnType<typeof buildTool>,
  args: Record<string, unknown>,
  signal?: AbortSignal
) {
  const result = await tool.execute(
    "call-1",
    args as never,
    signal as never,
    undefined as never,
    undefined as never
  );
  const first = result.content[0];
  return {
    payload: JSON.parse(first && first.type === "text" ? first.text : "{}") as Result,
    details: result.details,
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
          : `${relative(dir, full)} ${readFileSync(full).length}`
      );
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ads-libs-"));
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  writeFileSync(join(dataDir, "library", "library.json"), '{"version":1,"works":[]}');
  calls = [];
  token = TOKEN;
  handler = healthy;
  requestedTools = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("list_ads_libraries returns each library's id, name and count; only GETs, token in the header, nothing written", async () => {
  const before = listing(dataDir);
  const { payload, details } = await run(buildTool(), { action: "list_ads_libraries" });
  expect(payload).toEqual({
    ok: true,
    status: "ok",
    total: 1,
    libraries: [
      {
        id: LIB.id,
        name: "Thesis",
        numDocuments: 230,
        description: "all of it",
        permission: "owner",
      },
    ],
  });
  expect(details.status).toBe("ok");
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(JSON.stringify(payload)).not.toContain(TOKEN);
  expect(listing(dataDir)).toEqual(before);
});

test("read_ads_library answers one window of up to 200 at a time, each fetched from ADS by start", async () => {
  const tool = buildTool();
  const first = await run(tool, { action: "read_ads_library", libraryId: LIB.id });
  expect(first.payload.ok).toBe(true);
  expect(first.payload.bibcodes).toHaveLength(200);
  expect(first.payload).toMatchObject({
    total: 230,
    offset: 0,
    nextOffset: 200,
    library: { id: LIB.id, name: "Thesis", numDocuments: 230 },
  });
  const second = await run(tool, { action: "read_ads_library", libraryId: LIB.id, offset: 200 });
  expect(second.payload.bibcodes).toEqual(Array.from({ length: 30 }, (_, i) => bib(200 + i)));
  expect(second.payload.nextOffset).toBeUndefined();
  expect(calls.every((c) => c.method === "GET" && c.url.includes("/v1/biblib/libraries/"))).toBe(
    true
  );
  const small = await run(tool, { action: "read_ads_library", libraryId: LIB.id, limit: 5 });
  expect(small.payload.bibcodes).toHaveLength(5);
  expect(small.payload.nextOffset).toBe(5);
  // 2 requests for the first window, 1 for the second, 1 for the small one: nothing re-reads the library.
  expect(calls.map((c) => new URL(c.url).searchParams.get("start"))).toEqual([
    "0",
    "100",
    "200",
    "0",
  ]);
});

test("the request count of one call does not grow with the library", async () => {
  handler = (call) => {
    const url = new URL(call.url);
    const start = Number(url.searchParams.get("start"));
    const rows = Math.min(Number(url.searchParams.get("rows")), 100);
    return jsonResponse({
      documents: Array.from({ length: Math.min(30_000 - start, rows) }, (_, i) => bib(start + i)),
      metadata: { ...LIB, num_documents: 30_000 },
    });
  };
  const { payload } = await run(buildTool(), {
    action: "read_ads_library",
    libraryId: LIB.id,
    offset: 12_000,
  });
  expect(payload).toMatchObject({ ok: true, total: 30_000, offset: 12_000, nextOffset: 12_200 });
  expect(payload.bibcodes).toHaveLength(200);
  expect(calls).toHaveLength(2);
});

test("an offset past the end is an ok empty window with the total and no nextOffset", async () => {
  handler = (call) => {
    const url = new URL(call.url);
    const start = Number(url.searchParams.get("start"));
    const rows = Math.min(Number(url.searchParams.get("rows")), 100);
    return jsonResponse({
      documents: Array.from({ length: Math.max(0, Math.min(230 - start, rows)) }, (_, i) =>
        bib(start + i)
      ),
      metadata: { ...LIB, num_documents: 230 },
    });
  };
  for (const offset of [230, 231, 5000]) {
    const { payload } = await run(buildTool(), {
      action: "read_ads_library",
      libraryId: LIB.id,
      offset,
    });
    expect(payload).toMatchObject({ ok: true, total: 230, offset, bibcodes: [] });
    expect(payload.nextOffset).toBeUndefined();
  }
});

test("an answer that contradicts itself is invalid_response with no bibcodes", async () => {
  handler = () =>
    jsonResponse({
      documents: Array.from({ length: 100 }, (_, i) => bib(i)),
      metadata: { ...LIB, num_documents: 230 },
    }); // ignores start: the second request repeats the first page
  const { payload, details } = await run(buildTool(), {
    action: "read_ads_library",
    libraryId: LIB.id,
  });
  expect(payload).toMatchObject({ ok: false, status: "error", reason: "invalid_response" });
  expect(payload.bibcodes).toBeUndefined();
  expect(details.status).toBe("error");
});

test("Stop during a read is interrupted (nothing read, nothing changed), not unknown", async () => {
  const before = listing(dataDir);
  for (const args of [
    { action: "read_ads_library", libraryId: LIB.id },
    { action: "list_ads_libraries" },
  ]) {
    const c = new AbortController();
    handler = () => {
      c.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const { payload, details } = await run(buildTool(), args, c.signal);
    expect(payload).toMatchObject({ ok: false, status: "interrupted", reason: "stopped" });
    expect(String(payload.detail)).toContain("only reads");
    expect(JSON.stringify(payload)).not.toContain("read the work again");
    expect(details.status).toBe("interrupted");
  }
  expect(listing(dataDir)).toEqual(before);
});

test("an empty library is ok with no bibcodes", async () => {
  handler = () => jsonResponse({ documents: [], metadata: { ...LIB, num_documents: 0 } });
  const { payload } = await run(buildTool(), { action: "read_ads_library", libraryId: LIB.id });
  expect(payload).toMatchObject({ ok: true, status: "ok", total: 0, bibcodes: [] });
});

test("no saved token: no_token, no request; a token saved afterwards applies at once (read at each use)", async () => {
  token = null;
  const tool = buildTool();
  const none = await run(tool, { action: "list_ads_libraries" });
  expect(none.payload).toMatchObject({ ok: false, status: "error", reason: "no_token" });
  expect(calls).toHaveLength(0);
  token = TOKEN;
  expect((await run(tool, { action: "list_ads_libraries" })).payload.ok).toBe(true);
});

test("each failure has its own reason and none carries the token", async () => {
  const cases: [Response | Error, string, string][] = [
    [new Response(`bad ${TOKEN}`, { status: 401 }), "unauthorized", "error"],
    [new Response("", { status: 403 }), "forbidden", "error"],
    [new Response("", { status: 429, headers: { "retry-after": "12" } }), "rate_limited", "error"],
    [new Response("", { status: 503 }), "unreachable", "error"],
    [new TypeError(`net ${TOKEN}`), "unreachable", "error"],
    [new Response("<html>", { status: 200 }), "invalid_response", "error"],
  ];
  const tool = buildTool();
  for (const [answer, reason, status] of cases) {
    handler = () => {
      if (answer instanceof Error) throw answer;
      return answer.clone();
    };
    for (const args of [
      { action: "list_ads_libraries" },
      { action: "read_ads_library", libraryId: LIB.id },
    ]) {
      const { payload, details } = await run(tool, args);
      expect(payload).toMatchObject({ ok: false, status, reason });
      expect(JSON.stringify(payload)).not.toContain(TOKEN);
      expect(details.status).toBe(status);
    }
  }
  handler = () => new Response("", { status: 429, headers: { "retry-after": "12" } });
  expect((await run(tool, { action: "list_ads_libraries" })).payload.retryAfter).toBe("12");
  handler = () => new Response("", { status: 410 });
  expect(
    (await run(tool, { action: "read_ads_library", libraryId: "gone" })).payload
  ).toMatchObject({
    ok: false,
    status: "not_found",
    reason: "not_found",
  });
});

test("a request that does not answer in time is reported as timeout", async () => {
  handler = () => {
    throw Object.assign(new Error("slow"), { name: "TimeoutError" });
  };
  const { payload } = await run(buildTool(), { action: "list_ads_libraries" });
  expect(payload).toMatchObject({ ok: false, reason: "timeout" });
});

test("a host without the source says unsupported; bad parameters are refused before any request", async () => {
  const none = await run(buildTool(false), { action: "list_ads_libraries" });
  expect(none.payload).toMatchObject({ ok: false, status: "unsupported", reason: "unavailable" });
  const tool = buildTool();
  for (const args of [
    { action: "read_ads_library" },
    { action: "read_ads_library", libraryId: "../../v1/search/query" },
    { action: "read_ads_library", libraryId: LIB.id, token: "x" },
    { action: "list_ads_libraries", libraryId: LIB.id },
  ]) {
    const { payload } = await run(tool, args);
    expect(payload).toMatchObject({ ok: false, status: "unsupported" });
  }
  expect(calls).toHaveLength(0);
});

test("whatever happened, the data folder is exactly as it was and no non-GET went to biblib", async () => {
  const before = listing(dataDir);
  const tool = buildTool();
  await run(tool, { action: "list_ads_libraries" });
  await run(tool, { action: "read_ads_library", libraryId: LIB.id });
  handler = () => new Response("", { status: 429 });
  await run(tool, { action: "read_ads_library", libraryId: LIB.id });
  expect(listing(dataDir)).toEqual(before);
  expect(calls.length).toBeGreaterThan(0);
  expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  expect(calls.every((c) => c.bodyText === undefined)).toBe(true);
  expect(requestedTools).toBeDefined();
});
