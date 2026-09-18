/**
 * Stage 13: POST /api/library/works — the manual work-creation route behind
 * the webui import menu. Hermetic data dir + stubbed offline sources (no
 * network); per-entry outcomes ride in the 200 body.
 */

import { join } from "node:path";
import { libraryPaths, type MetadataSources } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

let dataDir: string;
let app: Hono;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

const TEST_PORT = 8124;

beforeEach(() => {
  dataDir = makeDataDir();
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    webDist: null,
    port: TEST_PORT,
    // Stage 15: this file pins CREATION semantics; the automatic arXiv fetch
    // (which would queue ingest jobs on created/exists) is covered in
    // attach-arxiv.test.ts — keep it off here.
    autoIngestArxiv: () => false,
  });
});

const post = async (path: string, body?: unknown, headers?: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

interface ResultBody {
  results: Array<{
    status: "created" | "exists" | "error";
    ref?: { id: string; cite: string };
    key?: string;
    error?: string;
  }>;
}

describe("POST /api/library/works", () => {
  test("400 on a malformed body", async () => {
    for (const body of [undefined, {}, { mode: "nope" }, { mode: "bibcode" }]) {
      const res = await post("/api/library/works", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        detail: "invalid request body (expected {mode: identifier|bibcode|bib, …})",
      });
    }
  });

  test("403 on an evil Origin (CSRF guard)", async () => {
    const res = await post(
      "/api/library/works",
      { mode: "identifier", value: "10.1051/0004-6361/202039341" },
      { Origin: "http://evil.example" }
    );
    expect(res.status).toBe(403);
  });

  test("identifier DOI: tolerant stub creation offline + add broadcast", async () => {
    const res = await post("/api/library/works", {
      mode: "identifier",
      value: "10.1234/brand-new",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResultBody;
    expect(body.results[0]?.status).toBe("created");
    expect(body.results[0]?.ref?.id).toBe("doi:10.1234/brand-new");
    expect(body.results[0]?.key).toBeTruthy();
    expect(messages.some((m) => m.type === "library.changed" && m.cause === "add")).toBe(true);

    // doi.org URL form hits the same work → exists, and no second broadcast
    messages.length = 0;
    const again = await post("/api/library/works", {
      mode: "identifier",
      value: "https://doi.org/10.1234/brand-new",
    });
    const body2 = (await again.json()) as ResultBody;
    expect(body2.results[0]?.status).toBe("exists");
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);
  });

  test("identifier arXiv: bare id is rejected with guidance; prefixed/URL forms work", async () => {
    // smoke revision (2026-09-16): arXiv input must be explicit (arXiv: prefix
    // or arxiv.org URL) so the identifier kind is unambiguous
    const bare = await post("/api/library/works", { mode: "identifier", value: "2603.03522" });
    const bareBody = (await bare.json()) as ResultBody;
    expect(bareBody.results[0]?.status).toBe("error");
    expect(bareBody.results[0]?.error).toContain("arXiv:2603.03522");

    const res = await post("/api/library/works", { mode: "identifier", value: "arXiv:2603.03522" });
    const body = (await res.json()) as ResultBody;
    expect(body.results[0]?.status).toBe("exists");
    expect(body.results[0]?.ref?.id).toBe("arxiv:2603.03522");

    const fresh = await post("/api/library/works", {
      mode: "identifier",
      value: "https://arxiv.org/abs/2603.99999",
    });
    const body2 = (await fresh.json()) as ResultBody;
    expect(body2.results[0]?.status).toBe("created");
    expect(body2.results[0]?.ref?.id).toBe("arxiv:2603.99999");
  });

  test("identifier: unrecognized input is a per-entry error, not an HTTP error", async () => {
    const res = await post("/api/library/works", { mode: "identifier", value: "hello world" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResultBody;
    expect(body.results[0]?.status).toBe("error");
    expect(body.results[0]?.error).toContain("unrecognized identifier");
  });

  test("bibcode: ADS unavailable → per-entry error, nothing written", async () => {
    const res = await post("/api/library/works", {
      mode: "bibcode",
      bibcode: "2021A&A...646A.104H",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResultBody;
    expect(body.results[0]?.status).toBe("error");
    expect(body.results[0]?.error).toContain("unavailable");
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);
  });

  test("bib batch: create, conflict, and exists semantics over HTTP", async () => {
    const bib = `
@article{freshA,
  author = {Doe, J.},
  title  = {A fresh paper},
  year   = {2024}
}
@article{freshB,
  author = {Roe, K.},
  title  = {Another fresh paper},
  year   = {2023}
}
`;
    const res = await post("/api/library/works", { mode: "bib", bib });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResultBody;
    expect(body.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(body.results.map((r) => r.key)).toEqual(["freshA", "freshB"]);

    // same key on a DIFFERENT paper → conflict error; identical entry → exists
    const bib2 = `
@article{freshA,
  author = {Doe, J.},
  title  = {A fresh paper},
  year   = {2024}
}
@article{freshB,
  author = {Evil, I.},
  title  = {A totally different paper},
  year   = {1900}
}
`;
    const res2 = await post("/api/library/works", { mode: "bib", bib: bib2 });
    const body2 = (await res2.json()) as ResultBody;
    expect(body2.results[0]?.status).toBe("exists");
    expect(body2.results[1]?.status).toBe("error");
    expect(body2.results[1]?.error).toContain("already used");
  });

  test("bibcode mode reaches ADS when a tokened source is injected", async () => {
    // rebuild the app with an ADS stub that answers the export; the record is
    // deliberately NOT one of the fixture library's works
    const collector = collectBroadcasts();
    const sources: MetadataSources = {
      ...stubSources(),
      ads: {
        status: "ok",
        resolve: async () => null,
        exportBibtex: async () =>
          `@ARTICLE{2020MNRAS.499.1234X,\n  author = {{Doe}, J.},\n  title = {A fresh MNRAS paper},\n  journal = {\\mnras},\n  year = {2020},\n  volume = {499},\n  pages = {1234},\n  doi = {10.1093/mnras/staa9999}\n}`,
      },
    };
    const dir = makeDataDir();
    const app2 = createApp({
      paths: libraryPaths(dir),
      statusDir: statusDirFor(dir),
      makeSources: () => sources,
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dir, "jobs") }),
      broadcast: collector.broadcast,
      webDist: null,
      port: TEST_PORT,
    });
    const res = await app2.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bibcode", bibcode: "2020MNRAS.499.1234X" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResultBody;
    expect(body.results[0]?.status).toBe("created");
    expect(body.results[0]?.key).toBe("2020MNRAS.499.1234X");
    expect(body.results[0]?.ref?.id).toBe("doi:10.1093/mnras/staa9999");
  });
});
