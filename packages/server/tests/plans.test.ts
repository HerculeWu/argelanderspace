/**
 * The plan-page REST endpoints (Stage 4 MS2): `GET /api/plans` whole-document
 * reads against `<statusDir>/plans.json`, and `PUT /api/plans` whole-document
 * replace with the persisted `rev` optimistic lock (mismatch → 409 with the
 * current rev), serialized on the dedicated planLock, broadcasting
 * `plan.changed` on success. Hermetic: tmp data/status dirs, Hono
 * `app.request` (no socket). CSRF coverage lives with the other mutations in
 * api.test.ts; the over-the-wire broadcast in ws.test.ts.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlansFile } from "@argelanderspace/contracts";
import { libraryPaths, loadPlans, plansPath, savePlans } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

let dataDir: string;
let statusDir: string;
let app: Hono;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

beforeEach(() => {
  dataDir = makeDataDir();
  statusDir = statusDirFor(dataDir);
  const runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
  });
});

const get = async (path: string): Promise<Response> => app.request(path);
const put = async (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A schema-valid document with one plan + one task. */
const RICH_FILE: PlansFile = {
  version: 1,
  rev: 0,
  plans: [
    {
      id: "p_89abcdef",
      name: "Stage 4 计划页面",
      desc: "webui 完整可交互 CRUD",
      due: "2026-09-30",
      icon: "rocket",
      created_at: "2026-09-02T10:00:00.000Z",
      tasks: [
        {
          id: "t_0123abcd",
          title: "读 2501.17225",
          status: "doing",
          due: "2026-09-10",
          links: [{ doc_id: "arxiv-2501.17225" }],
          focused: true,
          created_at: "2026-09-02T10:00:00.000Z",
        },
      ],
    },
  ],
};

describe("GET /api/plans", () => {
  test("no plans.json → the empty document", async () => {
    const res = await get("/api/plans");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, rev: 0, plans: [] });
  });

  test("an existing plans.json is returned as-is", async () => {
    savePlans(statusDir, { ...RICH_FILE, rev: 4 });
    const res = await get("/api/plans");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...RICH_FILE, rev: 4 });
  });

  test("a corrupt plans.json surfaces as a 500 (never a silent reset)", async () => {
    savePlans(statusDir, { version: 1, rev: 0, plans: [] }); // create the dir first
    writeFileSync(plansPath(statusDir), "{ not json");
    const res = await get("/api/plans");
    expect(res.status).toBe(500);
  });

  test("valid JSON but schema-invalid plans.json surfaces as a 500", async () => {
    savePlans(statusDir, { version: 1, rev: 0, plans: [] }); // create the dir first
    writeFileSync(plansPath(statusDir), JSON.stringify({ version: 2, rev: 0, plans: [] }));
    const res = await get("/api/plans");
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/plans", () => {
  test("valid body + matching rev → 200, rev+1 on disk, plan.changed(put) broadcast", async () => {
    const res = await put("/api/plans", RICH_FILE);
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated).toEqual({ ...RICH_FILE, rev: 1 });
    // …and what landed on disk is exactly that updated document
    expect(loadPlans(statusDir)).toEqual({ ...RICH_FILE, rev: 1 });
    // …and WS clients heard about it (plans domain only)
    const changed = messages.filter((m) => m.type === "plan.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ type: "plan.changed", cause: "put" });
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);
    // a follow-up GET reflects the new rev
    expect((await (await get("/api/plans")).json()) as Record<string, unknown>).toEqual(updated);
  });

  test("rev mismatch → 409 carrying the current rev; nothing written, no broadcast", async () => {
    savePlans(statusDir, { version: 1, rev: 3, plans: [] });
    const res = await put("/api/plans", RICH_FILE); // body.rev 0 ≠ current 3
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "rev mismatch", rev: 3 });
    expect(loadPlans(statusDir)).toEqual({ version: 1, rev: 3, plans: [] });
    expect(messages).toHaveLength(0);
  });

  test("schema-invalid body → 400 without echoing values; nothing written", async () => {
    const res = await put("/api/plans", { version: 2, rev: 0, plans: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "request body is not a valid plans document" });
    expect(loadPlans(statusDir)).toEqual({ version: 1, rev: 0, plans: [] });
    expect(messages).toHaveLength(0);
  });

  test("a malformed task inside an otherwise-valid body → 400", async () => {
    const bad = {
      version: 1,
      rev: 0,
      plans: [{ ...RICH_FILE.plans[0], tasks: [{ id: "t_0123abcd", status: "nope" }] }],
    };
    const res = await put("/api/plans", bad);
    expect(res.status).toBe(400);
  });

  test("non-JSON body → 400", async () => {
    const res = await put("/api/plans", "{ not json");
    expect(res.status).toBe(400);
  });

  test("planLock serializes concurrent PUTs: exactly one wins the rev race", async () => {
    const [a, b] = await Promise.all([put("/api/plans", RICH_FILE), put("/api/plans", RICH_FILE)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(loadPlans(statusDir).rev).toBe(1); // a single bump, never two
    expect(messages.filter((m) => m.type === "plan.changed")).toHaveLength(1);
  });

  test("corrupt plans.json on disk during PUT → 500, and the lock is not wedged", async () => {
    savePlans(statusDir, { version: 1, rev: 0, plans: [] });
    writeFileSync(plansPath(statusDir), "{ not json");
    const res = await put("/api/plans", RICH_FILE);
    expect(res.status).toBe(500);
    expect(messages).toHaveLength(0);
    // the lock survives the throw: repair the file and a PUT goes through
    savePlans(statusDir, { version: 1, rev: 0, plans: [] });
    expect((await put("/api/plans", RICH_FILE)).status).toBe(200);
  });
});
