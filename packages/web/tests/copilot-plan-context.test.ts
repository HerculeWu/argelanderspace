import type { Plan, PlansFile } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { capturePlanPage } from "../src/copilot/plan-context";
const plan = (id: string): Plan => ({ id, name: id, icon: "target", created_at: "2026-10-02T00:00:00Z", due: "2026-12-01", tasks: Array.from({ length: 90 }, (_, i) => ({ id: `t_${i.toString(16).padStart(8, "0")}`, title: i === 89 ? "LAST_SCROLL_SENTINEL" : `Task ${i}`, status: i === 0 ? "done" : "todo", due: "2026-12-01", created_at: "2026-10-02T00:00:00Z", links: [], focused: i === 89 })) });
const file: PlansFile = { version: 1, rev: 12, plans: [plan("p_00000001"), { ...plan("p_00000002"), tasks: [{ ...plan("p_00000002").tasks[0]!, id: "t_eeeeeeee" }] }] };

test("selected Plan captures every scrollable task, original order/revision and cross-plan open detail", () => {
  const page = capturePlanPage(file, "p_00000001", "t_eeeeeeee", "list", "2026-10-02", "saved");
  expect(page.plans).toHaveLength(1); expect(page.plans[0]?.tasks[89]?.title).toBe("LAST_SCROLL_SENTINEL");
  expect(page.plans[0]?.tasks).toEqual(file.plans[0]?.tasks); expect(page.rev).toBe(12);
  expect(page.detail?.planId).toBe("p_00000002"); expect(page.groups[0]?.key).toBe("todo");
});

test("focus shares UI grouping and narrows tasks; timeline contains its complete actual scope", () => {
  const focused = capturePlanPage(file, null, null, "focus", "2026-10-02", "pending");
  expect(focused.plans).toHaveLength(1); expect(focused.plans[0]?.tasks).toHaveLength(1); expect(focused.groups).toEqual([{ key: "pinned", taskIds: ["t_00000059"] }]);
  expect(focused.saveState).toBe("pending");
  expect(capturePlanPage(file, null, null, "timeline", "2026-10-02", "saved").plans).toEqual(file.plans);
});
