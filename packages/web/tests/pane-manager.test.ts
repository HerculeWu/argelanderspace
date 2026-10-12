/**
 * The Shell's pane manager (copilot ticket 37) with fake page adapters and fake timers: how a view action finds or
 * opens its page's pane, waits for the page's controls, retries an `unavailable` answer, and refuses without moving
 * the user.
 */
import type { CopilotViewAction } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaneManager, type PaneAdapter, type PanePage, type ViewActionOutcome } from "../src/argelander/panes";

const SHOW = { action: "show", view: "list" } as CopilotViewAction;
const RETRY = { action: "retry_plans" } as CopilotViewAction;

/** A detached page: answers every action, never mounted. */
const page = (name: PanePage, over: Partial<PaneAdapter> = {}): PaneAdapter => ({
  page: name,
  status: () => "unavailable",
  context: () => ({}),
  handles: () => true,
  needsPane: () => "any",
  ...over,
});
/** A mounted page whose controller answers `answers` in turn (the last one repeats). */
function mounted(name: PanePage, answers: ViewActionOutcome[], over: Partial<PaneAdapter> = {}) {
  const calls: CopilotViewAction[] = [];
  const adapter = page(name, {
    apply: async (action) => {
      calls.push(action);
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    },
    ...over,
  });
  return { adapter, calls };
}
function setup(views: string[], kind: PaneAdapter, activeId = 1, confirmLeave = () => true) {
  return createPaneManager({ panes: views.map((view, i) => ({ id: i + 1, view, size: 1 })), activeId, pages: [kind], confirmLeave });
}
/** Settles the action while advancing fake time; resolves with the answer and the fake time it took. */
async function run(manager: ReturnType<typeof createPaneManager>, action: CopilotViewAction) {
  const started = Date.now();
  let answer: ViewActionOutcome | undefined;
  void manager.runViewAction(action).then((value) => { answer = value; });
  for (let step = 0; step < 1000 && answer === undefined; step++) await vi.advanceTimersByTimeAsync(10);
  return { answer, elapsed: Date.now() - started };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("an action with no pane of its page (needsPane any)", () => {
  it("switches the active pane to the page and waits for its controls", async () => {
    const manager = setup(["library"], page("plan"));
    const target = mounted("plan", [{ ok: true }]);
    void vi.advanceTimersByTimeAsync(300).then(() => manager.register(1, target.adapter));
    const { answer } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: true });
    expect(manager.getState().panes[0]!.view).toBe("plan");
    expect(target.calls).toEqual([SHOW]);
  });

  it("controls that never appear: unavailable once the ready wait is over, never tried", async () => {
    const manager = setup(["library"], page("plan"));
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(2100);
  });

  it("a page with readyMs 0 does not wait for its controls first: the apply rounds give it the time", async () => {
    const manager = setup(["plan"], page("library", { timeouts: { readyMs: 0, applyMs: 2000 } }));
    const target = mounted("library", [{ ok: true }]);
    void vi.advanceTimersByTimeAsync(500).then(() => manager.register(1, target.adapter));
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(700);
  });

  it("a Doc pane with unsaved work refuses at once: leave_blocked, nothing switched, nothing waited for", async () => {
    const manager = setup(["doc"], page("plan"), 1, () => false);
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "leave_blocked" });
    expect(elapsed).toBeLessThan(50);
    expect(manager.getState().panes[0]!.view).toBe("doc");
  });

  it("noPaneResult answers instead of opening the page", async () => {
    const manager = setup(["plan"], page("write", { noPaneResult: () => ({ ok: true }) }));
    const { answer } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: true });
    expect(manager.getState().panes[0]!.view).toBe("plan");
  });

  it("a page with `open` shows its object itself, and then gets openedApplyMs", async () => {
    let shown = false;
    const manager = setup(["plan", "doc"], page("doc", { shows: () => shown, open: async () => { shown = true; return { ok: true }; }, timeouts: { readyMs: 0, applyMs: 2000, openedApplyMs: 5000 } }));
    const target = mounted("doc", [{ ok: false, detail: "unavailable" }]);
    manager.register(2, target.adapter);
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(target.calls).toHaveLength(100);
    expect(manager.getState().activeId).toBe(2);
  });

  it("an `open` that fails answers its own result", async () => {
    const manager = setup(["plan"], page("doc", { shows: () => false, open: async () => ({ ok: false, detail: "not_found" }) }));
    expect((await run(manager, SHOW)).answer).toEqual({ ok: false, detail: "not_found" });
  });
});

describe("an unavailable answer is retried for the page's applyMs", () => {
  it("retries every 50 ms until the page answers", async () => {
    const manager = setup(["plan"], page("plan"));
    const target = mounted("plan", [{ ok: false, detail: "unavailable" }, { ok: false, detail: "unavailable" }, { ok: false, detail: "not_found" }]);
    manager.register(1, target.adapter);
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "not_found" });
    expect(target.calls).toHaveLength(3);
    expect(elapsed).toBeLessThan(150);
  });

  it("gives up as unavailable after 2 s (40 tries)", async () => {
    const manager = setup(["plan"], page("plan"));
    const target = mounted("plan", [{ ok: false, detail: "unavailable" }]);
    manager.register(1, target.adapter);
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(target.calls).toHaveLength(40);
    expect(elapsed).toBeGreaterThanOrEqual(2000);
  });

  it("applyMs 0 tries once and does not wait", async () => {
    const manager = setup(["write"], page("write", { timeouts: { readyMs: 2000, applyMs: 0 } }));
    const target = mounted("write", [{ ok: false, detail: "unavailable" }]);
    manager.register(1, target.adapter);
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(target.calls).toHaveLength(1);
    expect(elapsed).toBeLessThan(20);
  });

  it("passes the page's own fields through (http, folded)", async () => {
    const manager = setup(["library"], page("library"));
    manager.register(1, mounted("library", [{ ok: false, detail: "failed", http: 503 }]).adapter);
    expect((await run(manager, SHOW)).answer).toEqual({ ok: false, detail: "failed", http: 503 });
  });
});

describe("the page's pane is found again every round", () => {
  it("a pane closed during the wait ends it at once as unavailable", async () => {
    const manager = setup(["plan", "library"], page("plan"));
    const target = mounted("plan", [{ ok: false, detail: "unavailable" }]);
    manager.register(1, target.adapter);
    void vi.advanceTimersByTimeAsync(220).then(() => manager.close(1));
    const { answer, elapsed } = await run(manager, SHOW);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(elapsed).toBeLessThan(400);
  });

  it("follows the user to another pane of the page and makes it active", async () => {
    const manager = setup(["plan", "plan"], page("plan"));
    const first = mounted("plan", [{ ok: false, detail: "unavailable" }]);
    const second = mounted("plan", [{ ok: true }]);
    manager.register(1, first.adapter);
    manager.register(2, second.adapter);
    void vi.advanceTimersByTimeAsync(120).then(() => manager.select(2));
    expect((await run(manager, SHOW)).answer).toEqual({ ok: true });
    expect(second.calls).toEqual([SHOW]);
    expect(manager.getState().activeId).toBe(2);
  });

  it("uses the active pane of the page, else the first one, and activates it", async () => {
    const manager = setup(["library", "plan", "plan"], page("plan"));
    const second = mounted("plan", [{ ok: true }]);
    const third = mounted("plan", [{ ok: true }]);
    manager.register(2, second.adapter);
    manager.register(3, third.adapter);
    await run(manager, SHOW);
    expect(second.calls).toHaveLength(1);
    expect(manager.getState().activeId).toBe(2);
    manager.select(3);
    await run(manager, SHOW);
    expect(third.calls).toHaveLength(1);
  });
});

describe("refusals never move the user (active-only, existing-only, available)", () => {
  it("active-only: only the active pane, and only when it is available", async () => {
    const kind = page("library", { needsPane: () => "active-only" });
    const manager = setup(["library", "plan"], kind, 2);
    const library = mounted("library", [{ ok: true }], { available: () => true });
    manager.register(1, library.adapter);
    expect((await run(manager, SHOW)).answer).toEqual({ ok: false, detail: "unavailable" });
    expect(manager.getState().activeId).toBe(2);
    expect(manager.getState().panes.map((pane) => pane.view)).toEqual(["library", "plan"]);
    manager.select(1);
    expect((await run(manager, SHOW)).answer).toEqual({ ok: true });
  });

  it("active-only: an active pane that is not available is unavailable, and is never switched away from", async () => {
    const manager = setup(["library"], page("library", { needsPane: () => "active-only" }));
    const library = mounted("library", [{ ok: true }], { available: () => false });
    manager.register(1, library.adapter);
    expect((await run(manager, SHOW)).answer).toEqual({ ok: false, detail: "unavailable" });
    expect(library.calls).toHaveLength(0);
  });

  it("active-only: the pane stays pinned; becoming inactive does not move the action elsewhere", async () => {
    const manager = setup(["library", "library"], page("library", { needsPane: () => "active-only" }));
    const first = mounted("library", [{ ok: false, detail: "unavailable" }, { ok: true }], { available: () => true });
    const second = mounted("library", [{ ok: true }], { available: () => true });
    manager.register(1, first.adapter);
    manager.register(2, second.adapter);
    void vi.advanceTimersByTimeAsync(20).then(() => manager.select(2));
    expect((await run(manager, SHOW)).answer).toEqual({ ok: true });
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(0);
  });

  it("existing-only: no pane of the page is unavailable and nothing is opened", async () => {
    const manager = setup(["library"], page("plan", { needsPane: () => "existing-only" }));
    const { answer, elapsed } = await run(manager, RETRY);
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
    expect(elapsed).toBeLessThan(20);
    expect(manager.getState().panes[0]!.view).toBe("library");
  });

  it("existing-only with `shows`: a pane that shows another object counts as none", async () => {
    const manager = setup(["doc"], page("doc", { needsPane: () => "existing-only", shows: () => false, open: async () => ({ ok: true }) }));
    manager.register(1, mounted("doc", [{ ok: true }]).adapter);
    expect((await run(manager, RETRY)).answer).toEqual({ ok: false, detail: "unavailable" });
  });

  it("available is asked before any switch: none available answers `refused`, the active pane stays", async () => {
    const kind = page("plan", { needsPane: () => "existing-only", available: () => true, refused: () => ({ ok: false, detail: "disabled" }) });
    const manager = setup(["plan", "library"], kind, 2);
    const plan = mounted("plan", [{ ok: true }], { available: () => false });
    manager.register(1, plan.adapter);
    expect((await run(manager, RETRY)).answer).toEqual({ ok: false, detail: "disabled" });
    expect(manager.getState().activeId).toBe(2);
    expect(plan.calls).toHaveLength(0);
  });

  it("available: the first available pane (active first) is the one used, and it becomes active", async () => {
    const kind = page("plan", { needsPane: () => "existing-only", available: () => true });
    const manager = setup(["plan", "library", "plan"], kind, 2);
    const first = mounted("plan", [{ ok: true }], { available: () => false });
    const third = mounted("plan", [{ ok: true }], { available: () => true });
    manager.register(1, first.adapter);
    manager.register(3, third.adapter);
    expect((await run(manager, RETRY)).answer).toEqual({ ok: true });
    expect(third.calls).toHaveLength(1);
    expect(first.calls).toHaveLength(0);
    expect(manager.getState().activeId).toBe(3);
  });

  it("existing-only retries stay on available panes: another pane of the page that becomes active but is not available is not used", async () => {
    const kind = page("plan", { needsPane: () => "existing-only", available: () => true });
    const manager = setup(["plan", "plan"], kind);
    const first = mounted("plan", [{ ok: false, detail: "unavailable" }, { ok: true }], { available: () => true });
    const second = mounted("plan", [{ ok: true }], { available: () => false });
    manager.register(1, first.adapter);
    manager.register(2, second.adapter);
    void vi.advanceTimersByTimeAsync(20).then(() => manager.select(2));
    expect((await run(manager, RETRY)).answer).toEqual({ ok: true });
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(0);
  });

  it("without a refused answer, none available is unavailable", async () => {
    const manager = setup(["plan"], page("plan", { needsPane: () => "existing-only", available: () => true }));
    manager.register(1, mounted("plan", [{ ok: true }], { available: () => false }).adapter);
    expect((await run(manager, RETRY)).answer).toEqual({ ok: false, detail: "unavailable" });
  });
});

describe("whenReady and routing", () => {
  it("whenReady counts only the page asked for, and its ready() once it has one", async () => {
    const manager = setup(["plan"], page("plan"));
    let controls = false;
    manager.register(1, page("library"));
    let done: boolean | undefined;
    void manager.whenReady(1, "plan", 2000).then((value) => { done = value; });
    await vi.advanceTimersByTimeAsync(100);
    manager.register(1, page("plan", { ready: () => controls }));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBeUndefined();
    controls = true;
    await vi.advanceTimersByTimeAsync(60);
    expect(done).toBe(true);
  });

  it("an action no page handles is unavailable", async () => {
    const manager = setup(["plan"], page("plan", { handles: () => false }));
    expect((await run(manager, SHOW)).answer).toEqual({ ok: false, detail: "unavailable" });
  });

  it("a page unregistered by another adapter's pane mount is kept (only its own unregister removes it)", () => {
    const manager = setup(["plan"], page("plan"));
    const older = page("plan", { status: () => "error" });
    const newer = page("plan", { status: () => "complete" });
    const forgetOlder = manager.register(1, older);
    manager.register(1, newer);
    forgetOlder();
    expect(manager.pageOf(manager.getState().panes[0]!)?.status()).toBe("complete");
  });
});

describe("each page adapter keeps its page's own status rule", () => {
  // Only the fields a rule reads; the pages themselves are covered by the *-copilot-parity tests.
  const as = <T,>(value: object) => value as T;
  it("Plan: complete with a page, else error (never unavailable)", async () => {
    const { createPlanPane } = await import("../src/plan/plan-pane");
    const plan = createPlanPane(() => {});
    expect(plan.adapter.status()).toBe("error");
    plan.props.onContext(1, as({ rev: 1 }));
    expect(plan.adapter.status()).toBe("complete");
  });
  it("Library: live complete, error error, else unavailable; an exploration replaces the Library page", async () => {
    const { createLibraryPane } = await import("../src/library/library-pane");
    const library = createLibraryPane(() => {});
    library.props.onContext(1, as({ source: "example" }));
    expect(library.adapter.status()).toBe("unavailable");
    library.props.onContext(1, as({ source: "live" }));
    expect(library.adapter.status()).toBe("complete");
    library.props.onContext(1, as({ source: "error" }));
    expect(library.adapter.status()).toBe("error");
    library.props.onDiscovery(1, as({ graph: null, error: null }));
    expect(library.adapter.status()).toBe("unavailable");
    expect(library.adapter.context()).toMatchObject({ library: null });
    library.props.onDiscovery(1, as({ graph: {}, error: null }));
    expect(library.adapter.status()).toBe("complete");
    library.props.onDiscovery(1, as({ graph: null, error: "x" }));
    expect(library.adapter.status()).toBe("error");
  });
  it("Doc: the PDF page first, then the source panel, then the Reader", async () => {
    const { createDocPane } = await import("../src/doc/doc-pane-adapter");
    const doc = createDocPane(() => {}, { currentDoc: () => null, openDoc: async () => ({ ok: true }) });
    expect(doc.adapter.status()).toBe("unavailable");
    doc.props.onContext(1, as({ reading: null, sync: { phase: "missing" } }));
    expect(doc.adapter.status()).toBe("error");
    doc.props.onContext(1, as({ reading: {}, sync: { phase: "ready" } }));
    expect(doc.adapter.status()).toBe("complete");
    doc.props.onTextContext(1, as({ phase: "loading" }));
    expect(doc.adapter.status()).toBe("unavailable");
    doc.props.onPdfContext(1, as({ phase: "changed" }));
    expect(doc.adapter.status()).toBe("error");
    doc.props.onPdfContext(1, as({ phase: "ready" }));
    expect(doc.adapter.status()).toBe("complete");
  });
  it("Mail: complete once ready, else unavailable (never error); it has no view actions", async () => {
    const { createMailPane } = await import("../src/mail/mail-pane");
    const mail = createMailPane(() => {});
    mail.props.onContext(1, as({ phase: "error" }));
    expect(mail.adapter.status()).toBe("unavailable");
    mail.props.onContext(1, as({ phase: "ready" }));
    expect(mail.adapter.status()).toBe("complete");
    expect(mail.adapter.apply).toBeUndefined();
    expect(mail.adapter.handles({ action: "show", view: "list" } as CopilotViewAction)).toBe(false);
  });
  it("a page reporting the same value again is not a change", async () => {
    const { createPlanPane } = await import("../src/plan/plan-pane");
    const notify = vi.fn();
    const plan = createPlanPane(notify);
    const page = as<never>({ rev: 1 });
    plan.props.onContext(1, page);
    plan.props.onContext(1, page);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("leave-draft protection on a Library pane (an unsaved argument draft, ticket 05)", () => {
  it("switching away from, or closing, a Library pane asks with its view; staying does not; refused, nothing moves", () => {
    const asked: string[] = [];
    let allow = false;
    const manager = createPaneManager({ panes: [{ id: 1, view: "library", size: 1 }, { id: 2, view: "plan", size: 1 }], activeId: 1, pages: [page("library")], confirmLeave: (view) => {
      asked.push(view);
      return allow;
    } });
    expect(manager.setActiveView("library")).toBe(true);
    expect(asked).toEqual([]);
    expect(manager.setActiveView("plan")).toBe(false);
    expect(manager.setPaneView(1, "write")).toBe(false);
    expect(manager.close(1)).toBe(false);
    expect(asked).toEqual(["library", "library", "library"]);
    expect(manager.getState().panes.map((p) => p.view)).toEqual(["library", "plan"]);
    expect(manager.close(2)).toBe(true); // a Plan pane has nothing to protect
    allow = true;
    expect(manager.setActiveView("plan")).toBe(true);
    expect(manager.getState().panes[0]!.view).toBe("plan");
  });
});
