/**
 * ADS libraries client (project intake ticket 02) against an offline stub of the biblib service. No call leaves the
 * process; every request is recorded so the tests can assert that only GETs were sent and that the token travels in
 * the Authorization header alone.
 */

import { describe, expect, test } from "vitest";
import { AdsLibrariesClient } from "../src/sources/ads-libraries.js";
import { jsonResponse, type StubCall, stubFetch } from "./helpers.js";

const TOKEN = "TEST-TOKEN-NOT-REAL";
const LIB = {
  id: "abc123_-X",
  name: "My papers",
  description: "things",
  num_documents: 250,
  permission: "owner",
  public: false,
  owner: "someone",
};

const bib = (n: number) => `2020ApJ...${String(n).padStart(4, "0")}....A`;

/** A biblib stub holding one library of `count` bibcodes, honouring start/rows with a service-side row cap. */
function biblib(count: number, rowCap = 100) {
  return (call: StubCall): Response => {
    const url = new URL(call.url);
    if (url.pathname === "/v1/biblib/libraries")
      return jsonResponse({
        count: 2,
        libraries: [LIB, { ...LIB, id: "second", num_documents: 0 }],
      });
    if (url.pathname === `/v1/biblib/libraries/${LIB.id}`) {
      const start = Number(url.searchParams.get("start"));
      const rows = Math.min(Number(url.searchParams.get("rows")), rowCap);
      const documents = Array.from({ length: Math.max(0, Math.min(count - start, rows)) }, (_, i) =>
        bib(start + i)
      );
      return jsonResponse({
        documents,
        solr: "Only the raw library was requested.",
        metadata: { ...LIB, num_documents: count },
        updates: {},
      });
    }
    return new Response("{}", { status: 410 });
  };
}

function client(handler: (call: StubCall) => Response | Promise<Response>, over = {}) {
  const stub = stubFetch(handler);
  return {
    c: new AdsLibrariesClient({ token: TOKEN, fetchImpl: stub.fetchImpl, ...over }),
    calls: stub.calls,
  };
}

function expectReadOnly(calls: StubCall[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.method).toBe("GET");
    expect(call.bodyText).toBeUndefined();
    expect(new URL(call.url).origin).toBe("https://api.adsabs.harvard.edu");
    expect(new URL(call.url).pathname.startsWith("/v1/biblib/libraries")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
  }
}

describe("list", () => {
  test("lists the user's libraries with id, name, count and the optional fields", async () => {
    const { c, calls } = client(biblib(0));
    const out = await c.list();
    expect(out).toEqual({
      ok: true,
      total: 2,
      truncated: false,
      libraries: [
        {
          id: LIB.id,
          name: "My papers",
          numDocuments: 250,
          description: "things",
          permission: "owner",
          public: false,
          owner: "someone",
        },
        {
          id: "second",
          name: "My papers",
          numDocuments: 0,
          description: "things",
          permission: "owner",
          public: false,
          owner: "someone",
        },
      ],
    });
    expectReadOnly(calls);
  });

  test("an answer without a libraries array is invalid_response", async () => {
    const { c } = client(() => jsonResponse({ nope: 1 }));
    expect(await c.list()).toEqual({ ok: false, reason: "invalid_response" });
  });

  test("an account with no library is an empty list, not an error", async () => {
    const { c } = client(() => jsonResponse({ count: 0, libraries: [] }));
    expect(await c.list()).toEqual({ ok: true, libraries: [], total: 0, truncated: false });
  });
});

describe("readWindow", () => {
  const q = (calls: StubCall[], k: string) => calls.map((x) => new URL(x.url).searchParams.get(k));

  test("a window of 200 is two requests of 100 whatever the library's size", async () => {
    for (const size of [250, 20_000]) {
      const { c, calls } = client(biblib(size, 100));
      const out = await c.readWindow(LIB.id, 0, 200);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.bibcodes).toHaveLength(200);
      expect(out.bibcodes[0]).toBe(bib(0));
      expect(out.bibcodes[199]).toBe(bib(199));
      expect(out.total).toBe(size);
      expect(out.offset).toBe(0);
      expect(out.library.numDocuments).toBe(size);
      expect(q(calls, "start")).toEqual(["0", "100"]);
      expect(q(calls, "rows")).toEqual(["100", "100"]);
      expect(q(calls, "raw")).toEqual(["true", "true"]);
      expect(q(calls, "sort")).toEqual([null, null]); // raw ignores sort upstream: not sent
      expectReadOnly(calls);
    }
  });

  test("a deep offset asks ADS for that window only", async () => {
    const { c, calls } = client(biblib(20_000, 100));
    const out = await c.readWindow(LIB.id, 15_000, 150);
    expect(out.ok && out.bibcodes[0]).toBe(bib(15_000));
    expect(out.ok && out.bibcodes).toHaveLength(150);
    expect(q(calls, "start")).toEqual(["15000", "15100"]);
    expect(q(calls, "rows")).toEqual(["100", "50"]);
  });

  test("a gateway that raises the row cap still gets two requests of at most 100 rows for a 200 window", async () => {
    const { c, calls } = client(biblib(500, 400));
    const out = await c.readWindow(LIB.id, 0, 200);
    // the client never asks for more than 100 rows a request; the cap above is irrelevant
    expect(out.ok && out.bibcodes).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  test("the last window is short and never asks past the end", async () => {
    const { c, calls } = client(biblib(250, 100));
    const out = await c.readWindow(LIB.id, 200, 200);
    expect(out.ok && out.bibcodes).toHaveLength(50);
    expect(out.ok && out.total).toBe(250);
    expect(q(calls, "rows")).toEqual(["100"]);
    expect(calls).toHaveLength(1);
  });

  test("an offset at or past the end is an empty window with the total", async () => {
    for (const offset of [250, 251, 5000]) {
      const { c } = client(biblib(250, 100));
      const out = await c.readWindow(LIB.id, offset, 200);
      expect(out).toMatchObject({ ok: true, total: 250, offset, bibcodes: [] });
    }
  });

  test("the id asked for wins over an id in the metadata", async () => {
    const { c } = client(() =>
      jsonResponse({ documents: [bib(0)], metadata: { ...LIB, id: "other", num_documents: 1 } })
    );
    const out = await c.readWindow(LIB.id, 0, 10);
    expect(out.ok && out.library.id).toBe(LIB.id);
  });

  test("a service that caps rows low gives a shorter window in a bounded number of requests", async () => {
    const { c, calls } = client(biblib(5000, 20));
    const out = await c.readWindow(LIB.id, 0, 200);
    expect(out.ok && out.bibcodes).toHaveLength(60);
    expect(calls).toHaveLength(3);
  });

  test("an empty library is ok with no bibcodes", async () => {
    const { c, calls } = client(biblib(0));
    const out = await c.readWindow(LIB.id, 0, 200);
    expect(out).toMatchObject({ ok: true, total: 0, bibcodes: [] });
    expect(calls).toHaveLength(1);
  });

  test("a library id that is not a slug never reaches the network", async () => {
    const { c, calls } = client(biblib(1));
    expect(await c.readWindow("../../v1/search/query?x=1", 0, 10)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(calls).toHaveLength(0);
  });

  test("410 is not_found", async () => {
    const { c } = client(() => new Response("{}", { status: 410 }));
    expect(await c.readWindow("gone", 0, 10)).toEqual({
      ok: false,
      reason: "not_found",
      http: 410,
    });
  });

  test("a page without documents is invalid_response", async () => {
    const { c } = client(() => jsonResponse({ metadata: LIB }));
    expect(await c.readWindow(LIB.id, 0, 10)).toEqual({ ok: false, reason: "invalid_response" });
  });

  describe("an answer that contradicts itself is invalid_response, never a wrong window", () => {
    const body = (documents: unknown[], num = 250) =>
      jsonResponse({ documents, metadata: { ...LIB, num_documents: num } });
    const invalid = { ok: false, reason: "invalid_response" };

    test("the service ignores start and repeats the first page", async () => {
      const { c } = client(() => body(Array.from({ length: 100 }, (_, i) => bib(i))));
      expect(await c.readWindow(LIB.id, 0, 200)).toEqual(invalid);
    });

    test("a bibcode repeated inside one page", async () => {
      const { c } = client(() => body([bib(1), bib(2), bib(1)]));
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual(invalid);
    });

    test("more bibcodes than rows were asked", async () => {
      const { c } = client(() => body(Array.from({ length: 11 }, (_, i) => bib(i))));
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual(invalid);
    });

    test("more bibcodes than num_documents allows at that offset", async () => {
      const { c } = client(() => body([bib(1), bib(2), bib(3)], 2));
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual(invalid);
    });

    test("an empty page before num_documents is reached", async () => {
      const { c } = client(() => body([], 250));
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual(invalid);
    });

    test("an empty second page before the window or the library ends", async () => {
      let n = 0;
      const { c } = client(() =>
        ++n === 1 ? body(Array.from({ length: 100 }, (_, i) => bib(i))) : body([])
      );
      expect(await c.readWindow(LIB.id, 0, 200)).toEqual(invalid);
    });

    test("num_documents changing between the two requests", async () => {
      let n = 0;
      const { c } = client(() =>
        ++n === 1
          ? body(
              Array.from({ length: 100 }, (_, i) => bib(i)),
              250
            )
          : body(
              Array.from({ length: 100 }, (_, i) => bib(100 + i)),
              251
            )
      );
      expect(await c.readWindow(LIB.id, 0, 200)).toEqual(invalid);
    });

    test("an entry that is not a bibcode string", async () => {
      const { c } = client(() => body([bib(1), 7]));
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual(invalid);
      const { c: d } = client(() => body([bib(1), ""]));
      expect(await d.readWindow(LIB.id, 0, 10)).toEqual(invalid);
    });

    test("an empty page past the end when the offset is inside it is not an empty window", async () => {
      const { c } = client(() => body([], 5));
      expect(await c.readWindow(LIB.id, 2, 10)).toEqual(invalid);
    });

    test("documents past the end when the offset is at the end", async () => {
      const { c } = client(() => body([bib(1)], 5));
      expect(await c.readWindow(LIB.id, 5, 10)).toEqual(invalid);
    });
  });
});

describe("failures are told apart and never carry the token", () => {
  test("no token: no request at all", async () => {
    for (const token of [null, ""]) {
      const stub = stubFetch(biblib(1));
      const c = new AdsLibrariesClient({ token, fetchImpl: stub.fetchImpl });
      expect(await c.list()).toEqual({ ok: false, reason: "no_token" });
      expect(await c.readWindow(LIB.id, 0, 10)).toEqual({ ok: false, reason: "no_token" });
      expect(stub.calls).toHaveLength(0);
    }
  });

  test("401 is unauthorized, 403 forbidden, 429 rate_limited with Retry-After", async () => {
    for (const [status, reason] of [
      [401, "unauthorized"],
      [403, "forbidden"],
    ] as const) {
      const { c } = client(() => new Response(`denied ${TOKEN}`, { status }));
      const out = await c.list();
      expect(out).toEqual({ ok: false, reason, http: status });
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      const read = await c.readWindow(LIB.id, 0, 10);
      expect(read).toEqual({ ok: false, reason, http: status });
    }
    const { c } = client(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    expect(await c.list()).toEqual({
      ok: false,
      reason: "rate_limited",
      http: 429,
      retryAfter: "30",
    });
    expect(await c.readWindow(LIB.id, 0, 10)).toEqual({
      ok: false,
      reason: "rate_limited",
      http: 429,
      retryAfter: "30",
    });
  });

  test("a rate limit in the middle of paging is rate_limited, not a short list", async () => {
    let n = 0;
    const base = biblib(250);
    const { c } = client((call) => (++n === 2 ? new Response("", { status: 429 }) : base(call)));
    const out = await c.readWindow(LIB.id, 0, 200);
    expect(out).toEqual({ ok: false, reason: "rate_limited", http: 429 });
  });

  test("network failure and 5xx are unreachable", async () => {
    const down = client(() => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    });
    const out = await down.c.list();
    expect(out).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const five = client(() => new Response("oops", { status: 503 }));
    expect(await five.c.list()).toEqual({ ok: false, reason: "unreachable", http: 503 });
  });

  test("a request that does not answer in time is timeout", async () => {
    const hang = (call: StubCall) =>
      new Promise<Response>((_, reject) => {
        void call;
        setTimeout(() => reject(Object.assign(new Error("t"), { name: "TimeoutError" })), 5);
      });
    const { c } = client(hang, { requestTimeoutMs: 20 });
    expect(await c.list()).toEqual({ ok: false, reason: "timeout" });
  });

  test("a stub that honours the abort signal times out for real", async () => {
    const stub = {
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))
          );
        })) as typeof fetch,
    };
    const c = new AdsLibrariesClient({
      token: TOKEN,
      fetchImpl: stub.fetchImpl,
      requestTimeoutMs: 30,
    });
    expect(await c.readWindow(LIB.id, 0, 10)).toEqual({ ok: false, reason: "timeout" });
  });

  test("a body that is not JSON is invalid_response", async () => {
    const { c } = client(() => new Response("<html>", { status: 200 }));
    expect(await c.list()).toEqual({ ok: false, reason: "invalid_response" });
  });

  test("the caller's own cancel is rethrown, not reported as an ADS failure", async () => {
    const c = new AdsLibrariesClient({
      token: TOKEN,
      fetchImpl: (async () => {
        throw Object.assign(new Error("x"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    const ctl = new AbortController();
    ctl.abort();
    await expect(c.list(ctl.signal)).rejects.toThrow();
  });

  test("a cancel between the two requests of a window is rethrown too", async () => {
    const ctl = new AbortController();
    const base = biblib(500, 100);
    let n = 0;
    const { c } = client((call) => {
      if (++n === 2) {
        ctl.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return base(call);
    });
    await expect(c.readWindow(LIB.id, 0, 200, ctl.signal)).rejects.toThrow();
  });
});

describe("read-only by construction", () => {
  test("the client source has no write request and no body", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/sources/ads-libraries.ts", import.meta.url), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/i);
    expect(code).not.toMatch(/\bbody\s*:/);
    expect(code.match(/method:/g)).toHaveLength(1);
    expect(code).toContain('method: "GET"');
  });
});
