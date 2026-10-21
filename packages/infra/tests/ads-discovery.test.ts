/**
 * Stage 14 ADS discovery client — offline against stubbed fetch. Covers query
 * construction/escaping, normalization, the dedicated 24h TTL cache namespace,
 * typed provider errors, and abort semantics. No call ever leaves the process.
 */

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AdsDiscoveryClient,
  AdsDiscoveryError,
  normalizeDiscoveryDoc,
  quoteBibcode,
  seedQuery,
  similarQuery,
  usefulQuery,
} from "../src/sources/ads-discovery.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const SEED = "2023A&A...673A.114H";

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "ads-disc-"));
}

function doc(bibcode: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bibcode,
    title: [`Paper ${bibcode}`],
    author: ["Hunt, E. L.", "Reffert, S."],
    year: "2023",
    pub: "A&A",
    abstract: "An abstract.",
    citation_count: 42,
    doi: ["10.1051/0004-6361/202346285"],
    identifier: ["arXiv:2306.12345v2", "10.1051/0004-6361/202346285", bibcode],
    reference: ["2019A&A...621L...2R"],
    ...over,
  };
}

function adsResponse(docs: Array<Record<string, unknown>>) {
  return jsonResponse({ response: { docs } });
}

function client(over: Record<string, unknown> = {}) {
  const fetchStub = stubFetch(() => adsResponse([doc(SEED)]));
  const c = new AdsDiscoveryClient({
    cacheDir: tmpCache(),
    token: "TEST-TOKEN",
    fetchImpl: fetchStub.fetchImpl,
    ...over,
  });
  return { client: c, calls: fetchStub.calls, fetchImpl: fetchStub.fetchImpl };
}

// --------------------------------------------------------------------------- //
// Query construction & escaping
// --------------------------------------------------------------------------- //

describe("query construction", () => {
  test("seed: exact bibcode query, rows 1, full field list incl. reference/identifier", async () => {
    const { client: c, calls } = client();
    await c.getByBibcode(SEED);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.adsabs.harvard.edu/v1/search/query");
    expect(url.searchParams.get("q")).toBe(`bibcode:"${SEED}"`);
    expect(url.searchParams.get("rows")).toBe("1");
    const fl = url.searchParams.get("fl") ?? "";
    for (const f of [
      "bibcode",
      "title",
      "author",
      "abstract",
      "reference",
      "identifier",
      "doi",
      "citation_count",
    ]) {
      expect(fl).toContain(f);
    }
    expect(calls[0]!.headers.Authorization).toBe("Bearer TEST-TOKEN");
  });

  test("similar: operator query with rows=limit and score ordering", async () => {
    const { client: c, calls } = client();
    await c.similar(SEED, 18);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("q")).toBe(`similar(bibcode:"${SEED}")`);
    expect(url.searchParams.get("rows")).toBe("18");
    expect(url.searchParams.get("sort")).toBe("score desc");
  });

  test("useful: explicit OR of individually quoted related bibcodes", async () => {
    const { client: c, calls } = client();
    await c.useful(["2021A&A...646A.104H", "2023A&A...673A.114H"], 6);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("q")).toBe(
      'useful(bibcode:"2021A&A...646A.104H" OR bibcode:"2023A&A...673A.114H")'
    );
    expect(url.searchParams.get("rows")).toBe("6");
  });

  test("escaping: quotes and backslashes inside bibcodes cannot break out", () => {
    expect(quoteBibcode("2023A&A...673A.114H")).toBe('"2023A&A...673A.114H"');
    expect(quoteBibcode('evil" OR foo:bar')).toBe('"evil\\" OR foo:bar"');
    expect(quoteBibcode("back\\slash")).toBe('"back\\\\slash"');
    expect(seedQuery('x" OR title:"junk')).toBe('bibcode:"x\\" OR title:\\"junk"');
    expect(similarQuery(SEED)).toBe('similar(bibcode:"2023A&A...673A.114H")');
    expect(usefulQuery(["a", "b"])).toBe('useful(bibcode:"a" OR bibcode:"b")');
  });
});

// --------------------------------------------------------------------------- //
// Normalization
// --------------------------------------------------------------------------- //

describe("normalizeDiscoveryDoc", () => {
  test("display-preserving authors, DOI/arXiv extraction, int year/count", () => {
    const r = normalizeDiscoveryDoc(doc(SEED));
    expect(r).toEqual({
      bibcode: SEED,
      title: `Paper ${SEED}`,
      authors: ["Hunt, E. L.", "Reffert, S."], // NOT reduced to family names
      year: 2023,
      venue: "A&A",
      abstract: "An abstract.",
      citation_count: 42,
      doi: "10.1051/0004-6361/202346285",
      arxiv_id: "2306.12345", // version stripped
      references: ["2019A&A...621L...2R"],
    });
  });

  test("missing optional fields → nulls/empties", () => {
    const r = normalizeDiscoveryDoc({ bibcode: SEED });
    expect(r).toMatchObject({
      bibcode: SEED,
      title: "",
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      citation_count: null,
      doi: null,
      arxiv_id: null,
      references: [],
    });
  });

  test("no usable bibcode → null (caller skips the malformed result)", () => {
    expect(normalizeDiscoveryDoc({ title: ["x"] })).toBeNull();
    expect(normalizeDiscoveryDoc({ bibcode: "  " })).toBeNull();
  });

  test("similar skips malformed individual results but keeps valid ones", async () => {
    const { client: c } = client({
      fetchImpl: stubFetch(() => adsResponse([doc("A"), { title: ["no bibcode"] }, doc("B")]))
        .fetchImpl,
    });
    const out = await c.similar(SEED, 18);
    expect(out.map((r) => r.bibcode)).toEqual(["A", "B"]);
  });

  test("malformed seed result is a provider failure, not a miss", async () => {
    const { client: c } = client({
      fetchImpl: stubFetch(() => adsResponse([{ title: ["no bibcode"] }])).fetchImpl,
    });
    await expect(c.getByBibcode(SEED)).rejects.toMatchObject({
      name: "AdsDiscoveryError",
      kind: "invalid-response",
    });
  });

  test("seed miss (empty docs) → null", async () => {
    const { client: c } = client({
      fetchImpl: stubFetch(() => adsResponse([])).fetchImpl,
    });
    expect(await c.getByBibcode(SEED)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// TTL cache
// --------------------------------------------------------------------------- //

describe("ads-discovery TTL cache", () => {
  test("hit inside TTL: second identical call does no network", async () => {
    const stub = stubFetch(() => adsResponse([doc(SEED)]));
    const dir = tmpCache();
    const c = new AdsDiscoveryClient({ cacheDir: dir, token: "T", fetchImpl: stub.fetchImpl });
    await c.getByBibcode(SEED);
    await c.getByBibcode(SEED);
    expect(stub.calls).toHaveLength(1);
  });

  test("miss after TTL: refetches", async () => {
    let t = 1_000_000;
    const stub = stubFetch(() => adsResponse([doc(SEED)]));
    const c = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stub.fetchImpl,
      ttlMs: 24 * 3600 * 1000,
      now: () => t,
    });
    await c.getByBibcode(SEED);
    t += 24 * 3600 * 1000 + 1; // just past the TTL
    await c.getByBibcode(SEED);
    expect(stub.calls).toHaveLength(2);
  });

  test("key changes with query/limit/field/sort inputs", async () => {
    const stub = stubFetch(() => adsResponse([]));
    const dir = tmpCache();
    const c = new AdsDiscoveryClient({ cacheDir: dir, token: "T", fetchImpl: stub.fetchImpl });
    await c.getByBibcode(SEED); // q=bibcode:..., rows 1, no sort
    await c.similar(SEED, 18); // different q, rows, +sort
    await c.similar(SEED, 5); // same q, different rows
    await c.similar("2099ZZZ........", 18); // different q
    expect(stub.calls).toHaveLength(4);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(4);
  });

  test("successful empty result is cached (no refetch)", async () => {
    const stub = stubFetch(() => adsResponse([]));
    const c = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stub.fetchImpl,
    });
    expect(await c.similar(SEED, 18)).toEqual([]);
    expect(await c.similar(SEED, 18)).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  test("cache hit answers without a token", async () => {
    const stub = stubFetch(() => adsResponse([doc(SEED)]));
    const dir = tmpCache();
    await new AdsDiscoveryClient({
      cacheDir: dir,
      token: "T",
      fetchImpl: stub.fetchImpl,
    }).getByBibcode(SEED);
    const noTok = new AdsDiscoveryClient({ cacheDir: dir, token: null, fetchImpl: stub.fetchImpl });
    expect((await noTok.getByBibcode(SEED))?.bibcode).toBe(SEED);
    expect(stub.calls).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- //
// Typed errors (never cached as data)
// --------------------------------------------------------------------------- //

describe("typed provider errors", () => {
  test("no token → no-token, no network", async () => {
    const stub = stubFetch(() => {
      throw new Error("network must not be touched");
    });
    const c = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: null,
      fetchImpl: stub.fetchImpl,
    });
    await expect(c.getByBibcode(SEED)).rejects.toMatchObject({ kind: "no-token" });
    expect(stub.calls).toHaveLength(0);
  });

  test("401/403 → unauthorized; 429 → rate-limited with Retry-After; 500 → upstream", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [500, "upstream"],
    ] as const) {
      const c = new AdsDiscoveryClient({
        cacheDir: tmpCache(),
        token: "T",
        fetchImpl: stubFetch(() => jsonResponse({ error: "x" }, { status })).fetchImpl,
      });
      await expect(c.similar(SEED, 18)).rejects.toMatchObject({ kind });
    }
    const limited = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stubFetch(
        () => new Response("slow down", { status: 429, headers: { "retry-after": "17" } })
      ).fetchImpl,
    });
    await expect(limited.similar(SEED, 18)).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfter: "17",
    });
  });

  test("network throw → upstream; invalid JSON / missing docs → invalid-response", async () => {
    const netFail = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stubFetch(() => {
        throw new Error("ECONNRESET");
      }).fetchImpl,
    });
    await expect(netFail.similar(SEED, 18)).rejects.toMatchObject({ kind: "upstream" });

    const badJson = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stubFetch(() => new Response("not json", { status: 200 })).fetchImpl,
    });
    await expect(badJson.similar(SEED, 18)).rejects.toMatchObject({ kind: "invalid-response" });

    const noDocs = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stubFetch(() => jsonResponse({ response: {} })).fetchImpl,
    });
    await expect(noDocs.similar(SEED, 18)).rejects.toMatchObject({ kind: "invalid-response" });
  });

  test("errors are not cached: a later success refetches", async () => {
    let fail = true;
    const stub = stubFetch(() => {
      if (fail) return jsonResponse({ error: "x" }, { status: 500 });
      return adsResponse([doc(SEED)]);
    });
    const c = new AdsDiscoveryClient({
      cacheDir: tmpCache(),
      token: "T",
      fetchImpl: stub.fetchImpl,
    });
    await expect(c.similar(SEED, 18)).rejects.toMatchObject({ kind: "upstream" });
    fail = false;
    expect(await c.similar(SEED, 18)).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });

  test("abort propagates and writes no cache entry", async () => {
    const dir = tmpCache();
    const controller = new AbortController();
    const stub = stubFetch(() => {
      controller.abort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const c = new AdsDiscoveryClient({ cacheDir: dir, token: "T", fetchImpl: stub.fetchImpl });
    await expect(c.similar(SEED, 18, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("AdsDiscoveryError exposes name/kind/retryAfter", () => {
    const e = new AdsDiscoveryError("rate-limited", "msg", "5");
    expect(e.name).toBe("AdsDiscoveryError");
    expect(e.kind).toBe("rate-limited");
    expect(e.retryAfter).toBe("5");
    expect(e.message).toBe("msg");
  });
});
