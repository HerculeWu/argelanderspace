/**
 * `plan undo_delete_task` as a journaled write (spec 8.3): a repeated operationId returns the first result without
 * writing again, and a crash between the save and the result reads back as `unknown` on resume. Real lock, real
 * plans.json in a temp dir, the tool's own execute; the journal is a small in-memory port.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotOperation } from "@argelanderspace/contracts";
import { plansPath } from "@argelanderspace/core";
import { beforeEach, expect, test } from "vitest";
import { createPlanTool } from "../src/copilot-plan-tool.js";
import { digest, type KnownOperation, type OperationJournalPort } from "../src/copilot-tool-kit.js";
import { AsyncLock } from "../src/lock.js";
import { applyPlanDelete, type PlanOpDeps } from "../src/plans-actions.js";
import { TaskUndoRegistry } from "../src/plans-undo.js";

const task = (n: number) => ({
  id: `t_${String(n).padStart(8, "0")}`,
  title: `Task ${n}`,
  status: "todo",
  due: "2026-11-01",
  links: [],
  focused: false,
  created_at: "2026-10-01T00:00:00.000Z",
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
      tasks: [task(1), task(2)],
    },
  ],
};
const call = { action: "undo_delete_task", planId: "p_aaaaaaaa", taskId: "t_00000001" };

let statusDir: string;
let deps: PlanOpDeps;
let registry: TaskUndoRegistry;
let known: Map<string, KnownOperation>;
let begins: number;
const journal = (): OperationJournalPort => ({
  lookup: (id) => known.get(id) ?? null,
  begin: (entry) => {
    begins++;
    known.set(entry.operationId, { state: "begun", hash: entry.hash });
  },
  done: (id, payload, operation: CopilotOperation) => {
    const current = known.get(id);
    known.set(id, { state: "done", hash: current?.hash ?? "", payload, operation });
  },
});
const tool = () =>
  createPlanTool({
    plans: deps,
    journal: journal(),
    taskUndo: registry,
    viewAction: async () => ({ status: "unavailable" }) as never,
    admitting: () => true,
    runId: "run1",
  });
const run = (id: string, params: Record<string, unknown>) =>
  tool().execute(id, params as never, undefined as never, undefined as never, undefined as never);
const bytes = () => readFileSync(plansPath(statusDir), "utf8");

beforeEach(async () => {
  statusDir = mkdtempSync(join(tmpdir(), "plan-undo-tool-"));
  writeFileSync(plansPath(statusDir), JSON.stringify(SEED, null, 2));
  deps = { statusDir, planLock: new AsyncLock(), onChanged: () => {}, docExists: () => true };
  registry = new TaskUndoRegistry();
  known = new Map();
  begins = 0;
  const outcome = await applyPlanDelete(deps, {
    action: "delete_task",
    planId: "p_aaaaaaaa",
    taskId: "t_00000001",
    baseRev: 4,
  });
  if (!outcome.ok || !outcome.removed) throw new Error("delete failed");
  registry.register({
    planId: "p_aaaaaaaa",
    taskId: "t_00000001",
    title: "Task 1",
    removed: outcome.removed,
  });
});

test("the undo is journaled: begin before the write, done after, and the operation row carries the result", async () => {
  const result = await run("c1", { ...call, operationId: "op-1" });
  expect(result.details).toMatchObject({ action: "undo_delete_task", status: "ok" });
  expect(begins).toBe(1);
  expect(known.get("op-1")?.state).toBe("done");
  expect(JSON.parse(bytes()).plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
    "t_00000001",
    "t_00000002",
  ]);
});

test("a repeated operationId returns the first result and writes nothing again", async () => {
  const first = await run("c1", { ...call, operationId: "op-1" });
  const after = bytes();
  const again = await run("c2", { ...call, operationId: "op-1" });
  expect(again.details).toMatchObject({
    status: "ok",
    rev: (first.details as { rev?: number }).rev,
  });
  expect(
    JSON.parse(again.content[0]?.type === "text" ? again.content[0].text : "{}")
  ).toMatchObject({
    duplicate: true,
  });
  expect(bytes()).toBe(after);
  expect(begins).toBe(1);
});

test("a crash between the save and the result: the resumed call reports unknown, never ok and never a rewrite", async () => {
  // what the journal holds after a crash: begun, never done (the task may or may not be back)
  known.set("op-9", { state: "begun", hash: digest(call) });
  const before = bytes();
  const resumed = await run("c3", { ...call, operationId: "op-9" });
  expect(resumed.details).toMatchObject({ status: "unknown" });
  expect(bytes()).toBe(before);
  expect(begins).toBe(0);
});

test("the same operationId for a different request is rejected", async () => {
  await run("c1", { ...call, operationId: "op-1" });
  const other = await run("c2", { ...call, taskId: "t_00000002", operationId: "op-1" });
  expect(other.details).toMatchObject({ status: "rejected" });
});

test("a second undo of the same task (another operationId) says it is already back: noop, never an invitation to re-create", async () => {
  await run("c1", { ...call, operationId: "op-1" });
  const second = await run("c2", { ...call, operationId: "op-2" });
  expect(second.details).toMatchObject({ status: "noop" });
});
