/**
 * List-mode cross-group drag rejection (Stage 4 smoke bug): the drop must
 * snap back with NO state change and NO PUT when the pointer lands outside
 * the dragged row's own group — same-group reorder keeps working (1 PUT).
 *
 * Real DndContext + real pointer events (PointerSensor needs
 * `isPrimary: true`); geometry is stubbed per element (rows by title,
 * `[data-group]` group rects for the landing-zone hit-test). The assertion
 * target is PlanView so PUTs are counted against the mini fetch server.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlansFile } from "@argelanderspace/contracts";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { PlanView } from "../src/plan/PlanView";

vi.mock("../src/api/ws", () => ({
  onPlanChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
}));

const WORKSPACE: Workspace = {
  papers: [],
  currentDoc: null,
  setCurrentDoc: () => {},
  openDoc: () => {},
  pendingAnchor: null,
  clearPendingAnchor: () => {},
  tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
};

let serverDoc: PlansFile;
let putBodies: PlansFile[];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/plans" && method === "GET") {
        return { ok: true, json: async () => serverDoc } as Response;
      }
      if (url === "/api/plans" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as PlansFile;
        putBodies.push(body);
        serverDoc = { ...body, rev: body.rev + 1 };
        return { ok: true, json: async () => serverDoc } as Response;
      }
      if (url === "/api/library") {
        return {
          ok: true,
          json: async () => ({ project: { name: "T" }, refs: [], tags: [], graph: { nodes: [], links: [] } }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
}

const mk = (id: string, title: string, status: "todo" | "doing" | "done") => ({
  id,
  title,
  status,
  due: "2026-12-31",
  links: [],
  focused: false,
  created_at: "2026-09-01T08:00:00.000Z",
});

beforeEach(() => {
  serverDoc = {
    version: 1,
    rev: 0,
    plans: [
      {
        id: "p_00000001",
        name: "拖拽计划",
        due: "2026-12-31",
        icon: "target",
        created_at: "2026-08-01T08:00:00.000Z",
        tasks: [
          mk("t_000000b1", "在做一", "doing"),
          mk("t_000000a1", "待办一", "todo"),
          mk("t_000000a2", "待办二", "todo"),
          mk("t_000000d1", "已完一", "done"),
        ],
      },
    ],
  };
  putBodies = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- geometry ------------------------------------------------------------ //

// DOM order: 在做一 (y=0), 待办一 (y=40), 待办二 (y=80), done head (y=160).
// Rows 40px tall; group rects extend past their last row (padding / drop
// zone, as in the real layout).
const ROW_Y: Record<string, number> = { 在做一: 0, 待办一: 40, 待办二: 80 };
const GROUP_RECT: Record<string, { top: number; bottom: number }> = {
  doing: { top: 0, bottom: 80 },
  todo: { top: 80, bottom: 160 },
  done: { top: 160, bottom: 190 },
};

function stubGeometry(container: HTMLElement): () => void {
  const rects = new Map<Element, { top: number; bottom: number }>();
  for (const r of container.querySelectorAll<HTMLElement>(".plan-task-row")) {
    const title = r.querySelector(".plan-task-title")?.textContent ?? "";
    const y = ROW_Y[title];
    if (y !== undefined) rects.set(r, { top: y, bottom: y + 40 });
  }
  for (const g of container.querySelectorAll<HTMLElement>("[data-group]")) {
    const key = g.getAttribute("data-group") ?? "";
    const rect = GROUP_RECT[key];
    if (rect) rects.set(g, rect);
  }
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const r = rects.get(this);
    const top = r?.top ?? 0;
    const bottom = r?.bottom ?? 0;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 300,
      bottom,
      width: 300,
      height: bottom - top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    proto.getBoundingClientRect = orig;
  };
}

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".plan-task-row")].find(
    (r) => r.querySelector(".plan-task-title")?.textContent === title
  );
  if (!row) throw new Error(`row not found: ${title}`);
  return row;
}

function drag(container: HTMLElement, title: string, fromY: number, toY: number): void {
  const row = rowOf(container, title);
  fireEvent.pointerDown(row, { clientX: 50, clientY: fromY, button: 0, isPrimary: true, pointerId: 1 });
  fireEvent.pointerMove(document, { clientX: 50, clientY: fromY + 20, isPrimary: true, pointerId: 1 });
  fireEvent.pointerMove(document, { clientX: 50, clientY: toY, isPrimary: true, pointerId: 1 });
  fireEvent.pointerUp(document, { clientX: 50, clientY: toY, isPrimary: true, pointerId: 1 });
}

function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".plan-task-title")].map((e) => e.textContent ?? "");
}

async function renderPlan() {
  const utils = render(
    <WorkspaceProvider value={WORKSPACE}>
      <PlanView />
    </WorkspaceProvider>
  );
  await waitFor(() => expect(utils.container.querySelectorAll(".plan-task-row")).toHaveLength(3));
  return utils;
}

describe("list-mode drag rejection (Stage 4 smoke bug)", () => {
  it("cross-group drag (todo row onto the doing group) snaps back: 0 PUT, order unchanged", async () => {
    const { container } = await renderPlan();
    const restore = stubGeometry(container);
    const before = titles(container);

    drag(container, "待办一", 60, 20); // release deep inside the doing group
    await new Promise((r) => setTimeout(r, 60));
    expect(putBodies).toHaveLength(0); // no PUT at all
    expect(titles(container)).toEqual(before); // and nothing moved
    // …but the rejection is not silent: the nudge names the real path
    expect(container.textContent).toContain("跨组移动请用状态圆钮或抽屉改状态");
    restore();
  });

  it("drag onto the collapsed done group's head is rejected too (0 PUT)", async () => {
    const { container } = await renderPlan();
    const restore = stubGeometry(container);

    drag(container, "待办一", 60, 175); // release on the collapsed 已完成 head
    await new Promise((r) => setTimeout(r, 60));
    expect(putBodies).toHaveLength(0);
    expect(container.textContent).toContain("跨组移动请用状态圆钮或抽屉改状态");
    restore();
  });

  it("same-group reorder still works (control): todo-1 below todo-2 → 1 PUT", async () => {
    const { container } = await renderPlan();
    const restore = stubGeometry(container);

    drag(container, "待办一", 60, 130); // release inside the todo group, below 待办二
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]!.plans[0]!.tasks.map((t) => t.title)).toEqual([
      "在做一",
      "待办二",
      "待办一",
      "已完一",
    ]);
    expect(titles(container)).toEqual(["在做一", "待办二", "待办一"]);
    expect(container.textContent).not.toContain("跨组移动"); // accepted drags stay silent
    restore();
  });

  it("mid-drag, foreign groups are dimmed as non-targets (and restored after)", async () => {
    const { container } = await renderPlan();
    const restore = stubGeometry(container);
    const row = rowOf(container, "在做一");
    fireEvent.pointerDown(row, { clientX: 50, clientY: 20, button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 50, clientY: 60, isPrimary: true, pointerId: 1 });
    const cls = (k: string) => container.querySelector(`[data-group="${k}"]`)?.className ?? "";
    expect(cls("todo")).toContain("plan-no-target");
    expect(cls("done")).toContain("plan-no-target");
    expect(cls("doing")).not.toContain("plan-no-target");
    // …and the no-drop cursor rides the DRAGGED ROW once the pointer leaves its group
    const rootCls = () => container.querySelector(".plan-list-mode")?.className ?? "";
    expect(rootCls()).not.toContain("plan-nodrop-active"); // still inside own group
    fireEvent.pointerMove(document, { clientX: 50, clientY: 120, isPrimary: true, pointerId: 1 });
    expect(rootCls()).toContain("plan-nodrop-active"); // over the todo group now
    fireEvent.pointerMove(document, { clientX: 50, clientY: 60, isPrimary: true, pointerId: 1 });
    expect(rootCls()).not.toContain("plan-nodrop-active"); // back home
    fireEvent.pointerUp(document, { clientX: 50, clientY: 60, isPrimary: true, pointerId: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect(cls("todo")).not.toContain("plan-no-target"); // cleared after the drop
    restore();
  });
});
