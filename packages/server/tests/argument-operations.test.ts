/**
 * The argument graph in the operation catalog (release-0.2 ticket 08): the business operations the Copilot `argument`
 * tool and the page share, now also `argelanderspace argument <op>`. Both paths (the running workbench's route and the
 * command's own process) answer alike; a write on a stale rev is a conflict that carries the latest graph; replacing or
 * clearing a graph that has arguments waits for the user's card - approved, denied, withdrawn, expired - and with no
 * workbench is refused without writing. The Copilot side of the same operations is `argument-operations-parity.test.ts`.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { argumentGraphPath, libraryPaths, loadArgumentGraph } from "@argelanderspace/core";
import { afterEach, expect, test } from "vitest";
import { ExternalRequestQueue } from "../src/external-requests.js";
import {
  createLocalOperationRuntime,
  createServer,
  newWorkbenchToken,
  type OperationRuntime,
  type RunningServer,
  runCatalogOperation,
  runOnWorkbench,
} from "../src/index.js";
import { isolatedGlobalDirs, stubSources } from "./helpers.js";

const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aspace-argops-"));
  roots.push(root);
  const dir = join(root, "data");
  mkdirSync(join(dir, "library"), { recursive: true });
  cpSync(
    join(import.meta.dirname, "..", "..", "core", "tests", "fixtures", "library.json"),
    join(dir, "library", "library.json")
  );
  return dir;
}

const draft = (title: string) => ({
  title,
  claim: `claim of ${title}`,
  grounds: `grounds of ${title}`,
  warrant: `warrant of ${title}`,
});
const body = (...ids: string[]) => ({
  arguments: ids.map((id) => ({ id, ...draft(id) })),
  edges: ids.slice(1).map((id, i) => ({ from: id, to: ids[i], role: "grounds" })),
});
const fileText = (dir: string) => {
  try {
    return readFileSync(argumentGraphPath(dir, WORK), "utf8");
  } catch {
    return "";
  }
};
const resultOf = (id: string) => OPERATION_CATALOG.find((op) => op.id === id)?.result;
/** A CLI command has no memory of an earlier one: a runtime per call. */
const inProcess = (dir: string) => createLocalOperationRuntime(libraryPaths(dir));
// biome-ignore lint/suspicious/noExplicitAny: answers are read by shape, field by field
type Answer = Record<string, any>;

async function run(
  dir: string,
  id: string,
  params: Record<string, unknown>,
  runtime: OperationRuntime = inProcess(dir)
) {
  const answer = (await runCatalogOperation(runtime, id as never, params)) as Answer;
  expect(resultOf(id)?.safeParse(answer).success, JSON.stringify(answer).slice(0, 400)).toBe(true);
  return answer;
}

async function workbench(dir: string) {
  const token = newWorkbenchToken();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir: dir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    operationToken: token,
  });
  servers.push(srv);
  const port = await srv.ready();
  return { port, token };
}

test("the catalog holds the argument operations, and not the interface actions or the Copilot's own guide", () => {
  const names = OPERATION_CATALOG.filter((op) => op.domain === "argument").map((op) => op.name);
  expect(names).toEqual([
    "open",
    "read",
    "create",
    "update",
    "delete",
    "undo_delete",
    "add_edge",
    "remove_edge",
    "replace",
    "clear",
  ]);
  for (const ui of ["select", "exit", "guide", "select_argument", "exit_argument_graph"])
    expect(names).not.toContain(ui);
  const confirm = Object.fromEntries(
    OPERATION_CATALOG.filter((op) => op.domain === "argument").map((op) => [op.name, op.confirm])
  );
  expect(confirm).toMatchObject({ replace: "conditional", clear: "conditional", create: "none" });
});

test("the workbench's route and the command's own process answer alike, answers of ok:false included", async () => {
  const viaRouteDir = fixtureDataDir();
  const localDir = fixtureDataDir();
  const { port, token } = await workbench(viaRouteDir);
  const steps: [string, Record<string, unknown>][] = [
    ["argument.read", { workId: WORK }],
    ["argument.create", { workId: WORK, expectedRev: 0, id: "a", argument: draft("A") }],
    ["argument.create", { workId: WORK, expectedRev: 1, id: "b", argument: draft("B") }],
    ["argument.add_edge", { workId: WORK, expectedRev: 2, from: "a", to: "b", role: "grounds" }],
    // refused edits: nothing written, same words
    ["argument.add_edge", { workId: WORK, expectedRev: 3, from: "a", to: "b", role: "grounds" }],
    ["argument.add_edge", { workId: WORK, expectedRev: 3, from: "a", to: "a", role: "warrant" }],
    ["argument.update", { workId: WORK, expectedRev: 3, id: "ghost", patch: { claim: "x" } }],
    ["argument.update", { workId: WORK, expectedRev: 3, id: "a", patch: { title: "   " } }],
    // a stale rev is a conflict that carries the latest graph
    ["argument.update", { workId: WORK, expectedRev: 1, id: "a", patch: { claim: "x" } }],
    ["argument.update", { workId: WORK, expectedRev: 3, id: "a", patch: { claim: "new claim" } }],
    ["argument.read", { workId: WORK }],
    ["argument.read", { workId: WORK, ids: ["a", "ghost"] }],
    ["argument.read", { workId: WORK, ids: ["a"], field: "claim", offset: 4 }],
    ["argument.read", { workId: WORK, ids: ["a"], field: "claim", offset: 9999 }],
    ["argument.read", { workId: WORK, field: "claim" }],
    ["argument.remove_edge", { workId: WORK, expectedRev: 4, from: "a", to: "b", role: "grounds" }],
    ["argument.remove_edge", { workId: WORK, expectedRev: 5, from: "a", to: "b", role: "grounds" }],
    ["argument.delete", { workId: WORK, expectedRev: 5, id: "b" }],
    ["argument.read", { workId: "no-such-work" }],
    ["argument.create", { workId: "no-such-work", expectedRev: 0, argument: draft("Z") }],
  ];
  for (const [id, params] of steps) {
    const viaRoute = await runOnWorkbench({ port, token }, { id, params });
    const alone = await run(localDir, id, params);
    expect(viaRoute.status, id).toBe(200);
    expect(viaRoute.body, `${id} ${JSON.stringify(params)}`).toEqual(
      JSON.parse(JSON.stringify(alone))
    );
    expect(resultOf(id)?.safeParse(viaRoute.body).success).toBe(true);
  }
  // Both ended on the same file.
  expect(fileText(viaRouteDir)).toBe(fileText(localDir));
  expect(loadArgumentGraph(localDir, WORK).arguments.map((a) => a.id)).toEqual(["a"]);
});

test("a stale rev is a conflict: nothing written, the latest graph in the answer; a fresh rev then succeeds", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.create", {
    workId: WORK,
    expectedRev: 0,
    id: "a",
    argument: draft("A"),
  });
  const before = fileText(dir);
  const stale = await run(dir, "argument.create", {
    workId: WORK,
    expectedRev: 0,
    id: "b",
    argument: draft("B"),
  });
  expect(stale).toMatchObject({ ok: false, status: "conflict", currentRev: 1 });
  expect(stale.latest.arguments.map((a: { id: string }) => a.id)).toEqual(["a"]);
  expect(fileText(dir)).toBe(before);
  const fresh = await run(dir, "argument.create", {
    workId: WORK,
    expectedRev: stale.currentRev,
    id: "b",
    argument: draft("B"),
  });
  expect(fresh).toMatchObject({ ok: true, status: "ok", rev: 2, id: "b" });
});

test("undo_delete: the workbench remembers a delete for the next command, a command alone does not", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  const via = (id: string, params: Record<string, unknown>) =>
    runOnWorkbench({ port, token }, { id, params }).then((r) => r.body as Answer);
  await via("argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const deleted = await via("argument.delete", { workId: WORK, expectedRev: 1, id: "b" });
  expect(deleted).toMatchObject({ ok: true, rev: 2, removed: { id: "b", edges: 1 } });
  const back = await via("argument.undo_delete", { workId: WORK, expectedRev: 2, id: "b" });
  expect(back).toMatchObject({
    ok: true,
    status: "ok",
    rev: 3,
    counts: { arguments: 2, edges: 1 },
  });
  // A command alone has no such memory.
  const alone = await run(fixtureDataDir(), "argument.undo_delete", {
    workId: WORK,
    expectedRev: 0,
    id: "b",
  });
  expect(alone).toMatchObject({ ok: false, status: "not_found" });
});

test("replace into a graph without arguments, and clear of an empty one, need no card and no workbench", async () => {
  const dir = fixtureDataDir();
  expect(await run(dir, "argument.clear", { workId: WORK, expectedRev: 0 })).toMatchObject({
    ok: true,
    status: "noop",
  });
  const replaced = await run(dir, "argument.replace", {
    workId: WORK,
    expectedRev: 0,
    graph: body("a", "b"),
  });
  expect(replaced).toMatchObject({
    ok: true,
    status: "ok",
    rev: 1,
    counts: { arguments: 2, edges: 1 },
  });
  expect(loadArgumentGraph(dir, WORK).arguments).toHaveLength(2);
});

test("a graph that has arguments is not replaced or cleared without a workbench to show the card", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const before = fileText(dir);
  for (const [id, params] of [
    ["argument.replace", { workId: WORK, expectedRev: 1, graph: body("z") }],
    ["argument.clear", { workId: WORK, expectedRev: 1 }],
  ] as const) {
    const answer = await run(dir, id, params);
    expect(answer).toMatchObject({ ok: false, status: "workbench_required" });
    expect(fileText(dir)).toBe(before);
  }
});

function withCards(dir: string) {
  const queue = new ExternalRequestQueue({ onChanged: () => {} });
  const runtime = { ...createLocalOperationRuntime(libraryPaths(dir)), confirm: queue };
  const cardShown = async () => {
    for (let i = 0; i < 200; i++) {
      const front = queue.list()[0];
      if (front) return front;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no card was shown");
  };
  return { queue, runtime, cardShown };
}

test("replace of a graph that has arguments: the card shows what is lost and what comes; approved writes, and the click's result reaches the asker", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const { queue, runtime, cardShown } = withCards(dir);
  const waiting = runCatalogOperation(runtime, "argument.replace", {
    workId: WORK,
    expectedRev: 1,
    graph: body("x", "y", "z"),
  });
  const request = await cardShown();
  expect(request.client).toBeNull();
  expect(request.card).toMatchObject({
    action: "replace_argument_graph",
    mode: "replace",
    object: { kind: "work", id: WORK, workId: WORK },
    current: { arguments: 2, edges: 1 },
    next: { arguments: 3, edges: 2 },
    baseRev: 1,
  });
  // Nothing is written while the card waits.
  expect(loadArgumentGraph(dir, WORK).arguments.map((a) => a.id)).toEqual(["a", "b"]);
  const decided = await queue.decide(request.id, "approve");
  const answer = (await waiting) as Answer;
  expect(answer).toMatchObject({
    ok: true,
    status: "ok",
    rev: 2,
    counts: { arguments: 3, edges: 2 },
  });
  expect(decided).toMatchObject({ kind: "decided", decision: "approve", result: answer });
  expect(loadArgumentGraph(dir, WORK).arguments.map((a) => a.id)).toEqual(["x", "y", "z"]);
});

test("clear of a graph that has arguments asks the same card in clear mode", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const { queue, runtime, cardShown } = withCards(dir);
  const waiting = runCatalogOperation(runtime, "argument.clear", { workId: WORK, expectedRev: 1 });
  const request = await cardShown();
  expect(request.card).toMatchObject({
    action: "replace_argument_graph",
    mode: "clear",
    current: { arguments: 2, edges: 1 },
    next: { arguments: 0, edges: 0 },
  });
  await queue.decide(request.id, "approve");
  expect(await waiting).toMatchObject({
    ok: true,
    status: "ok",
    rev: 2,
    counts: { arguments: 0, edges: 0 },
  });
});

test("denied: the answer is denied and the graph is byte for byte as it was", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const before = fileText(dir);
  const { queue, runtime, cardShown } = withCards(dir);
  const waiting = runCatalogOperation(runtime, "argument.replace", {
    workId: WORK,
    expectedRev: 1,
    graph: body("x"),
  });
  await queue.decide((await cardShown()).id, "deny");
  expect(await waiting).toMatchObject({ ok: false, status: "denied" });
  expect(fileText(dir)).toBe(before);
});

test("withdrawn: the asker leaving ends the wait as interrupted and the card can never be approved", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const before = fileText(dir);
  const { queue, runtime, cardShown } = withCards(dir);
  const controller = new AbortController();
  const waiting = runCatalogOperation(
    runtime,
    "argument.replace",
    { workId: WORK, expectedRev: 1, graph: body("x") },
    { signal: controller.signal }
  );
  const request = await cardShown();
  controller.abort();
  expect(await waiting).toMatchObject({ ok: false, status: "interrupted" });
  expect(await queue.decide(request.id, "approve")).toMatchObject({ kind: "withdrawn" });
  expect(fileText(dir)).toBe(before);
});

test("expired: a change between the card and the click means nothing is written", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const { queue, runtime, cardShown } = withCards(dir);
  const waiting = runCatalogOperation(runtime, "argument.replace", {
    workId: WORK,
    expectedRev: 1,
    graph: body("x"),
  });
  const request = await cardShown();
  // The user edits the graph on the page while the card waits.
  await run(dir, "argument.update", {
    workId: WORK,
    expectedRev: 1,
    id: "a",
    patch: { claim: "edited" },
  });
  await queue.decide(request.id, "approve");
  expect(await waiting).toMatchObject({ ok: false, status: "expired" });
  const stored = loadArgumentGraph(dir, WORK);
  expect(stored.arguments.map((a) => a.id)).toEqual(["a", "b"]);
  expect(stored.arguments[0]?.claim).toBe("edited");
});

test("a bad proposal, a stale rev and a missing Work are refused before anyone is asked", async () => {
  const dir = fixtureDataDir();
  await run(dir, "argument.replace", { workId: WORK, expectedRev: 0, graph: body("a", "b") });
  const { queue, runtime } = withCards(dir);
  const dangling = await runCatalogOperation(runtime, "argument.replace", {
    workId: WORK,
    expectedRev: 1,
    graph: {
      arguments: [{ id: "a", title: "A" }],
      edges: [{ from: "a", to: "ghost", role: "grounds" }],
    },
  });
  expect(dangling).toMatchObject({ ok: false, status: "invalid" });
  expect((dangling as Answer).issues.length).toBeGreaterThan(0);
  expect(
    await runCatalogOperation(runtime, "argument.replace", {
      workId: WORK,
      expectedRev: 0,
      graph: body("x"),
    })
  ).toMatchObject({ ok: false, status: "conflict", currentRev: 1 });
  expect(
    await runCatalogOperation(runtime, "argument.clear", { workId: "no-such", expectedRev: 0 })
  ).toMatchObject({ ok: false, status: "not_found" });
  expect(queue.list()).toEqual([]);
});

test("through the workbench's route a replace waits on the external requests queue like a Doc delete", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  await runOnWorkbench(
    { port, token },
    {
      id: "argument.replace",
      params: { workId: WORK, expectedRev: 0, graph: body("a", "b") },
    }
  );
  const controller = new AbortController();
  const waiting = runOnWorkbench(
    { port, token },
    {
      id: "argument.replace",
      params: { workId: WORK, expectedRev: 1, graph: body("x") },
      client: { pid: 4242, commandLine: "argelanderspace argument replace --json plan.json" },
    },
    controller.signal
  );
  let front:
    | { id: string; client: { commandLine: string } | null; card: { action: string } }
    | undefined;
  for (let i = 0; i < 200 && !front; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/external-requests`)).json()) as {
      requests: NonNullable<typeof front>[];
    };
    front = list.requests[0];
    if (!front) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(front?.card.action).toBe("replace_argument_graph");
  expect(front?.client?.commandLine).toBe("argelanderspace argument replace --json plan.json");
  const decision = await fetch(
    `http://127.0.0.1:${port}/api/external-requests/${front?.id}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ decision: "approve" }),
    }
  );
  expect(decision.status).toBe(200);
  const done = await waiting;
  expect(done.status).toBe(200);
  expect(done.body).toMatchObject({ ok: true, status: "ok", rev: 2 });
  expect(loadArgumentGraph(dir, WORK).arguments.map((a) => a.id)).toEqual(["x"]);
});
