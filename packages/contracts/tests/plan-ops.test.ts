import { describe, expect, it } from "vitest";
import {
  moveToColumn,
  PLAN_ICONS,
  PlanDeleteOperationSchema,
  PlanOperationSchema,
  PlanWriteOperationSchema,
  reinsertTask,
  reorderWithinStatus,
  type Task,
} from "../src/index.js";

const task = (id: string, status: Task["status"]): Task => ({
  id: `t_0000000${id}`,
  title: id,
  status,
  due: "2026-12-01",
  links: [],
  focused: false,
  created_at: "2026-10-01T00:00:00.000Z",
});

describe("closed Plan operation union", () => {
  it("accepts the UI-equivalent actions and nothing else", () => {
    for (const ok of [
      { action: "read" },
      { action: "create_task", expectedRev: 1, planId: "p_00000001", title: "x" },
      {
        action: "move_task",
        expectedRev: 1,
        planId: "p_00000001",
        taskId: "t_00000001",
        layout: "board",
        status: "done",
        overTaskId: null,
      },
      { action: "show", view: "timeline" },
      { action: "close_task" },
    ])
      expect(PlanOperationSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [
      { action: "delete_plan", planId: "p_00000001" }, // no expectedRev
      { action: "delete_task", expectedRev: 1, planId: "p_00000001" }, // no task
      { action: "delete_plan", expectedRev: 1, planId: "p_00000001", confirmed: true },
      {
        action: "update_task",
        expectedRev: 1,
        planId: "p_00000001",
        taskId: "t_00000001",
        created_at: "2020-01-01T00:00:00.000Z",
      },
      { action: "update_plan", expectedRev: 1, planId: "p_00000001", icon: "rocket" },
      {
        action: "move_task",
        expectedRev: 1,
        planId: "p_00000001",
        taskId: "t_00000001",
        layout: "board",
        status: "done",
        toPlanId: "p_00000002",
      },
      {
        action: "update_task",
        planId: "p_00000001",
        taskId: "t_00000001",
        title: "no expected rev",
      },
      { action: "create_task", expectedRev: 1, planId: "p_00000001", title: "   " },
    ])
      expect(PlanOperationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(PLAN_ICONS).toHaveLength(8);
    expect(PlanWriteOperationSchema.safeParse({ action: "read" }).success).toBe(false);
  });
});

describe("delete requests", () => {
  it("are a request union of their own, never part of the write union, and carry no approval field", () => {
    for (const ok of [
      { action: "delete_plan", expectedRev: 1, planId: "p_00000001" },
      { action: "delete_task", expectedRev: 1, planId: "p_00000001", taskId: "t_00000001" },
    ]) {
      expect(PlanDeleteOperationSchema.safeParse(ok).success).toBe(true);
      expect(PlanOperationSchema.safeParse(ok).success).toBe(true);
      expect(PlanWriteOperationSchema.safeParse(ok).success).toBe(false);
    }
    expect(
      PlanDeleteOperationSchema.safeParse({
        action: "delete_plan",
        expectedRev: 1,
        planId: "p_00000001",
        approved: true,
      }).success
    ).toBe(false);
  });
  it("reinsertTask restores the original index (clamped) and is a no-op when the task is back", () => {
    const base = [task("1", "todo"), task("3", "todo")];
    const gone = task("2", "todo");
    expect(reinsertTask(base, 1, gone).map((t) => t.id)).toEqual([
      "t_00000001",
      "t_00000002",
      "t_00000003",
    ]);
    expect(reinsertTask(base, 99, gone).map((t) => t.id)).toEqual([
      "t_00000001",
      "t_00000003",
      "t_00000002",
    ]);
    const back = reinsertTask(base, 0, base[1] as Task);
    expect(back).toBe(base);
  });
});

describe("shared reorder rules", () => {
  const tasks = [task("1", "todo"), task("2", "doing"), task("3", "todo"), task("4", "done")];
  it("list reorders only inside one status group and leaves other positions alone", () => {
    expect(reorderWithinStatus(tasks, "todo", "t_00000003", "t_00000001").map((t) => t.id)).toEqual(
      ["t_00000003", "t_00000002", "t_00000001", "t_00000004"]
    );
    expect(reorderWithinStatus(tasks, "todo", "t_00000003", "t_00000002")).toBe(tasks);
  });
  it("board drop across columns changes status and position; a no-op returns the same array", () => {
    const moved = moveToColumn(tasks, "t_00000001", "doing", null);
    expect(moved.map((t) => `${t.id}:${t.status}`)).toEqual([
      "t_00000002:doing",
      "t_00000001:doing",
      "t_00000003:todo",
      "t_00000004:done",
    ]);
    expect(moveToColumn(tasks, "t_00000002", "doing", null)).toBe(tasks);
  });
});
