/**
 * Stage 14: GET /api/library/discovery — the read-only ADS discovery route.
 * Hermetic data dir; the ADS provider is a stubbed `AdsDiscoverySource` (no
 * network). Verifies the HTTP status mapping, `Cache-Control: no-store`, and
 * the absence of Library side effects (no lock/job/write/WS mutation).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DiscoveryGraph, DiscoveryGraphSchema } from "@argelanderspace/contracts";
import {
  type AdsDiscoveryRecord,
  type AdsDiscoverySource,
  libraryPaths,
} from "@argelanderspace/core";
import { AdsDiscoveryError } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const SEED = "2023A&A...673A.114H";
const TEST_PORT = 8125;

function rec(bibcode: string, over: Partial<AdsDiscoveryRecord> = {}): AdsDiscoveryRecord {
  return {
    bibcode,
    title: `Paper ${bibcode}`,
    authors: ["Doe, J."],
    year: 2020,
    venue: "A&A",
    abstract: "An abstract.",
    citation_count: 7,
    doi: null,
    arxiv_id: null,
    references: [],
    ...over,
  };
}

function stubDiscovery(over: Partial<AdsDiscoverySource> = {}): AdsDiscoverySource {
  return {
    getByBibcode: async (b) => (b === SEED ? rec(SEED, { references: ["R1"] }) : null),
    similar: async () => [rec("R1", { references: [SEED, "U1"] })],
    useful: async () => [rec("U1")],
    ...over,
  };
}

let dataDir: string;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

function makeApp(source?: AdsDiscoverySource): Hono {
  dataDir = makeDataDir();
  const collector = collectBroadcasts();
  messages = collector.messages;
  return createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    ...(source ? { makeDiscoverySource: () => source } : {}),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    webDist: null,
    port: TEST_PORT,
  });
}

describe("GET /api/library/discovery", () => {
  beforeEach(() => {
    dataDir = "";
  });

  test("400 on missing / invalid bibcode (before any ADS call)", async () => {
    let touched = false;
    const app = makeApp({
      ...stubDiscovery(),
      getByBibcode: async () => {
        touched = true;
        return null;
      },
    });
    for (const q of [
      "",
      "?bibcode=",
      "?bibcode=%20",
      `?bibcode=${"x".repeat(65)}`,
      "?bibcode=a%20b",
      '?bibcode=a"b',
      "?bibcode=a%09b",
    ]) {
      const res = await app.request(`/api/library/discovery${q}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toContain("bibcode");
    }
    expect(touched).toBe(false);
  });

  test("200 normal graph: seed + related + useful + citation edges; schema-valid", async () => {
    const app = makeApp(stubDiscovery());
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as DiscoveryGraph;
    const parsed = DiscoveryGraphSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.seed).toBe(SEED);
    expect(body.nodes.map((n) => n.bibcode)).toEqual([SEED, "R1", "U1"]);
    expect(body.edges).toContainEqual({ from: "R1", to: SEED, kind: "citation" });
    expect(body.edges).toContainEqual({ from: "R1", to: "U1", kind: "citation" });
    expect(body.warnings).toEqual([]);
    // raw provider references never leak into the wire payload
    for (const n of body.nodes) expect(n).not.toHaveProperty("references");
  });

  test("200 seed-only graph when similar returns zero papers (no useful call)", async () => {
    let usefulCalled = false;
    const app = makeApp(
      stubDiscovery({
        similar: async () => [],
        useful: async () => {
          usefulCalled = true;
          return [];
        },
      })
    );
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoveryGraph;
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]!.roles).toEqual(["seed"]);
    expect(usefulCalled).toBe(false);
  });

  test("200 partial graph + useful_unavailable when useful fails after similar succeeded", async () => {
    const app = makeApp(
      stubDiscovery({
        useful: async () => {
          throw new Error("ADS 500");
        },
      })
    );
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoveryGraph;
    expect(body.nodes.map((n) => n.bibcode)).toEqual([SEED, "R1"]);
    expect(body.warnings).toEqual([{ code: "useful_unavailable" }]);
  });

  test("404 when the seed bibcode is not in ADS", async () => {
    const app = makeApp(stubDiscovery());
    const res = await app.request("/api/library/discovery?bibcode=2099ZZZ........");
    expect(res.status).toBe(404);
  });

  test("503 when the ADS token is missing or rejected", async () => {
    for (const kind of ["no-token", "unauthorized"] as const) {
      const app = makeApp(
        stubDiscovery({
          getByBibcode: async () => {
            throw new AdsDiscoveryError(kind, "token problem");
          },
        })
      );
      const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toBe("token problem");
    }
  });

  test("429 with Retry-After forwarded when ADS rate-limits", async () => {
    const app = makeApp(
      stubDiscovery({
        getByBibcode: async () => {
          throw new AdsDiscoveryError("rate-limited", "slow down", "17");
        },
      })
    );
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  test("502 on upstream/invalid-response failures (incl. similar failure)", async () => {
    for (const kind of ["upstream", "invalid-response"] as const) {
      const app = makeApp(
        stubDiscovery({
          similar: async () => {
            throw new AdsDiscoveryError(kind, "upstream boom");
          },
        })
      );
      const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
      expect(res.status).toBe(502);
    }
  });

  test("503 when the server has no discovery source wired", async () => {
    const app = makeApp(); // no makeDiscoverySource
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(503);
  });

  test("no Library side effects: no WS mutation, library.json & graph.json untouched, no job", async () => {
    const app = makeApp(stubDiscovery());
    const libFile = join(dataDir, "library", "library.json");
    const graphFile = join(dataDir, "library", "cache", "graph.json");
    const libBefore = readFileSync(libFile, "utf-8");
    const graphBefore = readFileSync(graphFile, "utf-8");
    const res = await app.request(`/api/library/discovery?bibcode=${encodeURIComponent(SEED)}`);
    expect(res.status).toBe(200);
    expect(messages).toEqual([]);
    expect(readFileSync(libFile, "utf-8")).toBe(libBefore);
    expect(readFileSync(graphFile, "utf-8")).toBe(graphBefore);
  });
});
