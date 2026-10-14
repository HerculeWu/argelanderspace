/**
 * The ADS token test (desktop-app ticket 12): one minimal ADS request, its answer as one of four results. Offline: the
 * HTTP implementation is a stub; no request reaches ADS.
 */

import { describe, expect, test } from "vitest";
import { testAdsToken } from "../src/sources/ads-token-test.js";

const TOKEN = "TOKEN-MARK-abc123";

function stub(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("testAdsToken", () => {
  test("200 is valid; the token goes in the Authorization header only, never in the address", async () => {
    const s = stub(() => new Response('{"response":{"docs":[]}}', { status: 200 }));
    expect(await testAdsToken(TOKEN, { fetchImpl: s.fetchImpl })).toBe("valid");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[0]?.url).toMatch(/^https:\/\/api\.adsabs\.harvard\.edu\/v1\/search\/query\?/);
    expect(s.calls[0]?.url).not.toContain(TOKEN);
  });

  test.each([
    [401, "rejected"],
    [403, "rejected"],
    [429, "rate_limited"],
    [500, "unreachable"],
    [503, "unreachable"],
    [404, "unreachable"],
  ] as const)("HTTP %i is %s", async (status, result) => {
    const s = stub(() => new Response("", { status }));
    expect(await testAdsToken(TOKEN, { fetchImpl: s.fetchImpl })).toBe(result);
  });

  test("a network failure or a timeout is unreachable", async () => {
    const failing = stub(() => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    });
    expect(await testAdsToken(TOKEN, { fetchImpl: failing.fetchImpl })).toBe("unreachable");
    const hanging = (async (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      )) as typeof fetch;
    expect(await testAdsToken(TOKEN, { fetchImpl: hanging, timeoutMs: 20 })).toBe("unreachable");
  });
});
