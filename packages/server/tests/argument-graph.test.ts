/**
 * The argument-graph REST endpoints (ADR 0009): `GET`/`PUT
 * /api/works/:workId/argument-graph` against `<dataDir>/argument-graphs/`.
 * Unknown Work 404; a Work without a graph reads as the empty graph at rev 0;
 * PUT rev mismatch 409 with nothing written; schema/structure failures 400; a
 * corrupt or future-version file 500 and untouched; same-process writes
 * serialize; a Doc's global physical delete leaves the graph file alone.
 * Hermetic: tmp data dir, Hono `app.request` (no socket). The over-the-wire
 * `argument-graph.changed` is in ws.test.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import {
  argumentGraphDir,
  argumentGraphPath,
  LibraryStore,
  libraryPaths,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";

/** An id with `:` and `/` — the file-name encoding must carry it. */
const SLASH_WORK_ID = "doi:10.1051/0004-6361/202453302";

let dataDir: string;
let app: Hono;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

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
  });
});

const url = (workId: string) => `/api/works/${encodeURIComponent(workId)}/argument-graph`;
const get = (workId: string) => app.request(url(workId));
const put = (workId: string, body: unknown, headers?: Record<string, string>) =>
  app.request(url(workId), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const graphFor = (workId: string, rev = 0, title = "结论"): ArgumentGraph => ({
  version: 1,
  rev,
  work_id: workId,
  arguments: [
    {
      id: "a",
      title,
      claim: "$E=mc^2$",
      grounds: "",
      warrant: "",
      backing: "",
      qualifier: "",
      rebuttal: "",
      warrant_implicit: false,
      kind: "end",
      sources: [{ text: "Section 3.2", target: { doc_id: "arxiv-2501.17225", anchor: "sec-3" } }],
    },
  ],
  edges: [],
});

describe("GET", () => {
  test("unknown Work is 404", async () => {
    const res = await get("arxiv:0000.00000");
    expect(res.status).toBe(404);
  });

  test("a Work without a graph reads as the empty graph at rev 0, and nothing is written", async () => {
    const res = await get(KNOWN_WORK_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: 1,
      rev: 0,
      work_id: KNOWN_WORK_ID,
      arguments: [],
      edges: [],
    });
    expect(existsSync(argumentGraphDir(dataDir))).toBe(false);
  });

  test("a corrupt file is 500 and is not touched", async () => {
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    writeFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "{ not json");
    const res = await get(KNOWN_WORK_ID);
    expect(res.status).toBe(500);
    expect(readFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "utf8")).toBe("{ not json");
  });

  test("a future-version file is 500", async () => {
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    const body = JSON.stringify({ version: 2, rev: 1, work_id: KNOWN_WORK_ID });
    writeFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), body);
    const res = await get(KNOWN_WORK_ID);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/version 2/);
  });
});

describe("PUT", () => {
  test("first write answers the saved graph at rev 1; GET returns it; broadcasts once", async () => {
    const res = await put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(graphFor(KNOWN_WORK_ID, 1));
    expect(await (await get(KNOWN_WORK_ID)).json()).toEqual(graphFor(KNOWN_WORK_ID, 1));
    const changed = messages.filter((m) => m.type === "argument-graph.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ cause: "put", work_id: KNOWN_WORK_ID });
  });

  test("a Work id with slashes round-trips through the encoded URL and file name", async () => {
    const res = await put(SLASH_WORK_ID, graphFor(SLASH_WORK_ID));
    expect(res.status).toBe(200);
    expect(await (await get(SLASH_WORK_ID)).json()).toEqual(graphFor(SLASH_WORK_ID, 1));
    expect(existsSync(argumentGraphPath(dataDir, SLASH_WORK_ID))).toBe(true);
    // the other Work is unaffected
    expect(((await (await get(KNOWN_WORK_ID)).json()) as ArgumentGraph).rev).toBe(0);
  });

  test("rev mismatch is 409 with the current rev, nothing written, no broadcast", async () => {
    await put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID));
    messages.length = 0;
    const before = readFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "utf8");
    for (const rev of [0, 7]) {
      const res = await put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID, rev, "stale"));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ detail: "rev mismatch", rev: 1 });
    }
    expect(readFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "utf8")).toBe(before);
    expect(messages.filter((m) => m.type === "argument-graph.changed")).toHaveLength(0);
  });

  test("unknown Work is 404 and creates nothing", async () => {
    const res = await put("arxiv:0000.00000", graphFor("arxiv:0000.00000"));
    expect(res.status).toBe(404);
    expect(existsSync(argumentGraphDir(dataDir))).toBe(false);
  });

  test("structure failures are 400 with the reason", async () => {
    const bad = graphFor(KNOWN_WORK_ID);
    const cases: [unknown, RegExp][] = [
      ["not json at all {", /not a valid argument graph/],
      [{ ...bad, version: 2 }, /version/],
      [{ ...bad, arguments: [{ ...bad.arguments[0], title: "   " }] }, /title/],
      [{ ...bad, arguments: [bad.arguments[0], bad.arguments[0]] }, /duplicate argument id/],
      [{ ...bad, edges: [{ from: "a", to: "ghost", role: "grounds" }] }, /unknown argument/],
      [{ ...bad, edges: [{ from: "a", to: "a", role: "grounds" }] }, /self-loop/],
      [
        {
          ...bad,
          arguments: [bad.arguments[0], { ...bad.arguments[0], id: "b" }],
          edges: [
            { from: "a", to: "b", role: "grounds" },
            { from: "a", to: "b", role: "grounds" },
          ],
        },
        /duplicate grounds edge/,
      ],
      [{ ...bad, arguments: [{ ...bad.arguments[0], claim: "x".repeat(20_001) }] }, /claim/],
    ];
    for (const [body, pattern] of cases) {
      const res = await put(KNOWN_WORK_ID, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toMatch(pattern);
    }
    expect(existsSync(argumentGraphDir(dataDir))).toBe(false);
  });

  test("a body for another Work is 400", async () => {
    const res = await put(KNOWN_WORK_ID, graphFor(SLASH_WORK_ID));
    expect(res.status).toBe(400);
  });

  test("cycles, End with out-edge and missing Toulmin text are stored (audit findings, not failures)", async () => {
    const g = graphFor(KNOWN_WORK_ID);
    const a = g.arguments[0] as ArgumentGraph["arguments"][number];
    const body: ArgumentGraph = {
      ...g,
      arguments: [
        { ...a, id: "a", kind: "end" },
        { ...a, id: "b", kind: "native" },
      ],
      edges: [
        { from: "a", to: "b", role: "grounds" },
        { from: "b", to: "a", role: "warrant" },
      ],
    };
    const res = await put(KNOWN_WORK_ID, body);
    expect(res.status).toBe(200);
  });

  test("a corrupt stored file is 500 and is not overwritten", async () => {
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    writeFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "{ not json");
    const res = await put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID));
    expect(res.status).toBe(500);
    expect(readFileSync(argumentGraphPath(dataDir, KNOWN_WORK_ID), "utf8")).toBe("{ not json");
    expect(messages.filter((m) => m.type === "argument-graph.changed")).toHaveLength(0);
  });

  test("403 on an evil Origin (CSRF guard)", async () => {
    const res = await put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID), {
      Origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(existsSync(argumentGraphDir(dataDir))).toBe(false);
  });

  test("concurrent writers with the same rev: exactly one wins, the other gets 409", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        put(KNOWN_WORK_ID, graphFor(KNOWN_WORK_ID, 0, `writer ${i}`))
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
    expect(((await (await get(KNOWN_WORK_ID)).json()) as ArgumentGraph).rev).toBe(1);
  });
});

describe("Docs do not own the graph", () => {
  test("deleting a Doc globally leaves the graph file byte-identical", async () => {
    const paths = libraryPaths(dataDir);
    const store = LibraryStore.load(paths);
    const work = store.get(SLASH_WORK_ID);
    if (work) work.doc_ids = ["demo"];
    store.save(paths);
    await put(SLASH_WORK_ID, graphFor(SLASH_WORK_ID));
    const file = argumentGraphPath(dataDir, SLASH_WORK_ID);
    const before = readFileSync(file, "utf8");
    const res = await app.request("/api/paper/demo", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(dataDir, "output", "demo"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(await (await get(SLASH_WORK_ID)).json()).toEqual(graphFor(SLASH_WORK_ID, 1));
  });
});
