// Offline tests for ads.mjs: `node --test` from this directory. No network, no real token.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildQuery, parseArgs, quoteBibcode, readToken, run, toRow, UsageError } from "./ads.mjs";

const TOKEN = "test-token-not-real";

function homeWithToken(token = TOKEN) {
  const home = mkdtempSync(join(tmpdir(), "ads-test-"));
  if (token !== null) {
    mkdirSync(join(home, ".ads"));
    writeFileSync(join(home, ".ads", "dev_key"), `${token}\n`);
  }
  return home;
}

function respond(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

async function runWith(argv, fetchImpl, home = homeWithToken()) {
  let stdout = "";
  let stderr = "";
  const calls = [];
  const code = await run(argv, {
    home,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return fetchImpl(url, init);
    },
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr, calls };
}

test("parseArgs applies per-command default rows", () => {
  assert.equal(parseArgs(["search", "abs:x"]).rows, 20);
  assert.equal(parseArgs(["similar", "2020A&A...1A"]).rows, 18);
  assert.equal(parseArgs(["useful", "2020A&A...1A"]).rows, 6);
});

test("parseArgs accepts --rows in both spellings, anywhere", () => {
  assert.equal(parseArgs(["search", "--rows", "5", "abs:x"]).rows, 5);
  assert.equal(parseArgs(["similar", "A", "B", "--rows=50"]).rows, 50);
  assert.deepEqual(parseArgs(["similar", "A", "B", "--rows=50"]).operands, ["A", "B"]);
});

test("parseArgs rejects bad invocations", () => {
  for (const argv of [
    [],
    ["explore", "x"],
    ["search"],
    ["search", "a", "b"],
    ["search", "  "],
    ["similar"],
    ["search", "x", "--rows", "0"],
    ["search", "x", "--rows", "51"],
    ["search", "x", "--rows", "ten"],
    ["search", "x", "--rows"],
    ["search", "x", "--sort", "date desc"],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
  }
});

test("search passes the query through untouched", () => {
  const q = 'author:"Kroupa, P" abs:"tidal tails"';
  assert.equal(buildQuery("search", [q]), q);
});

test("similar/useful quote each bibcode and OR them", () => {
  assert.equal(buildQuery("similar", ["2020A&A...1A"]), 'similar(bibcode:"2020A&A...1A")');
  assert.equal(buildQuery("useful", ["A", "B"]), 'useful(bibcode:"A" OR bibcode:"B")');
});

test("a bibcode cannot break out of its quotes", () => {
  assert.equal(quoteBibcode('x") OR abs:("y'), '"x\\") OR abs:(\\"y"');
  assert.equal(quoteBibcode("a\\b"), '"a\\\\b"');
  assert.throws(() => quoteBibcode(""), UsageError);
  assert.throws(() => quoteBibcode("a\nb"), UsageError);
  assert.throws(() => quoteBibcode("x".repeat(65)), UsageError);
});

test("readToken reads only ~/.ads/dev_key", () => {
  assert.equal(readToken(homeWithToken()), TOKEN);
  assert.throws(() => readToken(homeWithToken(null)), /no ADS token/);
  assert.throws(() => readToken(homeWithToken("  ")), /no ADS token/);
  process.env.ADS_DEV_KEY = "from-env";
  try {
    assert.throws(() => readToken(homeWithToken(null)), /no ADS token/);
  } finally {
    delete process.env.ADS_DEV_KEY;
  }
});

test("toRow normalizes an ADS doc and caps the author list", () => {
  const author = Array.from({ length: 25 }, (_, i) => `Author, ${i}`);
  const row = toRow(
    { bibcode: "B", title: ["T"], author, year: "2021", pub: "A&A", citation_count: 3, score: 1.5 },
    4
  );
  assert.deepEqual(Object.keys(row), [
    "rank",
    "bibcode",
    "title",
    "authors",
    "author_count",
    "year",
    "pub",
    "citation_count",
    "doi",
    "score",
    "abstract",
  ]);
  assert.equal(row.rank, 4);
  assert.equal(row.authors.length, 10);
  assert.equal(row.author_count, 25);
  assert.equal(row.year, 2021);
  assert.equal(row.doi, null);
  assert.equal(row.abstract, null);
});

test("run sends one authorized request and prints ranked JSONL", async () => {
  const docs = [
    { bibcode: "B1", title: ["One"], doi: ["10.1/x"] },
    { title: ["no bibcode, skipped"] },
    { bibcode: "B2", title: ["Two"] },
  ];
  const r = await runWith(["similar", "S1", "S2", "--rows", "7"], () =>
    respond(200, { response: { docs } })
  );
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  const rows = r.stdout.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(
    rows.map((x) => [x.rank, x.bibcode]),
    [
      [1, "B1"],
      [2, "B2"],
    ]
  );
  assert.equal(rows[0].doi, "10.1/x");
  assert.equal(r.calls.length, 1);
  const { url, init } = r.calls[0];
  assert.equal(url.searchParams.get("q"), 'similar(bibcode:"S1" OR bibcode:"S2")');
  assert.equal(url.searchParams.get("rows"), "7");
  assert.equal(url.searchParams.get("sort"), "score desc");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
});

test("run reports an empty result on stderr with a clean stdout", async () => {
  const r = await runWith(["search", "abs:nothing"], () => respond(200, { response: { docs: [] } }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^note: ADS returned no papers/);
});

test("run fails without a token before any request", async () => {
  const r = await runWith(["search", "abs:x"], () => respond(200, {}), homeWithToken(null));
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /^error: no ADS token/);
});

test("run classifies provider failures and never leaks the token", async () => {
  const cases = [
    [() => respond(401, "nope"), /rejected the token/],
    [() => respond(429, "", { "retry-after": "60" }), /rate limit exceeded \(retry after 60s\)/],
    [
      () => respond(400, { responseHeader: { params: {} }, error: { msg: "syntax error at 5" } }),
      /ADS HTTP 400: syntax error at 5\n$/,
    ],
    [
      () => {
        throw new TypeError("fetch failed", {
          cause: new AggregateError([{ code: "ETIMEDOUT" }, { code: "ENETUNREACH" }], ""),
        });
      },
      /cannot reach ADS \(fetch failed: ETIMEDOUT, ENETUNREACH\)/,
    ],
    [() => respond(502, "bad gateway"), /ADS HTTP 502/],
    [() => respond(200, "<html>"), /unexpected response/],
    [() => respond(200, { response: {} }), /unexpected response/],
    [
      () => {
        throw new TypeError("fetch failed");
      },
      /cannot reach ADS/,
    ],
  ];
  for (const [impl, pattern] of cases) {
    const r = await runWith(["search", "abs:x"], impl);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, pattern);
    assert.ok(!r.stderr.includes(TOKEN));
  }
});

test("run exits 2 with usage on a bad invocation", async () => {
  const r = await runWith(["search"], () => respond(200, {}));
  assert.equal(r.code, 2);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /^error: search takes exactly one query string/);
  assert.match(r.stderr, /usage:/);
});
