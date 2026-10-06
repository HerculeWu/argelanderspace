/**
 * Copilot-driven Shell control (ticket 12): the bound view executes workspace actions through the same
 * callbacks as the Shell's controls, so the pane limit, the divider rule and the leave-draft protection are
 * the UI's own, and the result it reports is what the page really did.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CopilotViewAction, PageContext, PlansFile } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { PageContextSchema } from "@argelanderspace/contracts";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard } from "../src/argelander/workspace";
import i18n from "../src/i18n";

const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  openPanel: null as null | (() => void),
  open: false,
  ready: true,
}));
vi.mock("../src/api/ws", () => ({
  onPlanChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
  onAnnotationChanged: () => () => {},
  onWriterChanged: () => () => {},
}));
vi.mock("../src/copilot/Copilot", () => ({
  Copilot: ({ onViewAction, context, onOpenPanel, open, viewReady }: { onViewAction: typeof h.viewAction; context: PageContext; onOpenPanel: () => void; open: boolean; viewReady?: boolean }) => {
    h.viewAction = onViewAction; h.context = context; h.openPanel = onOpenPanel; h.open = open; h.ready = viewReady !== false;
    return <textarea data-ui="copilot-input" aria-label="copilot-input" />;
  },
}));
vi.mock("../src/doc/DocPane", () => ({ DocPane: () => <div data-ui="doc-stub" /> }));
vi.mock("../src/library/LibraryView", () => ({ LibraryView: () => <div data-ui="library-stub" /> }));
vi.mock("../src/writer/WriterView", () => ({ WriterView: () => <div data-ui="writer-stub" /> }));

const task = (n: number, over: object = {}) => ({ id: `t_${String(n).padStart(8, "0")}`, title: `Task ${n}`, status: "todo", due: "2026-12-31", links: [], focused: false, created_at: "2026-09-01T08:00:00.000Z", ...over });
const plan = (id: string, name: string, tasks: object[]) => ({ id, name, due: "2026-12-31", icon: "target", created_at: "2026-08-01T08:00:00.000Z", tasks });
let serverDoc: PlansFile;
let papers: string[];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.sessionStorage.clear(); window.localStorage.clear();
  papers = ["d1", "d2"];
  serverDoc = { version: 1, rev: 3, plans: [plan("p_0000000a", "Alpha", [task(1), task(2, { status: "done" })])] } as PlansFile;
  h.viewAction = null; h.context = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    if (url === "/api/plans" && method === "GET") return ok(serverDoc);
    if (url === "/api/library") return ok({ project: { name: "P" }, refs: [], tags: [], graph: { nodes: [], links: [] } });
    if (url === "/api/papers") return ok({ papers });
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
// No act() wrapper: React only flushes the Shell's state changes outside act while the action waits for them.
const run = async (action: CopilotViewAction) => h.viewAction!(action);
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
}
const paneIds = () => qa('[data-ui="workspace-pane"]').map((pane) => Number(pane.getAttribute("data-ui-key")));
const ctx = () => h.context!;

describe("view switching, split, close and select go through the Shell's own callbacks", () => {
  it("switches the active pane like the activity bar, and a named pane like the pane menu", async () => {
    await boot();
    expect(await run({ action: "switch_view", view: "library" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-stub"]')).not.toBeNull());
    expect(q('[data-ui="navigate-view"][data-ui-key="library"]')?.getAttribute("aria-current")).toBe("page");
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    expect(await run({ action: "switch_view", view: "write", paneId: 1 })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="writer-stub"]')).not.toBeNull());
    expect(ctx().workspace?.activePaneId).toBe(1); // a named pane becomes active, as the menu does
    expect(await run({ action: "switch_view", view: "plan", paneId: 99 })).toEqual({ ok: false, detail: "not_found" });
  });

  it("at most three panes: the fourth split is refused as disabled, exactly like the disabled button", async () => {
    await boot();
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    await waitFor(() => expect(paneIds()).toHaveLength(3));
    expect((q('[data-ui="split-pane"]') as HTMLButtonElement).disabled).toBe(true);
    expect(await run({ action: "split_pane" })).toEqual({ ok: false, detail: "disabled" });
    expect(paneIds()).toHaveLength(3);
    expect(ctx().workspace?.panes).toHaveLength(3);
  });

  it("closes a named pane, refuses the last one, and selects a pane without raising any window", async () => {
    const focusWindow = vi.spyOn(window, "focus");
    await boot();
    await run({ action: "split_pane" });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    expect(await run({ action: "select_pane", paneId: 1 })).toEqual({ ok: true });
    await waitFor(() => expect(ctx().workspace?.activePaneId).toBe(1));
    expect(await run({ action: "close_pane", paneId: 2 })).toEqual({ ok: true });
    await waitFor(() => expect(paneIds()).toEqual([1]));
    expect(await run({ action: "close_pane", paneId: 1 })).toEqual({ ok: false, detail: "disabled" });
    expect(await run({ action: "select_pane", paneId: 7 })).toEqual({ ok: false, detail: "not_found" });
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it("resizes with the divider rule: a request the drag could not reach is refused, not clamped", async () => {
    await boot();
    await run({ action: "split_pane" });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    expect(await run({ action: "resize_pane", paneId: 1, share: 0.7 })).toEqual({ ok: true });
    await waitFor(() => expect(ctx().workspace?.panes.map((pane) => pane.share)).toEqual([0.7, 0.3]));
    await run({ action: "split_pane" });
    await waitFor(() => expect(paneIds()).toHaveLength(3));
    expect(await run({ action: "resize_pane", paneId: 1, share: 0.84 })).toEqual({ ok: false, detail: "disabled" });
  });
});

describe("the Plan page's load-failure Retry is a view action (ticket 32 gap G1)", () => {
  it("retry_plans presses Retry on the failed Plan page and reports what the page then showed", async () => {
    let planStatus = 500;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url === "/api/plans" && method === "GET") return planStatus === 200 ? ok(serverDoc) : ({ ok: false, status: planStatus, json: async () => ({}) } as unknown as Response);
      if (url === "/api/library") return ok({ project: { name: "P" }, refs: [], tags: [], graph: { nodes: [], links: [] } });
      if (url === "/api/papers") return ok({ papers });
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }));
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await waitFor(() => expect(q('[data-ui="retry-plans"]')).not.toBeNull());
    // still failing: the Retry ran and the page is still the failure page
    expect(await run({ action: "retry_plans" })).toEqual({ ok: false, detail: "failed" });
    expect(q('[data-ui="retry-plans"]')).not.toBeNull();
    planStatus = 200;
    expect(await run({ action: "retry_plans" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
    expect(q('[data-ui="retry-plans"]')).toBeNull();
    // a loaded page has no Retry button: nothing to press
    expect(await run({ action: "retry_plans" })).toEqual({ ok: false, detail: "disabled" });
  });
});

describe("retry_plans presses only a Retry that exists (ticket 32 fix round 1, S1)", () => {
  it("with no Plan pane open it opens nothing and answers unavailable", async () => {
    await boot();
    expect(await run({ action: "switch_view", view: "library" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-stub"]')).not.toBeNull());
    expect(await run({ action: "retry_plans" })).toEqual({ ok: false, detail: "unavailable" });
    expect(q('[data-ui="plan-toolbar"]')).toBeNull();
    expect(q('[data-ui="navigate-view"][data-ui-key="library"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("a loaded Plan page in another pane: refused as disabled, and the active pane stays where the user is", async () => {
    await boot();
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    expect(await run({ action: "switch_view", view: "library", paneId: 2 })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-stub"]')).not.toBeNull());
    expect(ctx().workspace?.activePaneId).toBe(2);
    expect(await run({ action: "retry_plans" })).toEqual({ ok: false, detail: "disabled" });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let a (wrong) pane switch render
    expect(ctx().workspace?.activePaneId).toBe(2);
  });

  it("a Plan page whose first load is still running has no Retry button: disabled, nothing reloaded", async () => {
    const gate: { release: () => void } = { release: () => {} };
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url === "/api/plans" && method === "GET") {
        gets++;
        await new Promise<void>((resolve) => { gate.release = resolve; });
        return ok(serverDoc);
      }
      if (url === "/api/library") return ok({ project: { name: "P" }, refs: [], tags: [], graph: { nodes: [], links: [] } });
      if (url === "/api/papers") return ok({ papers });
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }));
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await waitFor(() => expect(gets).toBe(1));
    expect(await run({ action: "retry_plans" })).toEqual({ ok: false, detail: "disabled" });
    expect(gets).toBe(1);
    gate.release();
    await waitFor(() => expect(q('[data-ui="plan-toolbar"]')).not.toBeNull());
  });
});

describe("the leave-draft protection holds for Copilot requests too", () => {
  it("a Doc pane with unsaved work keeps its page; the request reports leave_blocked and nothing changes", async () => {
    await boot();
    fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="doc"]')!);
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    const release = registerWorkspaceLeaveGuard(() => false);
    try {
      expect(await run({ action: "switch_view", view: "library" })).toEqual({ ok: false, detail: "leave_blocked" });
      expect(q('[data-ui="doc-stub"]')).not.toBeNull();
      await run({ action: "split_pane" }); // splitting copies the view; it does not leave the Doc
      await waitFor(() => expect(paneIds()).toHaveLength(2));
      expect(await run({ action: "close_pane", paneId: 1 })).toEqual({ ok: false, detail: "leave_blocked" });
      expect(paneIds()).toHaveLength(2);
      expect(await run({ action: "open_task_doc", taskId: "t_00000001", docId: "d2" })).toEqual({ ok: false, detail: "leave_blocked" });
    } finally { release(); }
    // Once the work is saved the same request goes through.
    expect(await run({ action: "switch_view", view: "library", paneId: 1 })).toEqual({ ok: true });
  });
});

describe("appearance goes through the Tweaks setter", () => {
  it("sets theme, accent, density and language like the popover, and persists them the same way", async () => {
    await boot();
    expect(await run({ action: "set_appearance", theme: "light", density: "compact", accent: "teal", language: "zh-CN" })).toEqual({ ok: true });
    const root = document.documentElement;
    // The setter returns once the state is set; the attributes and the stored copy follow in the next effect flush,
    // which a loaded machine can delay: wait for them instead of reading them in the same tick.
    await waitFor(() => {
      expect(root.getAttribute("data-theme")).toBe("light");
      expect(root.getAttribute("data-density")).toBe("compact");
      expect(root.lang).toBe("zh-CN");
      expect(JSON.parse(window.localStorage.getItem("argelander.tweaks")!)).toMatchObject({ theme: "light", density: "compact", accent: "teal", language: "zh-CN" });
    });
    await waitFor(() => expect(ctx().workspace?.appearance).toEqual({ theme: "light", accent: "teal", density: "compact", language: "zh-CN" }));
    await i18n.changeLanguage("en");
  });
});

describe("the context carries the layout, and the view identity survives a reload", () => {
  it("publishes panes, shares, appearance and whether Copilot is open", async () => {
    await boot();
    await run({ action: "split_pane" });
    await waitFor(() => expect(ctx().workspace?.panes).toHaveLength(2));
    expect(ctx().workspace).toMatchObject({ maxPanes: 3, activePaneId: 2, copilotOpen: false, panes: [{ paneId: 1, view: "plan", share: 0.5 }, { paneId: 2, view: "plan", share: 0.5 }] });
    act(() => h.openPanel!());
    await waitFor(() => expect(ctx().workspace?.copilotOpen).toBe(true));
    expect(h.open).toBe(true);
  });

  it("keeps the same view id after a reload and never publishes an older revision", async () => {
    const first = render(<Shell />);
    await waitFor(() => expect(h.context).not.toBeNull());
    await run({ action: "split_pane" });
    await waitFor(() => expect(ctx().workspace?.panes).toHaveLength(2));
    const before = { viewId: ctx().viewId, revision: ctx().revision };
    first.unmount();
    h.context = null;
    render(<Shell />);
    await waitFor(() => expect(h.context).not.toBeNull());
    expect(ctx().viewId).toBe(before.viewId);
    expect(ctx().revision).toBeGreaterThan(before.revision);
  });
});

describe("a task's linked Doc opens like the drawer button", () => {
  it("opens a known Doc in a Doc pane; an unknown one is not_found; the Reader is not touched otherwise", async () => {
    await boot();
    expect(await run({ action: "open_task_doc", taskId: "t_00000001", docId: "d2" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    expect(new URL(window.location.href).pathname).toContain("d2");
    expect(await run({ action: "open_task_doc", taskId: "t_00000001", docId: "gone" })).toEqual({ ok: false, detail: "not_found" });
  });

  it("finds a Doc ingested after the page loaded by rereading the paper list once", async () => {
    await boot();
    papers = ["d1", "d2", "fresh"];
    expect(await run({ action: "open_task_doc", taskId: "t_00000001", docId: "fresh" })).toEqual({ ok: true });
  });
});

describe("the completed group fold", () => {
  const folded = () => qa('[data-ui="task-row"], .plan-task-row').some((row) => row.textContent?.includes("Task 2"));
  it("expands and folds the group like its own button, only in the list view, and only if there is one", async () => {
    await boot();
    const button = () => q('[data-ui="toggle-completed-tasks"]');
    await waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.getAttribute("aria-expanded")).toBe("false");
    expect(folded()).toBe(false);
    expect(await run({ action: "set_completed", expanded: true })).toEqual({ ok: true });
    await waitFor(() => expect(button()!.getAttribute("aria-expanded")).toBe("true"));
    expect(folded()).toBe(true);
    await waitFor(() => expect(ctx().plan?.ui?.completedExpanded).toBe(true));
    expect(await run({ action: "set_completed", expanded: false })).toEqual({ ok: true });
    await waitFor(() => expect(button()!.getAttribute("aria-expanded")).toBe("false"));
    // The board has no such group: honestly unavailable, never "ok".
    fireEvent.click(q('[data-ui="plan-display-mode"][data-ui-key="board"]')!);
    await waitFor(() => expect(button()).toBeNull());
    expect(await run({ action: "set_completed", expanded: true })).toEqual({ ok: false, detail: "unavailable" });
  });
  it("a plan without completed tasks has no group to fold: not_found", async () => {
    serverDoc = { version: 1, rev: 3, plans: [plan("p_0000000a", "Alpha", [task(1)])] } as PlansFile;
    await boot();
    expect(await run({ action: "set_completed", expanded: true })).toEqual({ ok: false, detail: "not_found" });
  });
});

describe("open a Doc, and show or hide the Copilot panel", () => {
  it("opens a library Doc through openDoc into the Doc pane (else the active one); unknown Docs are not_found", async () => {
    await boot();
    await run({ action: "split_pane" });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    expect(await run({ action: "open_doc", docId: "d2" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    expect(qa('[data-ui="doc-stub"]')).toHaveLength(1);
    expect(window.location.pathname).toContain("d2");
    expect(await run({ action: "open_doc", docId: "not-in-library" })).toEqual({ ok: false, detail: "not_found" });
    expect(window.location.pathname).toContain("d2"); // the page was not touched
  });
  it("is held back by unsaved work in the open Doc, like the Reader's own switch", async () => {
    await boot();
    expect(await run({ action: "open_doc", docId: "d1" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    const release = registerWorkspaceLeaveGuard(() => false);
    try {
      expect(await run({ action: "open_doc", docId: "d2" })).toEqual({ ok: false, detail: "leave_blocked" });
      expect(window.location.pathname).toContain("d1");
    } finally { release(); }
  });
  it("the panel opens and closes through the toolbar's own state, and the context says which", async () => {
    await boot();
    expect(ctx().workspace?.copilotOpen).toBe(false);
    expect(await run({ action: "open_copilot" })).toEqual({ ok: true });
    await waitFor(() => expect(h.open).toBe(true));
    expect(q('[data-ui="copilot-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(await run({ action: "close_copilot" })).toEqual({ ok: true });
    await waitFor(() => expect(h.open).toBe(false));
  });
});

describe("opening the panel with its toggle", () => {
  it("moves focus to the Copilot input; closing it, or a model-driven open, does not", async () => {
    await boot();
    const toggle = q('[data-ui="copilot-toggle"]') as HTMLElement;
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(document.activeElement).toBe(q('[data-ui="copilot-input"]')));
    toggle.focus();
    fireEvent.click(toggle); // closes
    await waitFor(() => expect(h.open).toBe(false));
    expect(document.activeElement).toBe(toggle);
    expect(await run({ action: "open_copilot" })).toEqual({ ok: true });
    await waitFor(() => expect(h.open).toBe(true));
    expect(document.activeElement).toBe(toggle);
  });
});

describe("the published appearance is always one the service accepts", () => {
  it("damaged stored tweaks are normalised in the context (the page itself is left alone)", async () => {
    window.localStorage.setItem("argelander.tweaks", JSON.stringify({ theme: "sepia", accent: "red", density: "huge", language: "fr" }));
    await boot();
    expect(ctx().workspace?.appearance).toEqual({ theme: "dark", accent: "azure", density: "regular", language: "zh-CN" });
    expect(PageContextSchema.safeParse(ctx()).success).toBe(true);
  });
});

describe("an action only the list can do never moves the user first", () => {
  it("set_completed with the Plan page in board mode, or no Plan page at all, changes nothing", async () => {
    await boot();
    fireEvent.click(q('[data-ui="plan-display-mode"][data-ui-key="board"]')!);
    await run({ action: "split_pane" });
    await waitFor(() => expect(paneIds()).toEqual([1, 2]));
    await run({ action: "switch_view", view: "library", paneId: 2 });
    await waitFor(() => expect(q('[data-ui="library-stub"]')).not.toBeNull());
    expect(ctx().workspace?.activePaneId).toBe(2);
    expect(await run({ action: "set_completed", expanded: true })).toEqual({ ok: false, detail: "unavailable" });
    expect(ctx().workspace?.activePaneId).toBe(2); // not taken to the Plan pane
    await run({ action: "switch_view", view: "doc", paneId: 1 });
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    expect(await run({ action: "set_completed", expanded: true })).toEqual({ ok: false, detail: "unavailable" });
    expect(q('[data-ui="plan-view"]')).toBeNull(); // no Plan page was opened just to fail
  });
});

describe("a tab does not subscribe or publish until its view id is known to be its own", () => {
  const withLocks = (request: (name: string, options: unknown, callback: (lock: unknown) => unknown) => Promise<unknown>) =>
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });
  afterEach(() => { Reflect.deleteProperty(navigator, "locks"); });
  it("is not ready before the lock answers, and ready after it is granted", async () => {
    let grant!: () => void;
    withLocks((_n, _o, callback) => new Promise<void>((resolve) => { grant = () => { void callback({}); resolve(); }; }));
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    expect(h.ready).toBe(false);
    act(() => grant());
    await waitFor(() => expect(h.ready).toBe(true));
  });
  it("a duplicated tab leaves with a fresh id and is ready only under the new one", async () => {
    window.sessionStorage.setItem("argelander.copilot.view", JSON.stringify({ viewId: "6b6f5a9e-3c1d-4a8e-9f10-2a1f2b3c4d5e", revision: 5 }));
    const seenNames: string[] = [];
    withLocks(async (name, _o, callback) => { seenNames.push(name); await callback(seenNames.length === 1 ? null : {}); });
    render(<Shell />);
    await waitFor(() => expect(h.ready).toBe(true));
    expect(ctx().viewId).not.toBe("6b6f5a9e-3c1d-4a8e-9f10-2a1f2b3c4d5e");
    expect(seenNames).toHaveLength(2);
    expect(seenNames[1]).toBe(`argelander-view-${ctx().viewId}`);
  });
  it("React StrictMode's mount, cleanup, mount does not make a lone tab look duplicated: the id survives", async () => {
    const id = "6b6f5a9e-3c1d-4a8e-9f10-2a1f2b3c4d5e";
    window.sessionStorage.setItem("argelander.copilot.view", JSON.stringify({ viewId: id, revision: 2 }));
    const names: string[] = [];
    let held = false;
    withLocks(async (name, _o, callback) => { names.push(name); await callback(held ? null : {}); held = true; });
    render(<StrictMode><Shell /></StrictMode>);
    await waitFor(() => expect(h.ready).toBe(true));
    expect(ctx().viewId).toBe(id);
    expect(names).toEqual([`argelander-view-${id}`]);
  });
});
