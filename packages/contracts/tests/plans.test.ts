/**
 * Positive/negative coverage of the plan-page zod schemas (Stage 4 MS1):
 * Plan / Task / PlansFile field rules (required keys, id format, status enum,
 * version literal, rev bounds, defaults) and the `plan.changed` WS message
 * (standalone schema + membership in the WsServerMessage union).
 */

import { describe, expect, it } from "vitest";
import { WsServerMessageSchema } from "../src/jobs.js";
import { PlanSchema, PlansFileSchema, TaskSchema, WsPlanChangedSchema } from "../src/plans.js";

const VALID_TASK = {
  id: "t_0123abcd",
  title: "读 2501.17225",
  status: "todo",
  due: "2026-09-10",
  note: "先看 §3 的 $E=mc^2$ 推导",
  links: [{ doc_id: "arxiv-2501.17225" }],
  focused: true,
  created_at: "2026-09-02T10:00:00.000Z",
};

const VALID_PLAN = {
  id: "p_89abcdef",
  name: "Stage 4 计划页面",
  desc: "webui 完整可交互 CRUD",
  due: "2026-09-30",
  icon: "rocket",
  created_at: "2026-09-02T10:00:00.000Z",
  tasks: [VALID_TASK],
};

const VALID_FILE = { version: 1, rev: 3, plans: [VALID_PLAN] };

describe("TaskSchema", () => {
  it("parses a fully-populated task", () => {
    expect(TaskSchema.safeParse(VALID_TASK).success).toBe(true);
  });

  it("accepts a minimal task and defaults links to []", () => {
    const minimal = {
      id: "t_0123abcd",
      title: "title-only 快速添加",
      status: "doing",
      focused: false,
      created_at: "2026-09-02T10:00:00.000Z",
    };
    const result = TaskSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.links).toEqual([]);
      expect(result.data.due).toBeUndefined();
      expect(result.data.note).toBeUndefined();
    }
  });

  it("rejects a missing or empty title", () => {
    const { title: _, ...noTitle } = VALID_TASK;
    expect(TaskSchema.safeParse(noTitle).success).toBe(false);
    expect(TaskSchema.safeParse({ ...VALID_TASK, title: "" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(TaskSchema.safeParse({ ...VALID_TASK, status: "doing-it" }).success).toBe(false);
  });

  it("accepts every status of the closed enum", () => {
    for (const status of ["todo", "doing", "blocked", "done"]) {
      expect(TaskSchema.safeParse({ ...VALID_TASK, status }).success).toBe(true);
    }
  });

  it("rejects malformed ids (prefix, length, non-hex, uppercase)", () => {
    for (const id of ["p_0123abcd", "t_0123abc", "t_0123abcde", "t_0123abcg", "t_0123ABCD"]) {
      expect(TaskSchema.safeParse({ ...VALID_TASK, id }).success).toBe(false);
    }
  });

  it("rejects a non-ISO due date", () => {
    for (const due of ["tomorrow", "2026-9-3", "2026-13-01", "2026-09-10T10:00:00Z"]) {
      expect(TaskSchema.safeParse({ ...VALID_TASK, due }).success).toBe(false);
    }
  });

  it("rejects a non-ISO created_at", () => {
    expect(TaskSchema.safeParse({ ...VALID_TASK, created_at: "2026-09-02" }).success).toBe(false);
  });

  it("rejects a link without doc_id", () => {
    const bad = { ...VALID_TASK, links: [{}] };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });
});

describe("PlanSchema", () => {
  it("parses a fully-populated plan", () => {
    expect(PlanSchema.safeParse(VALID_PLAN).success).toBe(true);
  });

  it("defaults icon to 'target' and tasks to []", () => {
    const minimal = {
      id: "p_89abcdef",
      name: "最小计划",
      due: "2026-12-31",
      created_at: "2026-09-02T10:00:00.000Z",
    };
    const result = PlanSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.icon).toBe("target");
      expect(result.data.tasks).toEqual([]);
      expect(result.data.desc).toBeUndefined();
    }
  });

  it("rejects a missing name or due (both required)", () => {
    const { name: _n, ...noName } = VALID_PLAN;
    const { due: _d, ...noDue } = VALID_PLAN;
    expect(PlanSchema.safeParse(noName).success).toBe(false);
    expect(PlanSchema.safeParse(noDue).success).toBe(false);
  });

  it("rejects malformed plan ids", () => {
    for (const id of ["t_89abcdef", "p_89abcde", "p_89abcdef0", "p_"]) {
      expect(PlanSchema.safeParse({ ...VALID_PLAN, id }).success).toBe(false);
    }
  });

  it("rejects an embedded invalid task", () => {
    const bad = { ...VALID_PLAN, tasks: [{ ...VALID_TASK, status: "nope" }] };
    expect(PlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe("PlansFileSchema", () => {
  it("parses the empty document", () => {
    expect(PlansFileSchema.safeParse({ version: 1, rev: 0, plans: [] }).success).toBe(true);
  });

  it("parses a full file", () => {
    expect(PlansFileSchema.safeParse(VALID_FILE).success).toBe(true);
  });

  it("rejects a wrong version literal", () => {
    for (const version of [2, "1", 0]) {
      expect(PlansFileSchema.safeParse({ ...VALID_FILE, version }).success).toBe(false);
    }
  });

  it("rejects a negative or non-integer rev", () => {
    for (const rev of [-1, 1.5, "3"]) {
      expect(PlansFileSchema.safeParse({ ...VALID_FILE, rev }).success).toBe(false);
    }
  });

  it("rejects missing version / rev / plans", () => {
    for (const key of ["version", "rev", "plans"]) {
      const partial: Record<string, unknown> = { ...VALID_FILE };
      delete partial[key];
      expect(PlansFileSchema.safeParse(partial).success).toBe(false);
    }
  });
});

describe("WsPlanChangedSchema", () => {
  it("parses with and without cause", () => {
    const bare = { type: "plan.changed", at: "2026-09-02T10:00:00.000Z" };
    expect(WsPlanChangedSchema.safeParse(bare).success).toBe(true);
    for (const cause of ["put", "external"]) {
      expect(WsPlanChangedSchema.safeParse({ ...bare, cause }).success).toBe(true);
    }
  });

  it("rejects an unknown cause or missing at", () => {
    const bare = { type: "plan.changed", at: "2026-09-02T10:00:00.000Z" };
    expect(WsPlanChangedSchema.safeParse({ ...bare, cause: "patch" }).success).toBe(false);
    expect(WsPlanChangedSchema.safeParse({ type: "plan.changed" }).success).toBe(false);
  });

  it("is a member of the WsServerMessage union (library.changed still parses)", () => {
    const planMsg = { type: "plan.changed", cause: "put", at: "2026-09-02T10:00:00.000Z" };
    const parsed = WsServerMessageSchema.safeParse(planMsg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe("plan.changed");
    const libMsg = { type: "library.changed", cause: "patch", at: "2026-09-02T10:00:00.000Z" };
    expect(WsServerMessageSchema.safeParse(libMsg).success).toBe(true);
  });
});
