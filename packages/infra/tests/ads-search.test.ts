/**
 * ADS search client (release-0.2 ticket 09) against an offline stub of the ADS search API. No call leaves the process;
 * every request is recorded so the tests can assert that only GETs without a body were sent, that the token travels in
 * the Authorization header alone, and that each failure kind is told apart without leaking the token or a body.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ADS_SEARCH_ABSTRACT_MAX,
  ADS_SEARCH_AUTHORS_MAX,
  ADS_SEARCH_DEFAULT_FIELDS,
  ADS_SEARCH_MAX_ROWS,
  AdsSearchClient,
} from "../src/sources/ads-search.js";
import { jsonResponse, type StubCall, stubFetch } from "./helpers.js";

const TOKEN = "TEST-TOKEN-NOT-REAL";

const DOC = {
  bibcode: "2020ApJ...900..1H",
  title: ["A paper title"],
  author: ["Hunt, E. L.", "Reffert, S."],
  year: "2020",
  pub: "The Astrophysical Journal",
  citation_count: 12,
  doi: ["10.3847/x"],
  identifier: ["2020ApJ...900..1H", "arXiv:2001.01234"],
  abstract: "Abstract text.",
};

function ok(docs: unknown[] = [DOC], numFound = 97) {
  return (_call: StubCall) => jsonResponse({ response: { numFound, start: 0, docs } });
}

const request = (over: Record<string, unknown> = {}) => ({
  query: 'author:"Hunt, E" year:2020',
  rows: 10,
  fields: ADS_SEARCH_DEFAULT_FIELDS,
  ...over,
});

describe("AdsSearchClient", () => {
  test("one GET with the query, the requested fields and the row count; the token is only in the header", async () => {
    const { fetchImpl, calls } = stubFetch(ok());
    const got = await new AdsSearchClient({ token: TOKEN, fetchImpl }).search(request());
    expect(got).toEqual({
      ok: true,
      numFound: 97,
      records: [
        {
          bibcode: DOC.bibcode,
          title: "A paper title",
          authors: ["Hunt, E. L.", "Reffert, S."],
          authorCount: 2,
          year: 2020,
          venue: "The Astrophysical Journal",
          citationCount: 12,
          doi: "10.3847/x",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as StubCall;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("https://api.adsabs.harvard.edu/v1/search/query");
    expect(url.searchParams.get("q")).toBe('author:"Hunt, E" year:2020');
    expect(url.searchParams.get("fl")).toBe("bibcode,title,author,year,pub,citation_count,doi");
    expect(url.searchParams.get("rows")).toBe("10");
    expect(call.method).toBe("GET");
    expect(call.bodyText).toBeUndefined();
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    expect(JSON.stringify(got)).not.toContain(TOKEN);
  });

  test("asks only for what was requested: arxiv_id reads the identifier list, abstract is cut, authors are capped", async () => {
    const long = "x".repeat(ADS_SEARCH_ABSTRACT_MAX + 50);
    const authors = Array.from({ length: 40 }, (_, i) => `Author${i}, A.`);
    const { fetchImpl, calls } = stubFetch(ok([{ ...DOC, abstract: long, author: authors }]));
    const got = await new AdsSearchClient({ token: TOKEN, fetchImpl }).search(
      request({ fields: ["arxiv_id", "abstract", "author"] })
    );
    expect(new URL((calls[0] as StubCall).url).searchParams.get("fl")).toBe(
      "bibcode,identifier,abstract,author"
    );
    expect(got).toMatchObject({
      ok: true,
      records: [
        {
          bibcode: DOC.bibcode,
          arxivId: "2001.01234",
          abstract: "x".repeat(ADS_SEARCH_ABSTRACT_MAX),
          abstractTruncated: true,
          authorCount: 40,
        },
      ],
    });
    const record = got.ok ? got.records[0] : undefined;
    expect(record?.authors).toHaveLength(ADS_SEARCH_AUTHORS_MAX);
    expect(record).not.toHaveProperty("title");
  });

  test("rows are clamped to 1..50 and an empty answer is an ok empty list", async () => {
    const { fetchImpl, calls } = stubFetch(ok([], 0));
    const client = new AdsSearchClient({ token: TOKEN, fetchImpl });
    expect(await client.search(request({ rows: 5000 }))).toEqual({
      ok: true,
      numFound: 0,
      records: [],
    });
    await client.search(request({ rows: 0 }));
    expect(calls.map((c) => new URL(c.url).searchParams.get("rows"))).toEqual([
      String(ADS_SEARCH_MAX_ROWS),
      "1",
    ]);
  });

  test("no token: no request at all", async () => {
    const { fetchImpl, calls } = stubFetch(ok());
    for (const token of [null, undefined, ""]) {
      expect(await new AdsSearchClient({ token, fetchImpl }).search(request())).toEqual({
        ok: false,
        reason: "no_token",
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("each failure kind is its own reason, with the status or Retry-After, and no body is kept", async () => {
    const answer = async (status: number, headers: Record<string, string> = {}) => {
      const { fetchImpl } = stubFetch(
        () => new Response(`SECRET-BODY ${TOKEN}`, { status, headers })
      );
      return new AdsSearchClient({ token: TOKEN, fetchImpl }).search(request());
    };
    expect(await answer(401)).toEqual({ ok: false, reason: "unauthorized", http: 401 });
    expect(await answer(400)).toEqual({ ok: false, reason: "bad_query", http: 400 });
    expect(await answer(429, { "retry-after": "30" })).toEqual({
      ok: false,
      reason: "rate_limited",
      http: 429,
      retryAfter: "30",
    });
    expect(await answer(500)).toEqual({ ok: false, reason: "unreachable", http: 500 });
    expect(await answer(403)).toEqual({ ok: false, reason: "unreachable", http: 403 });
    for (const status of [400, 401, 429, 500])
      expect(JSON.stringify(await answer(status))).not.toMatch(/SECRET|TEST-TOKEN/);
  });

  test("network failure, timeout and unintelligible answers are told apart", async () => {
    const boom = stubFetch(() => {
      throw new TypeError(`connect ECONNREFUSED while sending ${TOKEN}`);
    });
    const net = await new AdsSearchClient({ token: TOKEN, fetchImpl: boom.fetchImpl }).search(
      request()
    );
    expect(net).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(net)).not.toContain(TOKEN);

    const slow = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("t"), { name: "TimeoutError" }))
        );
      })) as typeof fetch;
    expect(
      await new AdsSearchClient({ token: TOKEN, fetchImpl: slow, requestTimeoutMs: 20 }).search(
        request()
      )
    ).toEqual({ ok: false, reason: "timeout" });

    for (const body of ["not json", "{}", '{"response":{"numFound":"x","docs":[]}}']) {
      const { fetchImpl } = stubFetch(() => new Response(body, { status: 200 }));
      expect(await new AdsSearchClient({ token: TOKEN, fetchImpl }).search(request())).toEqual({
        ok: false,
        reason: "invalid_response",
      });
    }
    const noBibcode = stubFetch(ok([{ title: ["x"] }]));
    expect(
      await new AdsSearchClient({ token: TOKEN, fetchImpl: noBibcode.fetchImpl }).search(request())
    ).toEqual({ ok: false, reason: "invalid_response" });
  });

  test("the caller's own cancel is rethrown, not reported as an ADS failure", async () => {
    const controller = new AbortController();
    const hang = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("a"), { name: "AbortError" }))
        );
      })) as typeof fetch;
    const pending = new AdsSearchClient({ token: TOKEN, fetchImpl: hang }).search(
      request(),
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("the source can only read: GET is its one method and it has no write path", () => {
    const source = readFileSync(new URL("../src/sources/ads-search.ts", import.meta.url), "utf8");
    expect(source.match(/method:\s*"[A-Z]+"/g)).toEqual(['method: "GET"']);
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b\s*"/);
    expect(source).not.toMatch(/writeFile|mkdirSync|appendFile|body:/);
  });
});
