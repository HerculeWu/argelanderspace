/**
 * The 8 REST endpoints + images + SPA hosting + CSRF/CORS, against a fixture
 * data dir, using Hono's `app.request` (no socket). Upload's async flow and
 * the WS channel have their own suites (upload.test.ts / ws.test.ts).
 *
 * Every assertion on status/body mirrors `server/app.py` byte-semantically.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocIrSchema } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  makeWebDist,
  stubPipelines,
  stubSources,
} from "./helpers.js";

let dataDir: string;
let webDist: string;
let app: Hono;
let runner: JobRunner;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

const TEST_PORT = 8123;

beforeEach(() => {
  dataDir = makeDataDir();
  webDist = makeWebDist();
  runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
    webDist,
    port: TEST_PORT,
  });
});

const get = async (path: string, headers?: Record<string, string>): Promise<Response> =>
  app.request(path, { headers });
const post = async (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const patch = async (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> =>
  app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// --------------------------------------------------------------------------- //
// papers
// --------------------------------------------------------------------------- //

describe("GET /api/papers", () => {
  test("lists docs with a readable <doc_id>.json, sorted", async () => {
    const res = await get("/api/papers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ papers: ["arxiv-2501.17225", "demo"] });
  });
});

describe("GET /api/paper/:doc_id", () => {
  test("returns the parsed document JSON", async () => {
    const res = await get("/api/paper/arxiv-2501.17225");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.doc_id).toBe("arxiv-2501.17225");
    // byte-semantic: deep-equal to what the fixture file holds
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, "output", "arxiv-2501.17225", "arxiv-2501.17225.json"), "utf8")
    );
    expect(doc).toEqual(onDisk);
  });

  test("404 with FastAPI's repr-quoted detail", async () => {
    const res = await get("/api/paper/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "paper 'nope' not found" });
  });

  test("400 on traversal-ish ids", async () => {
    // NB: `..` / `%2e%2e` path segments never reach the handler — the WHATWG
    // URL layer normalizes dot segments away before routing (both in
    // app.request and in @hono/node-server's Request construction); the
    // request 404s instead of 400ing. Safe either way: no traversal.
    for (const bad of [".hidden", ".config", "a%2Fb", "a%5Cb"]) {
      const res = await get(`/api/paper/${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "bad doc id" });
    }
  });

  test("mtime+size cache: edits are picked up, unmodified reads stay equal", async () => {
    const p = join(dataDir, "output", "demo", "demo.json");
    const first = (await (await get("/api/paper/demo")).json()) as Record<string, unknown>;
    expect(first).toMatchObject({ doc_id: "demo" });
    // same content → same payload (cached path)
    expect(await (await get("/api/paper/demo")).json()).toEqual(first);
    // rewrite with a new field (mtime AND size change busts the cache)
    writeFileSync(p, JSON.stringify({ ...first, edited: true }));
    const second = await (await get("/api/paper/demo")).json();
    expect(second).toMatchObject({ doc_id: "demo", edited: true });
  });
});

describe("GET /api/paper/:doc_id/ir", () => {
  test("returns the render IR, consistent with the document JSON", async () => {
    const res = await get("/api/paper/arxiv-2501.17225/ir");
    expect(res.status).toBe(200);
    const ir = DocIrSchema.parse(await res.json());
    expect(ir.docId).toBe("arxiv-2501.17225");
    expect(typeof ir.title).toBe("string");
    expect(ir.sections.length).toBeGreaterThan(0);
    const doc = (await (await get("/api/paper/arxiv-2501.17225")).json()) as {
      references?: unknown[];
    };
    expect(ir.bib).toHaveLength((doc.references ?? []).length);
  });

  test("the minimal demo doc yields an empty IR", async () => {
    const res = await get("/api/paper/demo/ir");
    expect(res.status).toBe(200);
    const ir = DocIrSchema.parse(await res.json());
    expect(ir).toMatchObject({ docId: "demo", title: "Demo paper", sections: [], bib: [] });
  });

  test("404/400 semantics mirror /api/paper/:doc_id", async () => {
    const res = await get("/api/paper/nope/ir");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "paper 'nope' not found" });
    const bad = await get("/api/paper/.hidden/ir");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "bad doc id" });
  });
});

// --------------------------------------------------------------------------- //
// library
// --------------------------------------------------------------------------- //

describe("GET /api/library", () => {
  test("composes project + refs + tags + graph", async () => {
    const res = await get("/api/library");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.project).toMatchObject({ name: "我的文献库" });
    expect(Array.isArray(payload.refs)).toBe(true);
    expect((payload.refs as unknown[]).length).toBeGreaterThan(0);
    expect(payload.tags).toEqual(expect.any(Array));
    expect(payload.graph).toMatchObject({ links: [] });
    expect((payload.graph as { nodes: unknown[] }).nodes).toHaveLength(1);
  });
});

describe("POST /api/library/refs", () => {
  test("400 without nodeId (missing body included)", async () => {
    for (const res of [await post("/api/library/refs"), await post("/api/library/refs", {})]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "nodeId required" });
    }
  });

  test("404 for an unknown graph node", async () => {
    const res = await post("/api/library/refs", { nodeId: "oa:nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "graph node 'oa:nope' not found" });
  });

  test("persists a suggested node and returns its ref", async () => {
    const res = await post("/api/library/refs", { nodeId: "oa:W999", source: "graph-node" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: { id: string; doi: string } };
    expect(body.ref.id).toBe("doi:10.1234/test");
    expect(body.ref.doi).toBe("10.1234/test");
    // persisted: the next payload contains the new ref
    const lib = (await (await get("/api/library")).json()) as { refs: { id: string }[] };
    expect(lib.refs.some((r) => r.id === "doi:10.1234/test")).toBe(true);
    // live-reload event
    expect(messages.some((m) => m.type === "library.changed" && m.cause === "add")).toBe(true);
  });
});

describe("PATCH /api/library/refs", () => {
  test("400 without id", async () => {
    const res = await patch("/api/library/refs", { label: "red" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "id required" });
  });

  test("404 for an unknown work", async () => {
    const res = await patch("/api/library/refs", { id: "doi:nope", label: "red" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "work 'doi:nope' not found" });
  });

  test("applies user-state fields and persists them", async () => {
    const res = await patch("/api/library/refs", {
      id: KNOWN_WORK_ID,
      label: "red",
      read: true,
      tags: ["dyn"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const onDisk = JSON.parse(readFileSync(join(dataDir, "library", "library.json"), "utf8")) as {
      works: Record<string, unknown>[];
    };
    const w = onDisk.works.find((x) => x.id === KNOWN_WORK_ID);
    expect(w).toMatchObject({ label: "red", read: true, tags: ["dyn"] });
    expect(messages.some((m) => m.type === "library.changed" && m.cause === "patch")).toBe(true);
  });
});

describe("POST /api/library/refresh", () => {
  test("offline rebuild returns the summary (response shape unchanged)", async () => {
    const res = await post("/api/library/refresh?offline=true");
    expect(res.status).toBe(200);
    const summary = (await res.json()) as Record<string, unknown>;
    expect(summary).toMatchObject({ bib_entries: 0, ads_status: "no-token" });
    expect(summary.works).toBeGreaterThan(0);
    expect(summary.acquisition).toBeDefined();
    expect(summary.resolution).toBeDefined();
    // ran through the job runner + announced on the bus, in wire order
    const types = messages.map((m) => m.type);
    expect(types).toContain("job.created");
    expect(types).toContain("job.done");
    expect(types.indexOf("job.done")).toBeLessThan(types.indexOf("library.changed"));
  });

  test("no offline param also works (stub sources make it hermetic)", async () => {
    const res = await post("/api/library/refresh");
    expect(res.status).toBe(200);
  });

  test("422 on a malformed boolean", async () => {
    const res = await post("/api/library/refresh?offline=banana");
    expect(res.status).toBe(422);
    expect((await res.json()) as { detail: string }).toHaveProperty("detail");
  });
});

// --------------------------------------------------------------------------- //
// CSRF + CORS
// --------------------------------------------------------------------------- //

describe("CSRF guard (Origin check on mutations)", () => {
  const cases: [string, (h?: Record<string, string>) => Promise<Response>][] = [
    ["POST /api/library/refs", (h) => post("/api/library/refs", { nodeId: "oa:W999" }, h)],
    ["PATCH /api/library/refs", (h) => patch("/api/library/refs", { id: KNOWN_WORK_ID }, h)],
    ["POST /api/library/refresh", (h) => post("/api/library/refresh?offline=true", undefined, h)],
    [
      "POST /api/library/upload",
      async (h) =>
        app.request(`/api/library/upload?id=${KNOWN_WORK_ID}&sync=1`, {
          method: "POST",
          headers: { "Content-Type": "application/pdf", ...h },
          body: "%PDF-1.4 stub",
        }),
    ],
  ];
  for (const [name, call] of cases) {
    test(`${name}: evil Origin → 403`, async () => {
      const res = await call({ Origin: "http://evil.example" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: "cross-site request rejected" });
    });
    test(`${name}: Vite dev Origin → pass`, async () => {
      const res = await call({ Origin: "http://localhost:5173" });
      expect(res.status).not.toBe(403);
    });
    test(`${name}: no Origin (local tool) → pass`, async () => {
      expect((await call()).status).not.toBe(403);
    });
    test(`${name}: same-origin SPA port → pass`, async () => {
      const res = await call({ Origin: `http://localhost:${TEST_PORT}` });
      expect(res.status).not.toBe(403);
    });
  }

  test("GETs are never origin-checked", async () => {
    const res = await get("/api/papers", { Origin: "http://evil.example" });
    expect(res.status).toBe(200);
  });
});

describe("CORS (Vite dev origin, GET only)", () => {
  test("preflight from 5173 reflects origin + requested headers, GET only", async () => {
    const res = await app.request("/api/papers", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type,x-custom",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type,x-custom");
  });

  test("simple GET carries allow-origin for the dev origin only", async () => {
    const ok = await get("/api/papers", { Origin: "http://127.0.0.1:5173" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    const evil = await get("/api/papers", { Origin: "http://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// images + SPA
// --------------------------------------------------------------------------- //

describe("GET /images/:doc_id/:filename", () => {
  test("serves from mineru/images and assets with content types", async () => {
    const jpg = await get("/images/demo/pic.jpg");
    expect(jpg.status).toBe(200);
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await jpg.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    );
    const png = await get("/images/demo/logo.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  test("404 for a missing image", async () => {
    const res = await get("/images/demo/missing.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "image not found" });
  });

  test("400 on traversal (filename checked before doc id)", async () => {
    // (`%2e%2e` is normalized away by the URL layer — see the paper test.)
    expect(await (await get("/images/demo/a%2Fb")).json()).toEqual({ detail: "bad filename" });
    expect(await (await get("/images/demo/.secret.png")).json()).toEqual({
      detail: "bad filename",
    });
    expect(await (await get("/images/.hidden/x.png")).json()).toEqual({ detail: "bad doc id" });
  });
});

describe("GET /images/:doc_id/<subpath> (img_path verbatim)", () => {
  test("serves subdirectory paths: assets/… doc-relative, images/… under mineru/", async () => {
    const png = await get("/images/demo/assets/logo.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const nested = await get("/images/demo/assets/nested/deep.png");
    expect(nested.status).toBe(200);
    expect(new Uint8Array(await nested.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x48])
    );
    const jpg = await get("/images/demo/images/pic.jpg");
    expect(jpg.status).toBe(200);
    expect(new Uint8Array(await jpg.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    );
  });

  test("404 for a missing subpath", async () => {
    const res = await get("/images/demo/assets/missing.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "image not found" });
  });

  test("traversal never escapes the doc dir", async () => {
    // literal/encoded dot segments are normalized away by the URL layer: the
    // remainder 404s inside another doc's lookup, no file is ever served
    const normalized = await get("/images/demo/assets/../../library/library.json");
    expect(normalized.status).toBe(404);
    // an encoded slash smuggles ".." past the URL layer → the guard 400s
    const smuggled = await get("/images/demo/assets/%2e%2e%2Flibrary.json");
    expect(smuggled.status).toBe(400);
    expect(await smuggled.json()).toEqual({ detail: "bad filename" });
    // backslash separators are rejected too
    const backslash = await get("/images/demo/assets/%5Cnested/deep.png");
    expect(backslash.status).toBe(400);
  });
});

describe("SPA static hosting (API takes precedence)", () => {
  test("serves index.html at / and falls back for client routes", async () => {
    const root = await get("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("ArgelanderSpace");
    const deep = await get("/reader/arxiv-2501.17225");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("ArgelanderSpace");
  });

  test("serves real asset files", async () => {
    const res = await get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  test("unknown /api paths 404 as JSON, never the SPA", async () => {
    const res = await get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });
});
