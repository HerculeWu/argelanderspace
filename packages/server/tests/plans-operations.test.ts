/**
 * Narrow Plan operations (copilot ticket 09): the shared seam the Copilot `plan` tool uses next to the
 * UI's whole-document PUT. Real lock, real plans.json in a temp status dir; no model involved.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  moveToColumn,
  type PlansFile,
  type PlanWriteOperation,
  reorderWithinStatus,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import {
  applyPlanDelete,
  applyPlanOperation,
  describeDeleteTarget,
  type PlanOpDeps,
  type PlanOpOutcome,
  restoreDeletedTask,
} from "../src/plans-actions.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const task = (id: string, status: string, extra: object = {}) => ({
  id: `t_${id}`,
  title: `Task ${id}`,
  status,
  due: "2026-11-01",
  links: [],
  focused: false,
  created_at: "2026-10-01T00:00:00.000Z",
  ...extra,
});
const SEED = {
  version: 1,
  rev: 4,
  x_top: { keep: "top" },
  plans: [
    {
      id: "p_aaaaaaaa",
      name: "Alpha",
      due: "2026-12-01",
      icon: "target",
      created_at: "2026-10-01T00:00:00.000Z",
      x_plan: [1, 2],
      tasks: [
        task("00000001", "todo", { x_task: "keep-1" }),
        task("00000002", "doing"),
        task("00000003", "todo", { note: "user note" }),
        task("00000004", "done"),
      ],
    },
    {
      id: "p_bbbbbbbb",
      name: "Beta",
      due: "2026-12-02",
      icon: "target",
      created_at: "2026-10-01T00:00:00.000Z",
      tasks: [task("00000009", "todo")],
    },
  ],
};

let statusDir: string;
let changed: number;
let deps: PlanOpDeps;
const disk = () => readFileSync(plansPath(statusDir), "utf8");
const parsed = () => JSON.parse(disk());
const run = (op: PlanWriteOperation) => applyPlanOperation(deps, op);
const ok = <T extends PlanOpOutcome>(outcome: T) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.status}`);
  return outcome as Extract<T, { ok: true }>;
};

beforeEach(() => {
  statusDir = mkdtempSync(join(tmpdir(), "plan-ops-"));
  writeFileSync(plansPath(statusDir), JSON.stringify(SEED, null, 2));
  changed = 0;
  deps = {
    statusDir,
    planLock: new AsyncLock(),
    onChanged: () => {
      changed++;
    },
    docExists: (id) => id === "arxiv-known",
  };
});

describe("narrow edits keep what they do not name", () => {
  test("update_task changes only named fields; unknown keys, other tasks and order survive", async () => {
    const before = parsed();
    const result = ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        status: "doing",
        note: "  agent **note** $x_1$  ",
      })
    );
    expect(result).toMatchObject({
      status: "ok",
      rev: 5,
      object: { kind: "task", id: "t_00000001" },
    });
    const after = parsed();
    expect(after.rev).toBe(5);
    expect(after.x_top).toEqual({ keep: "top" });
    expect(after.plans[0].x_plan).toEqual([1, 2]);
    expect(after.plans[0].tasks[0]).toEqual({
      ...before.plans[0].tasks[0],
      status: "doing",
      note: "agent **note** $x_1$",
    });
    expect(after.plans[0].tasks.slice(1)).toEqual(before.plans[0].tasks.slice(1));
    expect(after.plans[1]).toEqual(before.plans[1]);
    expect(changed).toBe(1);
  });

  test("an empty note clears it like the drawer editor, other tasks keep theirs", async () => {
    ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000003",
        note: "   ",
      })
    );
    const after = parsed();
    expect(after.plans[0].tasks[2]).not.toHaveProperty("note");
  });

  test("a noop edit neither writes nor bumps rev nor notifies", async () => {
    const before = disk();
    const result = ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        status: "doing",
      })
    );
    expect(result.status).toBe("noop");
    expect(disk()).toBe(before);
    expect(changed).toBe(0);
  });
});

describe("stale and failed submissions", () => {
  test("a stale rev is rejected inside the lock with the current rev; bytes untouched; reread then succeeds", async () => {
    const before = disk();
    const stale = await run({
      action: "update_task",
      expectedRev: 3,
      planId: "p_aaaaaaaa",
      taskId: "t_00000001",
      title: "Late",
    });
    expect(stale).toMatchObject({ ok: false, status: "conflict", currentRev: 4 });
    expect(disk()).toBe(before);
    expect(changed).toBe(0);
    ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        title: "Fresh",
      })
    );
    expect(parsed().plans[0].tasks[0].title).toBe("Fresh");
  });

  test("a UI PUT and an agent edit racing on the same rev: exactly one wins, no lost update", async () => {
    const results = await Promise.all([
      run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        title: "Agent",
      }),
      run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        title: "Other",
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.status === "conflict")).toHaveLength(1);
    expect(parsed().rev).toBe(5);
  });

  test("unknown plan/task are not_found and write nothing", async () => {
    const before = disk();
    expect(
      await run({ action: "update_plan", expectedRev: 4, planId: "p_00000000", name: "x" })
    ).toMatchObject({ ok: false, status: "not_found" });
    expect(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_ffffffff",
        title: "x",
      })
    ).toMatchObject({ ok: false, status: "not_found" });
    expect(disk()).toBe(before);
  });

  test("a storage failure throws, keeps the original bytes and sends no notification", async () => {
    mkdirSync(`${plansPath(statusDir)}.tmp`); // a directory where the temp file goes
    const before = disk();
    await expect(
      run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        title: "x",
      })
    ).rejects.toThrow();
    expect(disk()).toBe(before);
    expect(changed).toBe(0);
  });

  test("the tool accepts the same lengths the UI and stored schema accept", async () => {
    const long = "x".repeat(6000);
    ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        title: long,
        note: long.repeat(30),
      })
    );
    ok(
      await run({
        action: "create_plan",
        expectedRev: 5,
        name: long,
        due: "2026-12-03",
        desc: long,
      })
    );
    expect(parsed().plans[0].tasks[0].title).toBe(long);
  });

  test("invalid parameters never reach the store (closed schema, no delete, no cross-plan move)", async () => {
    const before = disk();
    for (const bad of [
      { action: "delete_task", expectedRev: 4, planId: "p_aaaaaaaa", taskId: "t_00000001" },
      {
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        due: "tomorrow",
      },
      { action: "update_plan", expectedRev: 4, planId: "p_aaaaaaaa", icon: "not-one-of-eight" },
      {
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        layout: "board",
        status: "done",
        toPlanId: "p_bbbbbbbb",
      },
      {
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        id: "t_deadbeef",
      },
    ])
      await expect(run(bad as unknown as PlanWriteOperation)).rejects.toThrow();
    expect(disk()).toBe(before);
  });
});

describe("sparse documents and notification failure", () => {
  const sparse = () => {
    const doc = structuredClone(SEED) as Record<string, unknown>;
    const plans = doc.plans as Record<string, unknown>[];
    delete plans[1]?.tasks; // schema default [] — legal on disk
    writeFileSync(plansPath(statusDir), JSON.stringify(doc, null, 2));
  };
  test("create_task on a plan without a tasks key writes the default array; move_task there is not_found, not a crash", async () => {
    sparse();
    const before = disk();
    expect(
      await run({
        action: "move_task",
        expectedRev: 4,
        planId: "p_bbbbbbbb",
        taskId: "t_00000009",
        layout: "board",
        status: "done",
      })
    ).toMatchObject({ ok: false, status: "not_found" });
    expect(disk()).toBe(before);
    const created = ok(
      await run({ action: "create_task", expectedRev: 4, planId: "p_bbbbbbbb", title: "First" })
    );
    expect(created.status).toBe("ok");
    expect(parsed().plans[1].tasks).toHaveLength(1);
    expect(parsed().plans[1].tasks[0].title).toBe("First");
  });
  test("a notification failure after a committed write still reports the committed write", async () => {
    deps.onChanged = () => {
      throw new Error("broadcast failed");
    };
    const result = ok(
      await run({
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        title: "Saved",
      })
    );
    expect(result.status).toBe("ok");
    expect(result.warnings).toContain("change_notification_failed");
    expect(parsed().plans[0].tasks[0].title).toBe("Saved");
  });
});

describe("create, links, due warning", () => {
  test("create_plan/create_task use UI defaults; a task due after the plan only warns", async () => {
    const plan = ok(
      await run({
        action: "create_plan",
        expectedRev: 4,
        name: " Gamma ",
        due: "2026-12-03",
        desc: " d ",
      })
    );
    const created = parsed().plans[2];
    expect(created).toMatchObject({
      name: "Gamma",
      desc: "d",
      icon: "target",
      due: "2026-12-03",
      tasks: [],
    });
    const t1 = ok(
      await run({ action: "create_task", expectedRev: plan.rev, planId: created.id, title: "T" })
    );
    const t2 = ok(
      await run({
        action: "create_task",
        expectedRev: t1.rev,
        planId: created.id,
        title: "Late",
        status: "blocked",
        due: "2027-01-01",
      })
    );
    const tasks = parsed().plans[2].tasks;
    expect(tasks[0]).toMatchObject({
      title: "T",
      status: "todo",
      due: "2026-12-03",
      links: [],
      focused: false,
    });
    expect(tasks[1]).toMatchObject({ status: "blocked", due: "2027-01-01" });
    expect(t1.warnings).toBeUndefined();
    expect(t2.warnings).toEqual(["task_due_after_plan_due"]);
  });

  test("create_task takes the same optional note as update_task: trimmed and stored, blank leaves none (copilot ticket 62)", async () => {
    const withNote = ok(
      await run({
        action: "create_task",
        expectedRev: 4,
        planId: "p_bbbbbbbb",
        title: "Noted",
        note: "  Read $x_1$ first  ",
      })
    );
    expect(withNote.status).toBe("ok");
    const blank = ok(
      await run({
        action: "create_task",
        expectedRev: withNote.rev,
        planId: "p_bbbbbbbb",
        title: "Blank",
        note: "   ",
      })
    );
    const plain = ok(
      await run({
        action: "create_task",
        expectedRev: blank.rev,
        planId: "p_bbbbbbbb",
        title: "Plain",
      })
    );
    expect(plain.rev).toBe(7);
    const tasks = parsed().plans[1].tasks;
    expect(tasks[1]).toMatchObject({ title: "Noted", note: "Read $x_1$ first", status: "todo" });
    expect("note" in tasks[2]).toBe(false);
    expect("note" in tasks[3]).toBe(false);
  });

  test("links: only library Docs can be added, duplicates are noops, a vanished Doc can still be removed", async () => {
    expect(
      await run({
        action: "add_task_link",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        docId: "nope",
      })
    ).toMatchObject({ ok: false, status: "rejected" });
    const added = ok(
      await run({
        action: "add_task_link",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        docId: "arxiv-known",
      })
    );
    expect(parsed().plans[0].tasks[0].links).toEqual([{ doc_id: "arxiv-known" }]);
    expect(
      ok(
        await run({
          action: "add_task_link",
          expectedRev: added.rev,
          planId: "p_aaaaaaaa",
          taskId: "t_00000001",
          docId: "arxiv-known",
        })
      ).status
    ).toBe("noop");
    deps.docExists = () => false;
    ok(
      await run({
        action: "remove_task_link",
        expectedRev: added.rev,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        docId: "arxiv-known",
      })
    );
    expect(parsed().plans[0].tasks[0].links).toEqual([]);
  });
});

describe("ordering keeps the UI rules", () => {
  test("list: only within one status group; cross-status is rejected and writes nothing", async () => {
    const before = disk();
    expect(
      await run({
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        layout: "list",
        overTaskId: "t_00000002",
      })
    ).toMatchObject({ ok: false, status: "rejected", detail: "cross_status" });
    expect(disk()).toBe(before);
    ok(
      await run({
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000003",
        layout: "list",
        overTaskId: "t_00000001",
      })
    );
    expect(parsed().plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
      "t_00000003",
      "t_00000002",
      "t_00000001",
      "t_00000004",
    ]);
  });

  test("board: cross-column changes status and position; same position is a noop without a rev bump", async () => {
    ok(
      await run({
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        layout: "board",
        status: "doing",
        overTaskId: null,
      })
    );
    const tasks = parsed().plans[0].tasks;
    expect(tasks.map((t: { id: string; status: string }) => `${t.id}:${t.status}`)).toEqual([
      "t_00000002:doing",
      "t_00000001:doing",
      "t_00000003:todo",
      "t_00000004:done",
    ]);
    expect(tasks.find((t: { id: string }) => t.id === "t_00000001").x_task).toBe("keep-1");
    expect(tasks.find((t: { id: string }) => t.id === "t_00000001").status).toBe("doing");
    const before = disk();
    const noop = ok(
      await run({
        action: "move_task",
        expectedRev: 5,
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        layout: "board",
        status: "doing",
      })
    );
    expect(noop.status).toBe("noop");
    expect(disk()).toBe(before);
  });

  test("a task in another plan cannot be moved through this plan", async () => {
    expect(
      await run({
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000009",
        layout: "board",
        status: "done",
      })
    ).toMatchObject({ ok: false, status: "not_found" });
  });
});

describe("the UI whole-document PUT and the operation produce the same stored plan", () => {
  const makeApp = () => {
    const dataDir = makeDataDir();
    const dir = mkdtempSync(join(tmpdir(), "plan-ops-ui-"));
    writeFileSync(plansPath(dir), JSON.stringify(SEED, null, 2));
    const events: string[] = [];
    const app = createApp({
      paths: libraryPaths(dataDir),
      statusDir: dir,
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      broadcast: (m) => events.push(m.type),
    });
    return { app, dir, events };
  };
  const uiEdit = async (edit: (file: PlansFile) => PlansFile) => {
    const { app, dir, events } = makeApp();
    const current = (await (await app.request("/api/plans")).json()) as PlansFile;
    const res = await app.request("/api/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit(current)),
    });
    expect(res.status).toBe(200);
    return { json: JSON.parse(readFileSync(plansPath(dir), "utf8")), events };
  };
  const agentEdit = async (op: PlanWriteOperation) => {
    const { dir } = makeApp();
    let notified = 0;
    ok(await applyPlanOperation({ ...deps, statusDir: dir, onChanged: () => notified++ }, op));
    return { json: JSON.parse(readFileSync(plansPath(dir), "utf8")), notified };
  };
  /** Compare ignoring unknown keys (the PUT path strips them, the agent path keeps them). */
  const known = (doc: PlansFile) =>
    JSON.parse(JSON.stringify(doc, (key, value) => (key.startsWith("x_") ? undefined : value)));

  test.each([
    [
      "status+due+title",
      {
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        status: "blocked",
        due: "2026-12-24",
        title: "Renamed",
      } as PlanWriteOperation,
      (f: PlansFile) => ({
        ...f,
        plans: f.plans.map((p) =>
          p.id !== "p_aaaaaaaa"
            ? p
            : {
                ...p,
                tasks: p.tasks.map((t) =>
                  t.id === "t_00000002"
                    ? { ...t, status: "blocked" as const, due: "2026-12-24", title: "Renamed" }
                    : t
                ),
              }
        ),
      }),
    ],
    [
      "pin",
      {
        action: "update_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000003",
        focused: true,
      } as PlanWriteOperation,
      (f: PlansFile) => ({
        ...f,
        plans: f.plans.map((p) =>
          p.id !== "p_aaaaaaaa"
            ? p
            : {
                ...p,
                tasks: p.tasks.map((t) => (t.id === "t_00000003" ? { ...t, focused: true } : t)),
              }
        ),
      }),
    ],
    [
      "list reorder",
      {
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000003",
        layout: "list",
        overTaskId: "t_00000001",
      } as PlanWriteOperation,
      (f: PlansFile) => ({
        ...f,
        plans: f.plans.map((p) =>
          p.id !== "p_aaaaaaaa"
            ? p
            : { ...p, tasks: reorderWithinStatus(p.tasks, "todo", "t_00000003", "t_00000001") }
        ),
      }),
    ],
    [
      "board drop",
      {
        action: "move_task",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
        taskId: "t_00000004",
        layout: "board",
        status: "todo",
        overTaskId: "t_00000003",
      } as PlanWriteOperation,
      (f: PlansFile) => ({
        ...f,
        plans: f.plans.map((p) =>
          p.id !== "p_aaaaaaaa"
            ? p
            : { ...p, tasks: moveToColumn(p.tasks, "t_00000004", "todo", "t_00000003") }
        ),
      }),
    ],
  ])("%s", async (_name, op, edit) => {
    const ui = await uiEdit(edit);
    const agent = await agentEdit(op);
    expect(known(agent.json)).toEqual(known(ui.json));
    expect(agent.json.rev).toBe(ui.json.rev);
    expect(ui.events).toContain("plan.changed");
    expect(agent.notified).toBe(1);
  });
});

describe("the shared delete handler (executed only after a real confirmation)", () => {
  test("delete_task removes exactly that task, keeps everything else and unknown keys, and returns the undo handle", async () => {
    const before = parsed();
    const outcome = ok(
      await applyPlanDelete(deps, {
        action: "delete_task",
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        baseRev: 4,
      })
    );
    expect(outcome).toMatchObject({ status: "ok", rev: 5, label: "Task 00000002" });
    expect(outcome.removed).toMatchObject({ index: 1, raw: { id: "t_00000002", status: "doing" } });
    const after = parsed();
    expect(after.rev).toBe(5);
    expect(after.x_top).toEqual({ keep: "top" });
    expect(after.plans[0].x_plan).toEqual([1, 2]);
    expect(after.plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
      "t_00000001",
      "t_00000003",
      "t_00000004",
    ]);
    expect(after.plans[0].tasks[0]).toEqual(before.plans[0].tasks[0]);
    expect(after.plans[1]).toEqual(before.plans[1]);
    expect(changed).toBe(1);
  });

  test("delete_plan removes the plan with its tasks and keeps the other plan byte-for-byte", async () => {
    const before = parsed();
    ok(await applyPlanDelete(deps, { action: "delete_plan", planId: "p_aaaaaaaa", baseRev: 4 }));
    const after = parsed();
    expect(after.plans).toEqual([before.plans[1]]);
    expect(after.rev).toBe(5);
    expect(after.x_top).toEqual({ keep: "top" });
  });

  test("a changed rev, a missing object or an unknown action writes nothing", async () => {
    const bytes = disk();
    expect(
      await applyPlanDelete(deps, { action: "delete_plan", planId: "p_aaaaaaaa", baseRev: 3 })
    ).toMatchObject({ ok: false, status: "conflict", currentRev: 4 });
    expect(
      await applyPlanDelete(deps, { action: "delete_plan", planId: "p_cccccccc", baseRev: 4 })
    ).toMatchObject({ ok: false, status: "not_found" });
    expect(
      await applyPlanDelete(deps, {
        action: "delete_task",
        planId: "p_aaaaaaaa",
        taskId: "t_99999999",
        baseRev: 4,
      })
    ).toMatchObject({ ok: false, status: "not_found" });
    await expect(
      applyPlanDelete(deps, { action: "update_task", planId: "p_aaaaaaaa", baseRev: 4 } as never)
    ).rejects.toThrow();
    expect(disk()).toBe(bytes);
    expect(changed).toBe(0);
  });

  test("the confirmation is not an applyPlanOperation action: the write path cannot delete", async () => {
    await expect(
      applyPlanOperation(deps, {
        action: "delete_plan",
        expectedRev: 4,
        planId: "p_aaaaaaaa",
      } as never)
    ).rejects.toThrow();
  });

  test("describeDeleteTarget reports the impact the confirmation card states", () => {
    const described = describeDeleteTarget(statusDir, {
      action: "delete_plan",
      planId: "p_aaaaaaaa",
    });
    expect(described?.objectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect({ ...described, objectDigest: undefined }).toEqual({
      objectDigest: undefined,
      rev: 4,
      kind: "plan",
      label: "Alpha",
      planName: "Alpha",
      impact: { tasks: 4, openTasks: 3 },
    });
    expect(
      describeDeleteTarget(statusDir, {
        action: "delete_task",
        planId: "p_aaaaaaaa",
        taskId: "t_00000004",
      })
    ).toEqual({
      objectDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rev: 4,
      kind: "task",
      label: "Task 00000004",
      planName: "Alpha",
      impact: { tasks: 1, openTasks: 0 },
    });
    expect(describeDeleteTarget(statusDir, { action: "delete_plan", planId: "p_none" })).toBeNull();
  });

  test("a delete bound to a content digest is refused when the stored object changed without a rev bump", async () => {
    const digest = describeDeleteTarget(statusDir, {
      action: "delete_plan",
      planId: "p_aaaaaaaa",
    })?.objectDigest;
    const edited = parsed();
    edited.plans[0].x_plan = "hand edit"; // unknown key, rev untouched
    writeFileSync(plansPath(statusDir), JSON.stringify(edited, null, 2));
    const bytes = disk();
    expect(
      await applyPlanDelete(deps, {
        action: "delete_plan",
        planId: "p_aaaaaaaa",
        baseRev: 4,
        objectDigest: digest,
      })
    ).toMatchObject({ ok: false, status: "conflict" });
    expect(disk()).toBe(bytes);
    expect(changed).toBe(0);
  });

  test("undo puts the task back at its index with its unknown keys, once, and leaves later edits alone", async () => {
    const before = parsed();
    const removed = ok(
      await applyPlanDelete(deps, {
        action: "delete_task",
        planId: "p_aaaaaaaa",
        taskId: "t_00000001",
        baseRev: 4,
      })
    ).removed;
    if (!removed) throw new Error("no undo handle");
    // The user changes something else in between; undo must not roll that back.
    ok(
      await run({
        action: "update_task",
        expectedRev: 5,
        planId: "p_aaaaaaaa",
        taskId: "t_00000003",
        status: "blocked",
      })
    );
    const restored = ok(await restoreDeletedTask(deps, { planId: "p_aaaaaaaa", ...removed }));
    expect(restored.status).toBe("ok");
    const after = parsed();
    expect(after.plans[0].tasks[0]).toEqual(before.plans[0].tasks[0]);
    expect(after.plans[0].tasks[2].status).toBe("blocked");
    expect(after.rev).toBe(7);
    // A second undo finds the task back: no change, no rev bump.
    expect(ok(await restoreDeletedTask(deps, { planId: "p_aaaaaaaa", ...removed })).status).toBe(
      "noop"
    );
    expect(parsed().rev).toBe(7);
    // The plan is gone: nothing to restore into.
    ok(await applyPlanDelete(deps, { action: "delete_plan", planId: "p_aaaaaaaa", baseRev: 7 }));
    expect(await restoreDeletedTask(deps, { planId: "p_aaaaaaaa", ...removed })).toMatchObject({
      ok: false,
      status: "not_found",
    });
  });

  test("the UI whole-document PUT delete and the shared handler store the same plan document", async () => {
    const dataDir = makeDataDir();
    const uiDir = mkdtempSync(join(tmpdir(), "plan-del-ui-"));
    writeFileSync(plansPath(uiDir), JSON.stringify(SEED, null, 2));
    const app = createApp({
      paths: libraryPaths(dataDir),
      statusDir: uiDir,
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    });
    const current = (await (await app.request("/api/plans")).json()) as PlansFile;
    const edited = {
      ...current,
      plans: current.plans.map((p) =>
        p.id === "p_aaaaaaaa" ? { ...p, tasks: p.tasks.filter((t) => t.id !== "t_00000002") } : p
      ),
    };
    const put = await app.request("/api/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edited),
    });
    expect(put.status).toBe(200);
    ok(
      await applyPlanDelete(deps, {
        action: "delete_task",
        planId: "p_aaaaaaaa",
        taskId: "t_00000002",
        baseRev: 4,
      })
    );
    const strip = (doc: unknown) =>
      JSON.parse(JSON.stringify(doc, (key, value) => (key.startsWith("x_") ? undefined : value)));
    expect(strip(JSON.parse(readFileSync(plansPath(uiDir), "utf8")))).toEqual(strip(parsed()));
  });
});
