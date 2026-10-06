/**
 * The one task-delete undo (copilot ticket 33 follow-up): a registry of restorable deletes beside the plans
 * store, used by the Copilot tool, the Copilot panel and the Plan page. Real lock, real plans.json in a temp dir.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_UNDO_WINDOW_MS } from "@argelanderspace/contracts";
import { plansPath } from "@argelanderspace/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AsyncLock } from "../src/lock.js";
import { applyPlanDelete, applyPlanOperation, type PlanOpDeps } from "../src/plans-actions.js";
import { TaskUndoRegistry } from "../src/plans-undo.js";

const task = (n: number, extra: object = {}) => ({
  id: `t_${String(n).padStart(8, "0")}`,
  title: `Task ${n}`,
  status: "todo",
  due: "2026-11-01",
  links: [],
  focused: false,
  created_at: "2026-10-01T00:00:00.000Z",
  ...extra,
});
const SEED = {
  version: 1,
  rev: 4,
  plans: [
    {
      id: "p_aaaaaaaa",
      name: "Alpha",
      due: "2026-12-01",
      icon: "target",
      created_at: "2026-10-01T00:00:00.000Z",
      tasks: [task(1, { x_task: "keep" }), task(2), task(3)],
    },
  ],
};
const FIRST_TASK = SEED.plans[0]?.tasks[0];
let statusDir: string;
let deps: PlanOpDeps;
let registry: TaskUndoRegistry;
const parsed = () => JSON.parse(readFileSync(plansPath(statusDir), "utf8"));

async function deleteFirst(baseRev = 4) {
  const outcome = await applyPlanDelete(deps, {
    action: "delete_task",
    planId: "p_aaaaaaaa",
    taskId: "t_00000001",
    baseRev,
  });
  if (!outcome.ok || !outcome.removed) throw new Error("delete failed");
  return registry.register({
    planId: "p_aaaaaaaa",
    taskId: "t_00000001",
    title: "Task 1",
    removed: outcome.removed,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T10:00:00.000Z"));
  statusDir = mkdtempSync(join(tmpdir(), "plan-undo-"));
  writeFileSync(plansPath(statusDir), JSON.stringify(SEED, null, 2));
  deps = { statusDir, planLock: new AsyncLock(), onChanged: () => {}, docExists: () => true };
  registry = new TaskUndoRegistry();
});
afterEach(() => vi.useRealTimers());

test("the window is eight seconds", async () => {
  expect(TASK_UNDO_WINDOW_MS).toBe(8000);
  const entry = await deleteFirst();
  expect(entry.until - Date.now()).toBe(8000);
});

test("undo inside the window puts the task back at its index with its unknown keys, once", async () => {
  const entry = await deleteFirst();
  vi.advanceTimersByTime(7900);
  const result = await registry.undo(deps, { id: entry.id });
  expect(result).toMatchObject({ ok: true, status: "ok", object: { id: "t_00000001" } });
  expect(parsed().plans[0].tasks[0]).toEqual(FIRST_TASK);
  // Used up: the same handle is gone, nothing is written twice.
  expect(await registry.undo(deps, { id: entry.id })).toMatchObject({
    ok: false,
    status: "not_found",
  });
  expect(parsed().rev).toBe(6);
});

test("undo after eight seconds is refused as expired and writes nothing", async () => {
  const entry = await deleteFirst();
  const bytes = readFileSync(plansPath(statusDir), "utf8");
  vi.advanceTimersByTime(8001);
  expect(await registry.undo(deps, { id: entry.id })).toMatchObject({
    ok: false,
    status: "expired",
  });
  expect(readFileSync(plansPath(statusDir), "utf8")).toBe(bytes);
  // Still reported as expired (not as unknown) for a while, so the model and the page can say why.
  expect(await registry.undo(deps, { planId: "p_aaaaaaaa", taskId: "t_00000001" })).toMatchObject({
    status: "expired",
  });
  expect(registry.active()).toEqual([]);
});

test("undo after the plan was deleted is a conflict and writes nothing", async () => {
  const entry = await deleteFirst();
  const edit = await applyPlanOperation(deps, {
    action: "update_task",
    expectedRev: 5,
    planId: "p_aaaaaaaa",
    taskId: "t_00000003",
    status: "blocked",
  });
  expect(edit.ok).toBe(true);
  await applyPlanDelete(deps, { action: "delete_plan", planId: "p_aaaaaaaa", baseRev: 6 });
  const bytes = readFileSync(plansPath(statusDir), "utf8");
  expect(await registry.undo(deps, { id: entry.id })).toMatchObject({
    ok: false,
    status: "conflict",
  });
  expect(readFileSync(plansPath(statusDir), "utf8")).toBe(bytes);
});

test("an unrelated edit in between is kept and the task is still restored", async () => {
  const entry = await deleteFirst();
  await applyPlanOperation(deps, {
    action: "update_task",
    expectedRev: 5,
    planId: "p_aaaaaaaa",
    taskId: "t_00000003",
    status: "blocked",
  });
  expect(await registry.undo(deps, { id: entry.id })).toMatchObject({ ok: true, status: "ok" });
  const after = parsed().plans[0].tasks;
  expect(after.map((t: { id: string }) => t.id)).toEqual([
    "t_00000001",
    "t_00000002",
    "t_00000003",
  ]);
  expect(after[2].status).toBe("blocked");
});

test("a task that is already back (restored by another route) is a noop and writes nothing", async () => {
  const entry = await deleteFirst();
  const doc = parsed();
  doc.plans[0].tasks.unshift(FIRST_TASK);
  writeFileSync(plansPath(statusDir), JSON.stringify(doc, null, 2));
  const bytes = readFileSync(plansPath(statusDir), "utf8");
  expect(await registry.undo(deps, { id: entry.id })).toMatchObject({ ok: true, status: "noop" });
  expect(readFileSync(plansPath(statusDir), "utf8")).toBe(bytes);
});

test("active() lists only deletes still inside the window, newest handle per task", async () => {
  const entry = await deleteFirst();
  expect(registry.active().map((e) => e.id)).toEqual([entry.id]);
  vi.advanceTimersByTime(8001);
  expect(registry.active()).toEqual([]);
});
