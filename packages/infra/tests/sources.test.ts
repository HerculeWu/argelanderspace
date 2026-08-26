/**
 * Metadata-source clients (ADS / Crossref / OpenAlex) — offline against
 * recorded fixtures. The disk-cache keys are asserted byte-identical to the
 * Python client's (the same formulas produce the existing
 * data/library/cache/<source>/<key>.json filenames).
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AdsClient, normalizeAdsDoc, readAdsToken, titleMatches } from "../src/sources/ads.js";
import { CrossrefClient } from "../src/sources/crossref.js";
import { normalizeOpenAlex, OpenAlexClient } from "../src/sources/openalex.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const MAILTO = "wuwenjiegogo@gmail.com";

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as Record<string, unknown>;
}

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "m2-sources-"));
}

// --------------------------------------------------------------------------- //
// ADS
// --------------------------------------------------------------------------- //

describe("AdsClient (library/sources/ads.py)", () => {
  test("no token → status no-token, resolve is a null no-op, no network", async () => {
    const { fetchImpl, calls } = stubFetch(() => {
      throw new Error("network must not be touched");
    });
    const ads = new AdsClient({ cacheDir: tmpCache(), token: null, fetchImpl });
    expect(ads.status).toBe("no-token");
    expect(await ads.resolve({ doi: "10.1086/161130" })).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("resolve by doi: one GET, normalized record, then cache-served", async () => {
    const docs = load("ads-docs.json");
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.url).toContain("q=doi%3A10.1086%2F161130");
      expect(c.headers.Authorization).toBe("Bearer TEST-TOKEN");
      return jsonResponse({ response: { docs } });
    });
    const cacheDir = tmpCache();
    const ads = new AdsClient({ cacheDir, token: "TEST-TOKEN", delay: 0, fetchImpl });
    const n = await ads.resolve({ doi: "10.1086/161130" });
    expect(n).toEqual({
      bibcode: "1983ApJ...270..365M",
      doi: "10.1086/161130",
      title:
        "A modification of the Newtonian dynamics as a possible alternative to the hidden mass hypothesis",
      authors: ["Milgrom"],
      year: 1983,
      venue: "Astrophysical Journal, Vol. 270, p. 365-370",
      citation_count: 6500,
      abstract: "Considerations of galaxies ...",
      references: ["1982ApJ...258..415F", "1980ApJ...238..471R"],
    });
    expect(calls.length).toBe(1);
    // cache key = sha1("doi:10.1086/161130"), identical to the Python client
    expect(readdirSync(cacheDir)).toEqual(["e4d61e3c25d9e54cc60b913c41d6f662d1412ccb.json"]);
    // second resolve served from disk — no further network
    const again = await ads.resolve({ doi: "10.1086/161130" });
    expect(again?.bibcode).toBe("1983ApJ...270..365M");
    expect(calls.length).toBe(1);
  });

  test("401/403 → status unauthorized, resolve degrades to null", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: "denied" }, { status: 403 }));
    const ads = new AdsClient({ cacheDir: tmpCache(), token: "BAD", delay: 0, fetchImpl });
    expect(await ads.resolve({ doi: "10.1086/161130" })).toBeNull();
    expect(ads.status).toBe("unauthorized");
  });

  test("normalizeAdsDoc + titleMatches", () => {
    const docs = JSON.parse(readFileSync(join(FIXTURES, "ads-docs.json"), "utf-8")) as Array<
      Record<string, unknown>
    >;
    const n = normalizeAdsDoc(docs[0] ?? {});
    expect(n.year).toBe(1983);
    // case/punctuation differences normalize away (Python-verified)
    expect(titleMatches(n.title.toUpperCase(), n.title)).toBe(true);
    // a strict-prefix query shares too few tokens (< 0.7 Jaccard) — Python says no
    expect(titleMatches("A Modification of the Newtonian Dynamics!!", n.title)).toBe(false);
    expect(titleMatches("Completely unrelated title", n.title)).toBe(false);
  });

  test("readAdsToken prefers env, falls back to ~/.ads/dev_key, else null", () => {
    expect(readAdsToken({ ADS_DEV_KEY: "  abc  " }, "/nonexistent-home")).toBe("abc");
    expect(readAdsToken({}, "/nonexistent-home")).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Crossref
// --------------------------------------------------------------------------- //

describe("CrossrefClient (library/sources/crossref.py)", () => {
  test("resolve by doi → normalized record (fixture)", async () => {
    const body = load("crossref-work.json");
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.url).toContain("/works/10.3847/1538-4365/ae4fbb"); // path: raw, like requests
      expect(c.url).toContain(`mailto=${encodeURIComponent(MAILTO)}`);
      return jsonResponse(body);
    });
    const cr = new CrossrefClient({ cacheDir: tmpCache(), delay: 0, mailto: MAILTO, fetchImpl });
    const n = await cr.resolve({ doi: "10.3847/1538-4365/ae4fbb" });
    expect(n).not.toBeNull();
    expect(n?.doi).toBe("10.3847/1538-4365/ae4fbb");
    expect(n?.title).toBe(
      "Long-term Spectroscopic Survey of the Hyades Cluster: The Binary Population"
    );
    expect(n?.authors).toEqual(["Torres", "Stefanik", "Latham"]);
    expect(n?.year).toBe(2026);
    expect(n?.type).toBe("article");
    expect(n?.cited_by_count).toBe(0);
    expect(n?.reference_dois).toEqual([
      "10.5479/ads/bib/1914licob.8.52a",
      "10.1093/mnras/stae425",
      "10.1051/0004-6361/201730393",
    ]);
    expect(n?.n_references).toBe(228);
    expect(n?.resource_url).toBe("https://iopscience.iop.org/article/10.3847/1538-4365/ae4fbb");
    expect(n?.links.length).toBe(4);
    expect(n?.abstract?.startsWith("Abstract We report the results")).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("cache key is byte-identical to the Python client", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(load("crossref-work.json")));
    const cacheDir = tmpCache();
    const cr = new CrossrefClient({ cacheDir, delay: 0, mailto: MAILTO, fetchImpl });
    await cr.resolve({ doi: "10.1086/161130" });
    // sha1("/works/10.1086/161130?" + json.dumps({"mailto": ...}, sort_keys=True))
    expect(readdirSync(cacheDir)).toEqual(["0dfc3c7fc8bde3609f7253ca86412b1c0c4013a3.json"]);
  });

  test("404 is cached as the __notfound__ sentinel and not re-fetched", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({}, { status: 404 }));
    const cacheDir = tmpCache();
    const cr = new CrossrefClient({ cacheDir, delay: 0, mailto: MAILTO, fetchImpl });
    // no title → nothing falls through to search, so resolve is null
    expect(await cr.resolve({ doi: "10.0000/nonexistent" })).toBeNull();
    expect(calls.length).toBe(1);
    const cached = JSON.parse(
      readFileSync(join(cacheDir, readdirSync(cacheDir)[0] ?? ""), "utf-8")
    );
    expect(cached).toEqual({ __notfound__: true });
    expect(await cr.resolve({ doi: "10.0000/nonexistent" })).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("disabled client returns null without network", async () => {
    const { fetchImpl, calls } = stubFetch(() => {
      throw new Error("network must not be touched");
    });
    const cr = new CrossrefClient({ cacheDir: tmpCache(), enabled: false, fetchImpl });
    expect(await cr.resolve({ doi: "10.1086/161130" })).toBeNull();
    expect(calls.length).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// OpenAlex
// --------------------------------------------------------------------------- //

describe("OpenAlexClient (library/sources/openalex.py)", () => {
  test("normalizeOpenAlex(fixture) matches the Python normalizer", () => {
    const n = normalizeOpenAlex(load("openalex-work.json"));
    expect(n.openalex_id).toBe("W3017279354");
    expect(n.doi).toBe("10.1051/0004-6361/202038192");
    expect(n.title).toBe("Painting a portrait of the Galactic disc with its stellar clusters");
    expect(n.authors).toEqual(["Cantat-Gaudin", "Anders"]);
    expect(n.year).toBe(2020);
    expect(n.venue).toBe("Astronomy and Astrophysics");
    expect(n.type).toBe("article");
    expect(n.cited_by_count).toBe(522);
    expect(n.referenced_works).toEqual(["W409719633", "W1522301498", "W1629434878"]);
    expect(n.arxiv_id).toBe("2004.07274"); // recovered from locations
    expect(n.abstract?.startsWith("Context. The large astrometric")).toBe(true);
    expect(n.abstract?.endsWith("census might still be incomplete.")).toBe(true);
  });

  test("resolve by journal doi, cache key byte-identical to Python", async () => {
    const work = load("openalex-work.json");
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.url).toContain("/works/https://doi.org/10.1051/0004-6361/202038192"); // path: raw
      return jsonResponse(work);
    });
    const cacheDir = tmpCache();
    const oa = new OpenAlexClient({ cacheDir, delay: 0, mailto: MAILTO, apiKey: null, fetchImpl });
    const n = await oa.resolve({ doi: "10.1051/0004-6361/202038192" });
    expect(n?.openalex_id).toBe("W3017279354");
    expect(calls.length).toBe(1);
    expect(readdirSync(cacheDir)).toEqual(["bc548d3cd214a67f5c94dbc49d381b8782f67635.json"]);
  });

  test("$OPENALEX_API_KEY goes on the wire but NOT into the cache key", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(load("openalex-work.json")));
    const cacheDir = tmpCache();
    const oa = new OpenAlexClient({
      cacheDir,
      delay: 0,
      mailto: MAILTO,
      apiKey: "KEY-123",
      fetchImpl,
    });
    await oa.resolve({ doi: "10.1051/0004-6361/202038192" });
    expect(calls[0]?.url).toContain("api_key=KEY-123");
    // same filename as the keyless client (see previous test)
    expect(readdirSync(cacheDir)).toEqual(["bc548d3cd214a67f5c94dbc49d381b8782f67635.json"]);
  });

  test("fetchMany batches ≤50 ids per request and preserves API order", async () => {
    const work = load("openalex-work.json");
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.url).toContain("openalex_id%3AW3017279354%7CW2122131598");
      expect(c.url).toContain("per-page=50");
      return jsonResponse({ results: [work] });
    });
    const oa = new OpenAlexClient({ cacheDir: tmpCache(), delay: 0, mailto: MAILTO, fetchImpl });
    const out = await oa.fetchMany(["W3017279354", "W2122131598", "W3017279354"]);
    expect(calls.length).toBe(1); // dedup + single batch
    expect([...out.keys()]).toEqual(["W3017279354"]);
    expect(out.get("W3017279354")?.cited_by_count).toBe(522);
  });
});
