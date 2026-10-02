import { describe, expect, it } from "vitest";
import {
  moveToColumn,
  PLAN_ICONS,
  PlanOperationSchema,
  PlanWriteOperationSchema,
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
      { action: "delete_plan", expectedRev: 1, planId: "p_00000001" },
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
