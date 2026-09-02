/**
 * The plan-page store (Stage 4 MS1): load/save against tmp dirs (no network,
 * no repo state), atomic-write behavior, error paths for corrupt/invalid
 * `plans.json`, rev bump semantics, id generation, and the pure CRUD helpers.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, PlansFile, Task } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import {
  addPlan,
  addTask,
  deletePlan,
  deleteTask,
  emptyPlansFile,
  loadPlans,
  moveTask,
  newPlanId,
  newTaskId,
  plansPath,
  savePlans,
  updatePlan,
  updateTask,
} from "../src/plans/store.js";

function tmpStatusDir(): string {
  return mkdtempSync(join(tmpdir(), "plans-store-"));
}

function mkTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    status: "todo",
    due: "2026-12-31",
    links: [],
    focused: false,
    created_at: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function mkPlan(id: string, tasks: Task[] = [], overrides: Partial<Plan> = {}): Plan {
  return {
    id,
    name: `plan ${id}`,
    due: "2026-12-31",
    icon: "target",
    created_at: "2026-09-02T10:00:00.000Z",
    tasks,
    ...overrides,
  };
}

function mkFile(plans: Plan[], rev = 0): PlansFile {
  return { version: 1, rev, plans };
}

// --------------------------------------------------------------------------- //
// load / save
// --------------------------------------------------------------------------- //

describe("loadPlans", () => {
  it("returns the empty document when plans.json does not exist", () => {
    expect(loadPlans(tmpStatusDir())).toEqual({ version: 1, rev: 0, plans: [] });
    expect(emptyPlansFile()).toEqual({ version: 1, rev: 0, plans: [] });
  });

  it("materializes schema defaults from a sparse on-disk document", () => {
    const dir = tmpStatusDir();
    writeFileSync(
      plansPath(dir),
      JSON.stringify({
        version: 1,
        rev: 2,
        plans: [
          {
            id: "p_89abcdef",
            name: "稀疏计划",
            due: "2026-12-31",
            created_at: "2026-09-02T10:00:00.000Z",
            tasks: [
              {
                id: "t_0123abcd",
                title: "稀疏任务",
                status: "done",
                focused: false,
                created_at: "2026-09-02T10:00:00.000Z",
              },
            ],
          },
        ],
      })
    );
    const loaded = loadPlans(dir);
    expect(loaded.plans[0]?.icon).toBe("target");
    expect(loaded.plans[0]?.tasks[0]?.links).toEqual([]);
  });

  it("migrates pre-smoke files: a due-less task inherits its plan's due (rev untouched)", () => {
    const dir = tmpStatusDir();
    writeFileSync(
      plansPath(dir),
      JSON.stringify({
        version: 1,
        rev: 3,
        plans: [
          {
            id: "p_89abcdef",
            name: "旧格式计划",
            due: "2026-11-15",
            icon: "target",
            created_at: "2026-09-02T10:00:00.000Z",
            tasks: [
              {
                // pre-smoke shape: no due at all
                id: "t_0123abcd",
                title: "无 due 旧任务",
                status: "todo",
                focused: false,
                created_at: "2026-09-02T10:00:00.000Z",
              },
              {
                // non-string due is migrated too
                id: "t_4567dead",
                title: "坏 due 任务",
                status: "doing",
                due: 123,
                focused: false,
                created_at: "2026-09-02T10:00:00.000Z",
              },
              {
                // a valid due is kept as-is
                id: "t_89abcdef",
                title: "正常任务",
                status: "done",
                due: "2026-09-20",
                focused: true,
                created_at: "2026-09-02T10:00:00.000Z",
              },
            ],
          },
        ],
      })
    );
    const loaded = loadPlans(dir);
    const tasks = loaded.plans[0]?.tasks ?? [];
    expect(tasks[0]?.due).toBe("2026-11-15"); // inherited from the plan
    expect(tasks[1]?.due).toBe("2026-11-15"); // non-string replaced
    expect(tasks[2]?.due).toBe("2026-09-20"); // valid one untouched
    expect(loaded.rev).toBe(3); // migration never bumps rev
    // …and nothing is persisted until the next save
    const onDisk = JSON.parse(readFileSync(plansPath(dir), "utf8")) as {
      plans: { tasks: { due?: unknown }[] }[];
    };
    expect(onDisk.plans[0]?.tasks[0]?.due).toBeUndefined();
    // the next save persists the migrated form
    savePlans(dir, loaded);
    const saved = JSON.parse(readFileSync(plansPath(dir), "utf8")) as {
      plans: { tasks: { due?: unknown }[] }[];
    };
    expect(saved.plans[0]?.tasks[0]?.due).toBe("2026-11-15");
  });

  it("throws a named error on corrupt JSON (never silently resets)", () => {
    const dir = tmpStatusDir();
    writeFileSync(plansPath(dir), "{ not json");
    let message = "";
    try {
      loadPlans(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).toContain(plansPath(dir));
  });

  it("throws a named error on schema-invalid JSON", () => {
    const dir = tmpStatusDir();
    writeFileSync(plansPath(dir), JSON.stringify({ version: 1, rev: -1, plans: [] }));
    expect(() => loadPlans(dir)).toThrowError(/failed schema validation/);
  });
});

describe("savePlans", () => {
  it("round-trips a document with full fidelity", () => {
    const dir = tmpStatusDir();
    const file = mkFile(
      [
        mkPlan("p_89abcdef", [
          mkTask("t_0123abcd", { status: "doing", due: "2026-09-10", focused: true }),
          mkTask("t_4567dead", {
            note: "带 $E=mc^2$ 的笔记",
            links: [{ doc_id: "arxiv-2501.17225" }],
          }),
        ]),
        mkPlan("p_beef0123", [], { desc: "空计划", icon: "rocket" }),
      ],
      7
    );
    savePlans(dir, file);
    expect(loadPlans(dir)).toEqual(file);
  });

  it("writes atomically: pretty-printed plans.json, no .tmp residue, recursive mkdir", () => {
    const dir = join(tmpStatusDir(), "nested", "status");
    const file = mkFile([mkPlan("p_89abcdef")], 1);
    savePlans(dir, file);
    expect(readFileSync(plansPath(dir), "utf8")).toBe(JSON.stringify(file, null, 2));
    expect(readdirSync(dir)).toEqual(["plans.json"]);
  });

  it("keeps rev as given, or persists rev+1 with bumpRev (the PUT path)", () => {
    const dir = tmpStatusDir();
    savePlans(dir, mkFile([], 5));
    expect(loadPlans(dir).rev).toBe(5);

    // PUT scenario: client body carries the current rev; the server checks it
    // against the on-disk rev and saves with a bump.
    const current = loadPlans(dir);
    const body = mkFile([mkPlan("p_89abcdef")], current.rev);
    expect(body.rev).toBe(current.rev);
    savePlans(dir, body, { bumpRev: true });
    const saved = loadPlans(dir);
    expect(saved.rev).toBe(current.rev + 1);
    expect(saved.plans).toEqual(body.plans);
  });

  it("refuses to write an invalid document (nothing hits the disk)", () => {
    const dir = tmpStatusDir();
    const bad = { version: 2, rev: 0, plans: [] } as unknown as PlansFile;
    expect(() => savePlans(dir, bad)).toThrowError(/refusing to write/);
    expect(existsSync(plansPath(dir))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// id generation
// --------------------------------------------------------------------------- //

describe("id generation", () => {
  it("newPlanId / newTaskId match p_/t_ + 8 lowercase hex, and look unique", () => {
    const planIds = new Set(Array.from({ length: 200 }, () => newPlanId()));
    const taskIds = new Set(Array.from({ length: 200 }, () => newTaskId()));
    for (const id of planIds) expect(id).toMatch(/^p_[0-9a-f]{8}$/);
    for (const id of taskIds) expect(id).toMatch(/^t_[0-9a-f]{8}$/);
    expect(planIds.size).toBe(200);
    expect(taskIds.size).toBe(200);
  });
});

// --------------------------------------------------------------------------- //
// CRUD helpers
// --------------------------------------------------------------------------- //

const BASE = mkFile(
  [
    mkPlan("p_aaaa0001", [mkTask("t_00000001"), mkTask("t_00000002"), mkTask("t_00000003")]),
    mkPlan("p_bbbb0002", [mkTask("t_0000000a")]),
  ],
  4
);

describe("plan CRUD", () => {
  it("addPlan appends and rejects a duplicate id", () => {
    const next = addPlan(BASE, mkPlan("p_cccc0003"));
    expect(next.plans.map((p) => p.id)).toEqual(["p_aaaa0001", "p_bbbb0002", "p_cccc0003"]);
    expect(next.rev).toBe(BASE.rev); // helpers never touch rev
    expect(() => addPlan(BASE, mkPlan("p_aaaa0001"))).toThrowError(/duplicate plan id/);
  });

  it("updatePlan merges a patch, preserving id and tasks", () => {
    const next = updatePlan(BASE, "p_aaaa0001", { name: "改名", due: "2027-01-01" });
    const plan = next.plans[0];
    expect(plan?.name).toBe("改名");
    expect(plan?.due).toBe("2027-01-01");
    expect(plan?.id).toBe("p_aaaa0001");
    expect(plan?.tasks).toEqual(BASE.plans[0]?.tasks);
    expect(() => updatePlan(BASE, "p_deadbeef", { name: "x" })).toThrowError(/no plan with id/);
  });

  it("deletePlan removes the plan and rejects an unknown id", () => {
    const next = deletePlan(BASE, "p_aaaa0001");
    expect(next.plans.map((p) => p.id)).toEqual(["p_bbbb0002"]);
    expect(() => deletePlan(BASE, "p_deadbeef")).toThrowError(/no plan with id/);
  });
});

describe("task CRUD", () => {
  it("addTask appends inside the named plan only", () => {
    const next = addTask(BASE, "p_bbbb0002", mkTask("t_0000000b"));
    expect(next.plans[1]?.tasks.map((t) => t.id)).toEqual(["t_0000000a", "t_0000000b"]);
    expect(next.plans[0]?.tasks).toEqual(BASE.plans[0]?.tasks);
    expect(() => addTask(BASE, "p_bbbb0002", mkTask("t_0000000a"))).toThrowError(
      /duplicate task id/
    );
    expect(() => addTask(BASE, "p_deadbeef", mkTask("t_0000000b"))).toThrowError(/no plan with id/);
  });

  it("updateTask merges a patch, preserving id", () => {
    const next = updateTask(BASE, "p_aaaa0001", "t_00000002", {
      status: "blocked",
      focused: true,
      links: [{ doc_id: "arxiv-2501.17225" }],
    });
    const task = next.plans[0]?.tasks[1];
    expect(task?.status).toBe("blocked");
    expect(task?.focused).toBe(true);
    expect(task?.links).toEqual([{ doc_id: "arxiv-2501.17225" }]);
    expect(task?.id).toBe("t_00000002");
    expect(() => updateTask(BASE, "p_aaaa0001", "t_deadbeef", { status: "done" })).toThrowError(
      /no task with id/
    );
  });

  it("deleteTask removes the task and rejects an unknown id", () => {
    const next = deleteTask(BASE, "p_aaaa0001", "t_00000002");
    expect(next.plans[0]?.tasks.map((t) => t.id)).toEqual(["t_00000001", "t_00000003"]);
    expect(() => deleteTask(BASE, "p_aaaa0001", "t_deadbeef")).toThrowError(/no task with id/);
  });
});

describe("moveTask", () => {
  it("reorders within the plan, forward and backward", () => {
    const fwd = moveTask(BASE, "p_aaaa0001", 0, 2);
    expect(fwd.plans[0]?.tasks.map((t) => t.id)).toEqual([
      "t_00000002",
      "t_00000003",
      "t_00000001",
    ]);
    const bwd = moveTask(BASE, "p_aaaa0001", 2, 0);
    expect(bwd.plans[0]?.tasks.map((t) => t.id)).toEqual([
      "t_00000003",
      "t_00000001",
      "t_00000002",
    ]);
    // adjacent single-step move
    const step = moveTask(BASE, "p_aaaa0001", 1, 2);
    expect(step.plans[0]?.tasks.map((t) => t.id)).toEqual([
      "t_00000001",
      "t_00000003",
      "t_00000002",
    ]);
  });

  it("fromIndex === toIndex is a no-op returning the input unchanged", () => {
    expect(moveTask(BASE, "p_aaaa0001", 1, 1)).toBe(BASE);
  });

  it("rejects out-of-range or non-integer indices (no clamping)", () => {
    const cases: [number, number][] = [
      [-1, 0],
      [0, 3],
      [3, 0],
      [0, -1],
      [0.5, 1],
      [0, 1.5],
    ];
    for (const [from, to] of cases) {
      expect(() => moveTask(BASE, "p_aaaa0001", from, to)).toThrowError(/out of range/);
    }
    expect(() => moveTask(BASE, "p_deadbeef", 0, 0)).toThrowError(/no plan with id/);
  });
});

describe("helper purity", () => {
  it("no helper mutates its input PlansFile", () => {
    const ops: ((f: PlansFile) => PlansFile)[] = [
      (f) => addPlan(f, mkPlan("p_cccc0003")),
      (f) => updatePlan(f, "p_aaaa0001", { name: "改名" }),
      (f) => deletePlan(f, "p_bbbb0002"),
      (f) => addTask(f, "p_aaaa0001", mkTask("t_00000004")),
      (f) => updateTask(f, "p_aaaa0001", "t_00000001", { status: "done" }),
      (f) => deleteTask(f, "p_aaaa0001", "t_00000001"),
      (f) => moveTask(f, "p_aaaa0001", 0, 2),
    ];
    for (const op of ops) {
      const input = structuredClone(BASE);
      const snapshot = structuredClone(BASE);
      op(input);
      expect(input).toEqual(snapshot);
    }
  });
});
