/**
 * Noop drag → no PUT (MS3 review): a same-slot drag must not bump rev. The
 * dnd-kit sensor/collision machinery can't run in happy-dom, so DndContext
 * is stubbed to capture ListMode's onDragEnd — every other layer stays real:
 * ListMode.onDragEnd → cb.onReorder → reorderWithinStatus →
 * PlanView.patchTasks (identity-propagating) → mutate's `next === cur` skip
 * → putPlans never called.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlansFile, Task } from "@argelanderspace/contracts";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { PlanView } from "../src/plan/PlanView";

const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
    dnd.onDragEnd = props.onDragEnd;
    return props.children;
  },
  PointerSensor: class {},
  useSensor: (s: unknown) => s,
  useSensors: (...s: unknown[]) => s,
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: { children: React.ReactNode }) => props.children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: () => {},
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));
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

const TASKS: Task[] = [
  {
    id: "t_00000001",
    title: "甲",
    status: "todo",
    due: "2026-12-31",
    links: [],
    focused: false,
    created_at: "2026-09-01T08:00:00.000Z",
  },
  {
    id: "t_00000002",
    title: "乙",
    status: "todo",
    due: "2026-12-31",
    links: [],
    focused: false,
    created_at: "2026-09-01T08:00:00.000Z",
  },
];

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

const dragEndOn = (activeId: string, overId: string, overStatus?: string) =>
  act(() => {
    dnd.onDragEnd?.({
      active: { id: activeId, data: { current: { status: "todo" } } },
      over: { id: overId, data: { current: { status: overStatus ?? "todo" } } },
    });
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
        tasks: TASKS,
      },
    ],
  };
  putBodies = [];
  dnd.onDragEnd = null;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("noop drag (MS3 review ①)", () => {
  it("a drop on the same card persists nothing (no PUT, no rev bump)", async () => {
    const { container } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <PlanView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".plan-task-row")).toHaveLength(2));
    expect(dnd.onDragEnd).toBeTruthy();

    dragEndOn("t_00000001", "t_00000001"); // same slot: a cancelled drag
    await new Promise((r) => setTimeout(r, 50)); // any write would have fired by now
    expect(putBodies).toHaveLength(0);

    // a cross-group drop is rejected in ListMode before reaching the helper
    dragEndOn("t_00000001", "t_00000002", "done");
    await new Promise((r) => setTimeout(r, 50));
    expect(putBodies).toHaveLength(0);
  });

  it("a real reorder still persists (control: the path to mutate is live)", async () => {
    const { container } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <PlanView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".plan-task-row")).toHaveLength(2));

    dragEndOn("t_00000001", "t_00000002"); // 甲 below 乙
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]!.plans[0]!.tasks.map((t) => t.title)).toEqual(["乙", "甲"]);
    const titles = [...container.querySelectorAll(".plan-task-title")].map((e) => e.textContent);
    expect(titles).toEqual(["乙", "甲"]);
  });
});
