/**
 * Confirmation cards raised through the CLI (release-0.2 ticket 04): the external requests queue, its routes for the
 * page, and `library.delete_doc` on the workbench's operation route. The five outcomes of a cataloged operation with
 * `confirm: "card"` - approved, denied, withdrawn (the CLI left), the workbench closing, no workbench running - and
 * the delete's semantics agreeing with Copilot's `delete_doc` (global physical delete, annotations with it, the next
 * Doc becomes main). The Copilot side is `copilot-doc-delete.test.ts`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExternalRequest,
  OPERATION_CATALOG,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { ExternalRequestQueue } from "../src/external-requests.js";
import { JobRunner } from "../src/jobs.js";
import { createLocalOperationRuntime } from "../src/local-operations.js";
import { runCatalogOperation } from "../src/operation-catalog.js";
import { createServer } from "../src/server.js";
import { runOnWorkbench } from "../src/workbench-instance.js";
import {
  collectBroadcasts,
  isolatedGlobalDirs,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";

const SECOND_WORK_ID = "doi:10.1051/0004-6361/202453302";
const TOKEN = "t".repeat(64);
const CLIENT = { pid: 4242, commandLine: "argelanderspace library delete-doc --doc-id demo" };
const ORIGIN = { Origin: "http://localhost:5173" };

let dataDir: string;
let paths: LibraryPaths;
let app: Hono;
let messages: WsServerMessage[];

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collector.broadcast,
    operations: { token: TOKEN },
  });
  // "demo" is work A's main Doc and work B's second Doc (as in doc-delete.test.ts).
  const store = LibraryStore.load(paths);
  const a = store.get(KNOWN_WORK_ID);
  if (a) a.doc_ids = ["demo", "2603.03522", "arxiv-2603.03522"];
  const b = store.get(SECOND_WORK_ID);
  if (b) b.doc_ids = ["aa53302-24", "demo"];
  store.save(paths);
  saveAnnotationsFile(dataDir, "demo", {
    version: 1,
    rev: 3,
    content_fingerprint: "f".repeat(64),
    annotations: [
      {
        id: "a_0123abcd",
        target: { type: "document" },
        body: "goes with the Doc",
        created_at: "2026-09-10T10:00:00.000Z",
        updated_at: "2026-09-10T10:00:00.000Z",
      },
    ],
  });
  mkdirSync(join(dataDir, "annotations", "demo", "archive"), { recursive: true });
  writeFileSync(
    join(dataDir, "annotations", "demo", "archive", "20260901T000000000Z-eeeeeeee.json"),
    "{}"
  );
});

afterEach(() => {
  rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

/** The CLI's request: held until the card is decided. `signal` is the CLI leaving. */
function runOperation(
  docId: string,
  signal?: AbortSignal,
  client: object | null = CLIENT
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/operations/run", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: "library.delete_doc",
        params: { docId },
        ...(client ? { client } : {}),
      }),
      ...(signal ? { signal } : {}),
    })
  );
}
const queue = async (): Promise<ExternalRequest[]> =>
  ((await (await app.request("/api/external-requests")).json()) as { requests: ExternalRequest[] })
    .requests;
const decide = (
  id: string,
  decision: "approve" | "deny",
  headers: Record<string, string> = ORIGIN
) =>
  app.request(`/api/external-requests/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ decision }),
  });
async function waitForQueue(count: number): Promise<ExternalRequest[]> {
  for (let i = 0; i < 200; i++) {
    const requests = await queue();
    if (requests.length === count) return requests;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the queue never reached ${count} requests`);
}
const onDisk = (docId: string) => existsSync(join(dataDir, "output", docId));

test("the catalog lists delete_doc as a write that waits for a card", () => {
  const op = OPERATION_CATALOG.find((entry) => entry.id === "library.delete_doc");
  expect(op?.confirm).toBe("card");
  expect(op?.effect).toBe("write");
});

test("approved: the card shows the Doc as Copilot's does, nothing is deleted until the click, then the Doc goes everywhere", async () => {
  const held = runOperation("demo");
  const [request] = await waitForQueue(1);
  expect(request).toMatchObject({ state: "pending", client: CLIENT });
  expect(request?.card).toMatchObject({
    action: "delete_doc",
    object: { kind: "doc", id: "demo" },
    format: "latex",
    // the fixture Doc is a stub the annotation count cannot be read for: unknown, never zero (as Copilot's card)
    impact: { annotations: "unknown" },
  });
  expect(
    ((request as ExternalRequest).card as { works: { id: string }[] }).works.map((w) => w.id).sort()
  ).toEqual([KNOWN_WORK_ID, SECOND_WORK_ID].sort());
  // The request is still held and nothing has been deleted.
  expect(onDisk("demo")).toBe(true);
  expect(messages.some((m) => m.type === "external-requests.changed")).toBe(true);

  const decision = await decide((request as ExternalRequest).id, "approve");
  expect(decision.status).toBe(200);
  const body = (await decision.json()) as {
    state: string;
    result: { ok: boolean; works: { id: string; remaining: string[] }[] };
  };
  expect(body.state).toBe("approved");
  expect(body.result.ok).toBe(true);

  const answer = await held;
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ ok: true, status: "ok", docId: "demo" });
  // Copilot's semantics: output and annotations (archive included) gone, Doc taken out of EVERY work, the next Doc is main.
  expect(onDisk("demo")).toBe(false);
  expect(existsSync(join(dataDir, "annotations", "demo"))).toBe(false);
  const store = LibraryStore.load(paths);
  expect(store.get(KNOWN_WORK_ID)?.doc_ids).toEqual(["2603.03522", "arxiv-2603.03522"]);
  expect(store.get(SECOND_WORK_ID)?.doc_ids).toEqual(["aa53302-24"]);
  expect(messages.some((m) => m.type === "library.changed")).toBe(true);
  expect(await queue()).toEqual([]);
});

test("denied: the CLI receives status denied, nothing is deleted", async () => {
  const held = runOperation("demo");
  const [request] = await waitForQueue(1);
  const decision = await decide((request as ExternalRequest).id, "deny");
  expect(await decision.json()).toEqual({ state: "denied" });
  const answer = await held;
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ ok: false, status: "denied" });
  expect(onDisk("demo")).toBe(true);
  expect(existsSync(join(dataDir, "annotations", "demo", "current.json"))).toBe(true);
  expect(await queue()).toEqual([]);
});

test("withdrawn: the CLI leaving withdraws the card; it can never be approved and the Doc stays", async () => {
  const leave = new AbortController();
  const held = runOperation("demo", leave.signal);
  const [request] = await waitForQueue(1);
  leave.abort();
  await held.catch(() => {});
  const [withdrawn] = await waitForQueue(1);
  expect(withdrawn).toMatchObject({ id: request?.id, state: "withdrawn" });
  // A click on a withdrawn card is refused by the server; nothing is deleted.
  const refused = await decide((request as ExternalRequest).id, "approve");
  expect(refused.status).toBe(409);
  expect(onDisk("demo")).toBe(true);
  // The user closes it.
  const closed = await app.request(`/api/external-requests/${request?.id}/dismiss`, {
    method: "POST",
    headers: ORIGIN,
  });
  expect(closed.status).toBe(200);
  expect(await queue()).toEqual([]);
});

test("a decision needs a browser page: no Origin header is refused, and the pending card is untouched", async () => {
  const leave = new AbortController();
  const held = runOperation("demo", leave.signal);
  const [request] = await waitForQueue(1);
  expect((await decide((request as ExternalRequest).id, "approve", {})).status).toBe(403);
  expect(
    (await app.request(`/api/external-requests/${request?.id}/dismiss`, { method: "POST" })).status
  ).toBe(403);
  expect((await queue())[0]?.state).toBe("pending");
  leave.abort();
  await held.catch(() => {});
});

test("only the earliest card is decided, in arrival order; a later withdrawn one goes by itself", async () => {
  const q = new ExternalRequestQueue({ onChanged: () => {}, lingerMs: 20 });
  const card = (id: string) => ({
    action: "delete_doc" as const,
    object: { kind: "doc" as const, id },
    format: "latex" as const,
    works: [],
    impact: { annotations: "unknown" as const },
    baseRev: 0,
    objectDigest: "d",
  });
  const first = q.ask({ card: card("one") });
  const leave = new AbortController();
  const second = q.ask({ card: card("two"), signal: leave.signal });
  const third = q.ask({ card: card("three") });
  const ids = q.list().map((r) => r.id);
  expect(q.list().map((r) => (r.card as { object: { id: string } }).object.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
  expect(await q.decide(ids[1] as string, "approve")).toEqual({ kind: "not_first" });
  expect(await q.decide("00000000-0000-4000-8000-000000000000", "deny")).toEqual({ kind: "gone" });
  leave.abort();
  expect((await second)?.answer).toBe("withdrawn");
  expect(q.list()[1]?.state).toBe("withdrawn");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(q.list().map((r) => r.id)).toEqual([ids[0], ids[2]]);
  expect(await q.decide(ids[0] as string, "deny")).toEqual({ kind: "decided", decision: "deny" });
  expect((await first)?.answer).toBe("denied");
  expect(await q.decide(ids[2] as string, "deny")).toEqual({ kind: "decided", decision: "deny" });
  expect((await third)?.answer).toBe("denied");
  // A withdrawn card in front stays until closed, however long it waits.
  const lone = new AbortController();
  q.ask({ card: card("four"), signal: lone.signal });
  lone.abort();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(q.list()).toHaveLength(1);
  expect(q.dismiss(q.list()[0]?.id as string)).toBe(true);
});

test("a request already abandoned puts up no card, and the queue refuses more than it can hold", async () => {
  const q = new ExternalRequestQueue({ onChanged: () => {}, max: 2 });
  const card = {
    action: "delete_doc" as const,
    object: { kind: "doc" as const, id: "x" },
    format: "latex" as const,
    works: [],
    impact: { annotations: "unknown" as const },
    baseRev: 0,
    objectDigest: "d",
  };
  const gone = new AbortController();
  gone.abort();
  expect((await q.ask({ card, signal: gone.signal }))?.answer).toBe("withdrawn");
  expect(q.list()).toEqual([]);
  q.ask({ card });
  q.ask({ card });
  expect(q.ask({ card })).toBeNull();
});

test("a Doc the dialog would not offer is refused before any card: not_found, no card", async () => {
  const answer = await runOperation("no-such-doc");
  expect(await answer.json()).toMatchObject({ ok: false, status: "not_found" });
  expect(await queue()).toEqual([]);
});

test("without a workbench to show the card, the operation refuses and deletes nothing (in-process runtime)", async () => {
  const result = await runCatalogOperation(
    createLocalOperationRuntime(paths),
    "library.delete_doc",
    { docId: "demo" }
  );
  expect(result).toMatchObject({ ok: false });
  expect(onDisk("demo")).toBe(true);
});

test("the card is drawn from what the dialog shows, and the click rechecks it: a change in between expires the delete", async () => {
  const held = runOperation("demo");
  const [request] = await waitForQueue(1);
  // The Doc's works change after the card was shown (a main Doc change counts): the approval deletes nothing.
  const store = LibraryStore.load(paths);
  const b = store.get(SECOND_WORK_ID);
  if (b) b.doc_ids = ["demo", "aa53302-24"];
  store.save(paths);
  const decision = await decide((request as ExternalRequest).id, "approve");
  const body = (await decision.json()) as {
    state: string;
    result: { ok: boolean; status: string };
  };
  expect(body.state).toBe("approved");
  expect(body.result).toMatchObject({ ok: false, status: "expired" });
  expect(await (await held).json()).toMatchObject({ ok: false, status: "expired" });
  expect(onDisk("demo")).toBe(true);
});

/** The two outcomes that need a real socket: the CLI's connection going away, and the workbench itself exiting. */
async function liveWorkbench() {
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    operationToken: TOKEN,
  });
  const port = await srv.ready();
  const list = async () =>
    (
      (await (await fetch(`http://127.0.0.1:${port}/api/external-requests`)).json()) as {
        requests: ExternalRequest[];
      }
    ).requests;
  const until = async (state: string) => {
    for (let i = 0; i < 200; i++) {
      const requests = await list();
      if (requests[0]?.state === state) return requests;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no request reached ${state}`);
  };
  return { srv, port, until, list };
}

test("over a real socket: the CLI aborting its request withdraws the card (Ctrl-C)", async () => {
  const { srv, port, until } = await liveWorkbench();
  try {
    const leave = new AbortController();
    const held = runOnWorkbench(
      { port, token: TOKEN },
      { id: "library.delete_doc", params: { docId: "demo" }, client: CLIENT },
      leave.signal
    );
    const [pending] = await until("pending");
    expect(pending?.client).toEqual(CLIENT);
    leave.abort();
    await expect(held).rejects.toThrow();
    await until("withdrawn");
    expect(onDisk("demo")).toBe(true);
  } finally {
    await srv.close();
  }
});

test("over a real socket: the workbench closing while a card waits drops the CLI's connection and deletes nothing", async () => {
  const { srv, port, until } = await liveWorkbench();
  const held = runOnWorkbench(
    { port, token: TOKEN },
    { id: "library.delete_doc", params: { docId: "demo" }, client: CLIENT }
  );
  const settled = held.then(
    () => "answered",
    () => "dropped"
  );
  await until("pending");
  await srv.close();
  expect(await settled).toBe("dropped");
  expect(onDisk("demo")).toBe(true);
});
