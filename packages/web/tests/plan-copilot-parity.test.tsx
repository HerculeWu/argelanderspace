/**
 * Copilot ticket 09 on the web side: the Plan page's controller for explicit Copilot navigation, the
 * guarantee that a background edit does not navigate or overwrite a draft, the shared reorder rules,
 * and the inert display of agent-writable notes. Real PlanView/Shell over a stubbed fetch "server".
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { PlansFile } from "@argelanderspace/contracts";
import * as contracts from "@argelanderspace/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard, WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import * as model from "../src/plan/model";
import { PLAN_ICONS } from "../src/plan/modals";
import { PlanView, type PlanViewController } from "../src/plan/PlanView";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({ planChanged: [] as (() => void)[], viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>) }));
vi.mock("../src/api/ws", async () =>
  (await import("./shell-stubs")).quietWs({ onPlanChanged: (cb: () => void) => { h.planChanged.push(cb); return () => {}; } })
);
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc", "doc-stub"));

const WORKSPACE: Workspace = { papers: [], currentDoc: null, setCurrentDoc: () => {}, openDoc: vi.fn(), pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {}, tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true } };
const task = (n: number, over: object = {}) => ({ id: `t_${String(n).padStart(8, "0")}`, title: `Task ${n}`, status: "todo", due: "2026-12-31", links: [], focused: false, created_at: "2026-09-01T08:00:00.000Z", ...over });
const plan = (id: string, name: string, tasks: object[]) => ({ id, name, due: "2026-12-31", icon: "target", created_at: "2026-08-01T08:00:00.000Z", tasks });
const makeDoc = (): PlansFile => ({ version: 1, rev: 3, plans: [plan("p_0000000a", "Alpha", [task(1), task(2, { status: "doing" })]), plan("p_0000000b", "Beta", [task(9)])] }) as PlansFile;

let serverDoc: PlansFile;
let puts: PlansFile[];
let gets: number;
let papers: string[] = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
installShellHarness({
  language: null,
  papers: () => papers,
  routes: (url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/plans" && method === "GET") { gets++; return ok(serverDoc); }
    if (url === "/api/plans" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as PlansFile;
      if (body.rev !== serverDoc.rev) return { ok: false, status: 409, json: async () => ({ rev: serverDoc.rev }) } as Response;
      puts.push(body); serverDoc = { ...body, rev: body.rev + 1 }; return ok(serverDoc);
    }
    if (url === "/api/library") return ok({ project: { name: "P" }, refs: [], tags: [], graph: { nodes: [], links: [] } });
    return null;
  },
});
beforeEach(() => { papers = []; serverDoc = makeDoc(); puts = []; gets = 0; h.planChanged.length = 0; h.viewAction = null; });

function mountPlan() {
  let controller: PlanViewController | null = null;
  const view = render(<WorkspaceProvider value={WORKSPACE}><PlanView paneId={1} onController={(_pane, value) => { controller = value; }} /></WorkspaceProvider>);
  return { ...view, controller: () => controller };
}
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const pressed = (mode: string) => q(`[data-ui="plan-display-mode"][data-ui-key="${mode}"]`)?.getAttribute("aria-pressed");

describe("Plan view controller (explicit Copilot navigation)", () => {
  it("shows list/board/focus/timeline and a chosen plan, opens and closes a task drawer, exactly like the page's own controls", async () => {
    const { controller } = mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    expect(controller()).not.toBeNull();
    expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000a");
    expect(await controller()!.apply({ action: "show", view: "board", planId: "p_0000000b" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000b"));
    expect(pressed("board")).toBe("true");
    await act(async () => { await controller()!.apply({ action: "show", view: "focus" }); });
    expect(q('[data-ui="plan-toolbar"]')).toBeNull(); // special views have no plan toolbar
    await act(async () => { await controller()!.apply({ action: "show", view: "timeline" }); });
    expect(document.body.textContent).toContain("Alpha");
    await act(async () => { await controller()!.apply({ action: "open_task", taskId: "t_00000002" }); });
    await waitFor(() => expect(q('[data-ui="task-drawer"]')?.getAttribute("data-ui-key")).toBe("t_00000002"));
    expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000a"); // the plan that owns the task is shown
    await act(async () => { await controller()!.apply({ action: "close_task" }); });
    expect(q('[data-ui="task-drawer"]')).toBeNull();
  });

  it("unknown ids are not_found after one reload; the controller disappears with the page", async () => {
    const { controller, unmount } = mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    const before = gets;
    expect(await controller()!.apply({ action: "open_task", taskId: "t_ffffffff" })).toEqual({ ok: false, detail: "not_found" });
    expect(await controller()!.apply({ action: "show", view: "list", planId: "p_00000000" })).toEqual({ ok: false, detail: "not_found" });
    expect(gets).toBe(before + 2);
    const last = controller();
    unmount();
    expect(controller()).toBeNull();
    expect(last).not.toBeNull();
  });

  it("an id created in the background is found after the reload the controller performs", async () => {
    const { controller } = mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    serverDoc = { ...serverDoc, rev: 4, plans: [...serverDoc.plans, plan("p_0000000c", "Gamma", [task(12)]) as never] };
    expect(await controller()!.apply({ action: "show", view: "list", planId: "p_0000000c" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000c"));
  });
});

describe("a background (agent) edit neither navigates nor overwrites the user's draft", () => {
  it("keeps plan, mode and drawer; the user's unsaved note draft survives; saving it later keeps the agent's field", async () => {
    mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="plan-display-mode"][data-ui-key="board"]')!);
    fireEvent.click(q('[data-ui="task-item"][data-ui-key="t_00000002"]')!);
    await waitFor(() => expect(q('[data-ui="task-drawer"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="add-task-note"]')!);
    const input = q('[data-ui="task-note-input"]') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "my unsaved thoughts" } });
    // The agent changes Task 2's status in the background and the server announces it.
    serverDoc = { ...serverDoc, rev: 4, plans: serverDoc.plans.map((p) => p.id !== "p_0000000a" ? p : { ...p, tasks: p.tasks.map((t) => t.id === "t_00000002" ? { ...t, status: "blocked" as const } : t) }) };
    await act(async () => { for (const cb of h.planChanged) cb(); });
    await waitFor(() => expect(gets).toBeGreaterThan(1));
    expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000a");
    expect(pressed("board")).toBe("true");
    expect(q('[data-ui="task-drawer"]')?.getAttribute("data-ui-key")).toBe("t_00000002");
    expect((q('[data-ui="task-note-input"]') as HTMLTextAreaElement).value).toBe("my unsaved thoughts");
    fireEvent.keyDown(q('[data-ui="task-note-input"]')!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(puts).toHaveLength(1));
    const saved = puts[0]!.plans[0]!.tasks.find((t) => t.id === "t_00000002")!;
    expect(saved).toMatchObject({ note: "my unsaved thoughts", status: "blocked" });
    expect(puts[0]!.rev).toBe(4); // the fresh rev, so no stale overwrite
  });
});

describe("editing a task in the modal submits only what the user changed", () => {
  it("an agent change made while the modal is open is not rolled back by saving an unrelated field", async () => {
    mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>(".plan-task-row")!);
    await waitFor(() => expect(q('[data-ui="edit-task"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="edit-task"]')!);
    const title = await waitFor(() => { const el = document.querySelector<HTMLInputElement>('.plan-modal input'); expect(el).not.toBeNull(); return el!; });
    // the agent changes status and due behind the open modal; the page reloads
    serverDoc = { ...serverDoc, rev: 4, plans: serverDoc.plans.map((p) => p.id !== "p_0000000a" ? p : { ...p, tasks: p.tasks.map((t) => t.id === "t_00000002" ? { ...t, status: "blocked" as const, due: "2026-11-11" } : t) }) };
    await act(async () => { for (const cb of h.planChanged) cb(); });
    fireEvent.change(title, { target: { value: "Retitled by user" } });
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".plan-modal button")].find((b) => b.getAttribute("data-ui") === "submit-task-form")!);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.plans[0]!.tasks.find((t) => t.id === "t_00000002")).toMatchObject({ title: "Retitled by user", status: "blocked", due: "2026-11-11" });
  });
});

describe("shared task-order rules", () => {
  it("the UI helpers are the contracts functions the Copilot tool applies", () => {
    expect(model.reorderWithinStatus).toBe(contracts.reorderWithinStatus);
    expect(model.moveToColumn).toBe(contracts.moveToColumn);
    expect(PLAN_ICONS).toBe(contracts.PLAN_ICONS);
  });
});

describe("agent-writable note display", () => {
  it("shows live HTML, images and dangerous links inertly, keeps math, and never rewrites the stored note", async () => {
    const note = '<script>window.__pwned=1</script>\n\nhello <img src=x onerror="window.__pwned=2"> [bad](javascript:alert(1)) [ok](https://example.org) $a_i \\cdot b_j$';
    serverDoc = { ...makeDoc(), plans: [plan("p_0000000a", "Alpha", [task(1, { note })]) as never] };
    mountPlan();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>(".plan-task-row")!);
    await waitFor(() => expect(q('[data-ui="task-note-view"]')).not.toBeNull());
    const view = q('[data-ui="task-note-view"]')!;
    expect(view.querySelectorAll("script, img, [onerror]")).toHaveLength(0);
    expect([...view.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.org"]);
    expect(view.querySelector(".katex")).not.toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(puts).toHaveLength(0);
    expect(serverDoc.plans[0]!.tasks[0]!.note).toBe(note);
  });
});

describe("Shell routes a Copilot navigation request to the Plan page", () => {
  const boot = async (route = "/") => {
    window.history.replaceState(null, "", route);
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
  };
  it("switches the visible Plan page", async () => {
    await boot();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    await act(async () => { expect(await h.viewAction!({ action: "show", view: "board", planId: "p_0000000b" })).toEqual({ ok: true }); });
    await waitFor(() => expect(pressed("board")).toBe("true"));
    expect(q('[data-ui="plan-toolbar"]')?.getAttribute("data-ui-key")).toBe("p_0000000b");
  });
  it("opens the Plan page in the active pane when none is shown, then applies the action", async () => {
    papers = ["d1"];
    await boot();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="doc"]')!);
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    expect(q('[data-ui="plan-view"]')).toBeNull();
    let result: unknown;
    // No act() wrapper: React only flushes the pane switch outside act while this promise is pending.
    result = await h.viewAction!({ action: "open_task", taskId: "t_00000009" });
    expect(result).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="task-drawer"]')?.getAttribute("data-ui-key")).toBe("t_00000009"));
    expect(q('[data-ui="doc-stub"]')).toBeNull();
  });
  it("reports leave_blocked and leaves the page alone when the open Doc has unsaved work", async () => {
    papers = ["d1"];
    const release = registerWorkspaceLeaveGuard(() => false);
    try {
      await boot();
      await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
      fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="doc"]')!);
      await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
      let result: unknown;
      result = await h.viewAction!({ action: "show", view: "list" });
      expect(result).toEqual({ ok: false, detail: "leave_blocked" });
      expect(q('[data-ui="doc-stub"]')).not.toBeNull();
    } finally { release(); }
  });
});
