/**
 * The plan drag/reorder pure functions (Stage 4): list-mode group reorder
 * keeps non-group tasks pinned to their array slots, board-mode moves use
 * arrayMove semantics in-column and insert-before/append-last cross-column —
 * and every NOOP path returns the IDENTICAL array reference. That identity
 * is a live contract: PlanView's patchTasks bubbles it up as the same
 * plan/doc, mutate's `next === cur` check then skips the PUT entirely (no
 * phantom rev bumps from cancelled drags — pinned in plan-drag-noop.test).
 */

import { describe, expect, it } from "vitest";
import type { Task } from "@argelanderspace/contracts";
import {
  moveToColumn,
  reorderWithinStatus,
  timelineScale,
  type Plan,
} from "../src/plan/model";

function mkTask(id: string, status: Task["status"] = "todo"): Task {
  return {
    id,
    title: id,
    status,
    due: "2026-12-31",
    links: [],
    focused: false,
    created_at: "2026-09-01T08:00:00.000Z",
  };
}

describe("reorderWithinStatus (list mode)", () => {
  it("reorders inside the group, keeping other statuses at their array slots", () => {
    // [A todo, X doing, B todo, C todo] — moving A below C within todo
    const tasks = [mkTask("a"), mkTask("x", "doing"), mkTask("b"), mkTask("c")];
    const out = reorderWithinStatus(tasks, "todo", "a", "c");
    expect(out.map((t) => t.id)).toEqual(["b", "x", "c", "a"]);
    expect(out[1]).toBe(tasks[1]); // the doing task never moved
  });

  it("moving up works too", () => {
    const tasks = [mkTask("a"), mkTask("b"), mkTask("c")];
    expect(reorderWithinStatus(tasks, "todo", "c", "a").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("NOOPs return the identical reference (same id / unknown id)", () => {
    const tasks = [mkTask("a"), mkTask("b")];
    expect(reorderWithinStatus(tasks, "todo", "a", "a")).toBe(tasks);
    expect(reorderWithinStatus(tasks, "todo", "a", "ghost")).toBe(tasks);
  });
});

describe("moveToColumn (board mode)", () => {
  it("same-column drop on a card takes its place (arrayMove semantics)", () => {
    const tasks = [mkTask("a"), mkTask("b"), mkTask("c")];
    expect(moveToColumn(tasks, "a", "todo", "b").map((t) => t.id)).toEqual(["b", "a", "c"]);
    expect(moveToColumn(tasks, "c", "todo", "a").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("same-column drop on the column body / on itself is a NOOP (identical reference)", () => {
    const tasks = [mkTask("a"), mkTask("b")];
    expect(moveToColumn(tasks, "a", "todo", null)).toBe(tasks);
    expect(moveToColumn(tasks, "a", "todo", "a")).toBe(tasks);
  });

  it("cross-column drop on a card changes status and inserts before it", () => {
    const tasks = [mkTask("a"), mkTask("x", "doing"), mkTask("b")];
    const out = moveToColumn(tasks, "a", "doing", "b");
    expect(out.map((t) => `${t.id}:${t.status}`)).toEqual(["x:doing", "a:doing", "b:todo"]);
  });

  it("cross-column drop on the column body lands after its last card", () => {
    const tasks = [mkTask("a"), mkTask("x", "doing"), mkTask("b")];
    const out = moveToColumn(tasks, "b", "doing", null);
    expect(out.map((t) => `${t.id}:${t.status}`)).toEqual(["a:todo", "x:doing", "b:doing"]);
  });

  it("cross-column drop into an EMPTY column appends at the array end", () => {
    const tasks = [mkTask("a"), mkTask("b")];
    const out = moveToColumn(tasks, "a", "blocked", null);
    expect(out.map((t) => `${t.id}:${t.status}`)).toEqual(["b:todo", "a:blocked"]);
  });

  it("unknown active id is a NOOP (identical reference)", () => {
    const tasks = [mkTask("a")];
    expect(moveToColumn(tasks, "ghost", "doing", null)).toBe(tasks);
  });
});

describe("timelineScale", () => {
  const plan = (created: string, due: string): Plan => ({
    id: "p_00000001",
    name: "p",
    due,
    icon: "target",
    created_at: `${created}T08:00:00.000Z`,
    tasks: [],
  });

  it("weekly ticks below 6 weeks, monthly above", () => {
    const w = timelineScale([plan("2026-09-01", "2026-09-20")], "2026-09-10");
    expect(w?.weekly).toBe(true);
    const m = timelineScale([plan("2026-09-01", "2026-12-20")], "2026-09-10");
    expect(m?.weekly).toBe(false);
  });

  it("month ticks carry the year (cross-year spans stay unambiguous)", () => {
    const s = timelineScale([plan("2026-10-01", "2027-03-01")], "2026-10-15");
    const labels = s?.ticks.map((t) => t.label) ?? [];
    expect(labels).toContain("2026年11月");
    expect(labels).toContain("2027年1月");
  });

  it("the axis always includes today and every task due", () => {
    const p: Plan = {
      ...plan("2026-09-01", "2026-09-05"),
      tasks: [
        {
          ...mkTask("t_00000001"),
          due: "2026-12-01",
        },
      ],
    };
    const s = timelineScale([p], "2026-09-10");
    expect(s?.weekly).toBe(false); // span stretched to the December task due
  });
});
