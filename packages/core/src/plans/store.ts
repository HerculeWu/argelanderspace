/**
 * The plan-page store (`<statusDir>/plans.json`) — Stage 4 MS1.
 *
 * `statusDir` always sits next to the effective data dir (default
 * `./literatures` → `./status`; resolved by the server in MS2). The file is
 * the single source of truth for the plan page and the Stage-4.1 agent
 * surface, so it is pretty-printed (2 spaces, git-diff/agent friendly) and
 * written atomically (tmp + rename, same pattern as `library/store.ts`).
 *
 * `rev` is the persisted optimistic-lock version: the PUT path checks
 * `body.rev === current.rev` and then saves with `{ bumpRev: true }` (rev+1
 * on disk).
 *
 * Writes assume the single-user setup with the server serializing mutations
 * (planLock, MS2): the fixed tmp name is not safe for concurrent writers.
 *
 * `Task.due` became required with the Stage-4 smoke ruling; `loadPlans`
 * migrates pre-smoke files on read (a due-less task inherits its plan's due)
 * — in-memory only, persisted by the next save. See {@link migrateTaskDue}.
 *
 * The CRUD helpers are pure: they never mutate the input `PlansFile`, they
 * return a new one, and they never touch `rev` (bumping is a save-time
 * concern). Unknown plan/task ids and duplicate-id inserts throw — a silent
 * no-op would hide a stale client.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Plan, type PlansFile, PlansFileSchema, type Task } from "@argelanderspace/contracts";

// --------------------------------------------------------------------------- //
// Load / save
// --------------------------------------------------------------------------- //

export function plansPath(statusDir: string): string {
  return join(statusDir, "plans.json");
}

/** The document for a missing `plans.json`. */
export function emptyPlansFile(): PlansFile {
  return { version: 1, rev: 0, plans: [] };
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/**
 * Pre-schema migration for pre-Stage-4-smoke files (`Task.due` was optional
 * until the smoke ruling made it required): a task whose `due` is missing
 * (or not a string) inherits its parent plan's `due` (plan.due is required
 * and always present). In-memory only — no rev bump, no write; the next PUT
 * persists the migrated form. Malformed shapes are passed through untouched
 * so schema validation reports them as before.
 */
function migrateTaskDue(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const doc = data as Record<string, unknown>;
  if (!Array.isArray(doc.plans)) return data;
  const plans = doc.plans.map((p) => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return p;
    const plan = p as Record<string, unknown>;
    if (typeof plan.due !== "string" || !Array.isArray(plan.tasks)) return p;
    let changed = false;
    const tasks = plan.tasks.map((t) => {
      if (t === null || typeof t !== "object" || Array.isArray(t)) return t;
      const task = t as Record<string, unknown>;
      if (typeof task.due === "string") return t;
      changed = true;
      return { ...task, due: plan.due };
    });
    return changed ? { ...plan, tasks } : p;
  });
  return { ...doc, plans };
}

/**
 * Read `<statusDir>/plans.json`. A missing file yields the empty document;
 * corrupt JSON or a schema-invalid document throws (never silently reset —
 * the file may be the user's only copy).
 */
export function loadPlans(statusDir: string): PlansFile {
  const file = plansPath(statusDir);
  if (!existsSync(file)) return emptyPlansFile();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`plans store: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = PlansFileSchema.safeParse(migrateTaskDue(data));
  if (!result.success) {
    throw new Error(`plans store: ${file} failed schema validation: ${formatIssues(result.error)}`);
  }
  return result.data;
}

export interface SavePlansOptions {
  /** Persist `file.rev + 1` instead of `file.rev` (the PUT optimistic-lock path). */
  bumpRev?: boolean;
}

/**
 * Write `<statusDir>/plans.json` atomically (tmp + rename, 2-space pretty
 * print), creating `statusDir` if needed. Refuses to write a document that
 * doesn't validate against `PlansFileSchema`.
 */
export function savePlans(statusDir: string, file: PlansFile, opts: SavePlansOptions = {}): void {
  const out: PlansFile = opts.bumpRev ? { ...file, rev: file.rev + 1 } : file;
  const result = PlansFileSchema.safeParse(out);
  if (!result.success) {
    throw new Error(
      `plans store: refusing to write an invalid PlansFile: ${formatIssues(result.error)}`
    );
  }
  mkdirSync(statusDir, { recursive: true });
  const file_ = plansPath(statusDir);
  const tmp = file_.replace(/\.json$/, ".json.tmp");
  writeFileSync(tmp, JSON.stringify(result.data, null, 2), "utf8");
  renameSync(tmp, file_);
}

// --------------------------------------------------------------------------- //
// Id generation
// --------------------------------------------------------------------------- //

/** `p_<8 hex>` plan id (crypto.randomBytes — agent-stable, Stage 4.1). */
export function newPlanId(): string {
  return `p_${randomBytes(4).toString("hex")}`;
}

/** `t_<8 hex>` task id (crypto.randomBytes — agent-stable, Stage 4.1). */
export function newTaskId(): string {
  return `t_${randomBytes(4).toString("hex")}`;
}

// --------------------------------------------------------------------------- //
// CRUD helpers (pure: input untouched, new PlansFile returned)
// --------------------------------------------------------------------------- //

function planIndex(file: PlansFile, planId: string): number {
  const i = file.plans.findIndex((p) => p.id === planId);
  if (i < 0) throw new Error(`plans store: no plan with id ${planId}`);
  return i;
}

function taskIndex(plan: Plan, taskId: string): number {
  const i = plan.tasks.findIndex((t) => t.id === taskId);
  if (i < 0) throw new Error(`plans store: no task with id ${taskId} in plan ${plan.id}`);
  return i;
}

/** Append *plan*; throws on a duplicate plan id. */
export function addPlan(file: PlansFile, plan: Plan): PlansFile {
  if (file.plans.some((p) => p.id === plan.id)) {
    throw new Error(`plans store: duplicate plan id ${plan.id}`);
  }
  return { ...file, plans: [...file.plans, plan] };
}

/** Merge *patch* over the named plan (id and tasks are preserved). */
export function updatePlan(
  file: PlansFile,
  planId: string,
  patch: Partial<Omit<Plan, "id" | "tasks">>
): PlansFile {
  const i = planIndex(file, planId);
  const plans = [...file.plans];
  plans[i] = { ...(plans[i] as Plan), ...patch };
  return { ...file, plans };
}

export function deletePlan(file: PlansFile, planId: string): PlansFile {
  const i = planIndex(file, planId);
  return { ...file, plans: file.plans.filter((_, j) => j !== i) };
}

/** Append *task* to the named plan; throws on a duplicate task id. */
export function addTask(file: PlansFile, planId: string, task: Task): PlansFile {
  const i = planIndex(file, planId);
  const plan = file.plans[i] as Plan;
  if (plan.tasks.some((t) => t.id === task.id)) {
    throw new Error(`plans store: duplicate task id ${task.id} in plan ${planId}`);
  }
  const plans = [...file.plans];
  plans[i] = { ...plan, tasks: [...plan.tasks, task] };
  return { ...file, plans };
}

/** Merge *patch* over the named task (id is preserved). */
export function updateTask(
  file: PlansFile,
  planId: string,
  taskId: string,
  patch: Partial<Omit<Task, "id">>
): PlansFile {
  const i = planIndex(file, planId);
  const plan = file.plans[i] as Plan;
  const tasks = [...plan.tasks];
  const j = taskIndex(plan, taskId);
  tasks[j] = { ...(tasks[j] as Task), ...patch };
  const plans = [...file.plans];
  plans[i] = { ...plan, tasks };
  return { ...file, plans };
}

export function deleteTask(file: PlansFile, planId: string, taskId: string): PlansFile {
  const i = planIndex(file, planId);
  const plan = file.plans[i] as Plan;
  const j = taskIndex(plan, taskId);
  const plans = [...file.plans];
  plans[i] = { ...plan, tasks: plan.tasks.filter((_, k) => k !== j) };
  return { ...file, plans };
}

/**
 * Reorder a task inside its plan (`fromIndex` → `toIndex`; the array order IS
 * the display order). Out-of-range or non-integer indices are REJECTED
 * (throw) rather than clamped — they mean the caller acted on a stale row.
 * `fromIndex === toIndex` is a no-op returning the input unchanged.
 */
export function moveTask(
  file: PlansFile,
  planId: string,
  fromIndex: number,
  toIndex: number
): PlansFile {
  const i = planIndex(file, planId);
  const plan = file.plans[i] as Plan;
  const n = plan.tasks.length;
  const inRange = (k: number) => Number.isInteger(k) && k >= 0 && k < n;
  if (!inRange(fromIndex) || !inRange(toIndex)) {
    throw new Error(
      `plans store: moveTask out of range (from=${fromIndex}, to=${toIndex}, plan ${planId} has ${n} tasks)`
    );
  }
  if (fromIndex === toIndex) return file;
  const tasks = [...plan.tasks];
  const [moved] = tasks.splice(fromIndex, 1);
  tasks.splice(toIndex, 0, moved as Task);
  const plans = [...file.plans];
  plans[i] = { ...plan, tasks };
  return { ...file, plans };
}
