/**
 * The tutorial layer's component seams (in-app-tutorial ticket 19): the runner against fake page contexts, a fake
 * progress endpoint and a fake measurement (happy-dom has no layout); the mount condition against faked modules.
 */
import type { PageContext, TutorialProgress } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { TutorialRunner, type RunnerDeps } from "../src/tutorial/TutorialLayer";
import type { ChapterDefinition } from "../src/tutorial/types";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

const AT = "2026-10-21T02:00:00.000Z";
const VISIBLE = () => ({ rect: new DOMRect(10, 10, 40, 20), visible: true });

function setup(over: Partial<Parameters<typeof TutorialRunner>[0]> & { deps?: Partial<RunnerDeps> } = {}) {
  const put = vi.fn(async (_progress: TutorialProgress) => ({}));
  const onViewAction = vi.fn(async () => ({ ok: true }));
  const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: VISIBLE, rendered: () => true, ...over.deps };
  const props = { initial: fakeProgress(), context: fakePage("plan"), onViewAction, desktop: true, entered: true, ...over, deps };
  const view = render(<TutorialRunner {...props} />);
  const rerender = (context: PageContext) => view.rerender(<TutorialRunner {...props} context={context} />);
  return { ...view, put, onViewAction, rerender };
}
const lastWrite = (put: { mock: { calls: [TutorialProgress][] } }) => put.mock.calls[put.mock.calls.length - 1]![0];
const card = () => document.querySelector('[data-ui="tutorial-step-card"]');
const ui = (name: string, key?: string) => document.querySelector(`[data-ui="${name}"]${key ? `[data-ui-key="${key}"]` : ""}`) as HTMLElement | null;
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("entering", () => {
  it("entered another way: only the capsule; clicking it resumes at the recorded position", async () => {
    setup({ entered: false, initial: fakeProgress({ position: "tour.split" }) });
    await tick(0);
    expect(card()).toBeNull();
    const capsule = ui("tutorial-capsule")!;
    expect(capsule.textContent).toContain("教程 · 第 1 章");
    fireEvent.click(capsule);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.split");
  });
  it("entered through the entry: the card of the recorded step; a position no longer defined falls back", async () => {
    setup({ initial: fakeProgress({ position: "tour.gone" }) });
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.library");
  });
});

describe("gates, auto-advance, skip", () => {
  it("a gated step: Next disabled with the waiting line and the skip link; the gate passes, is written, moves on after 0.9 s", async () => {
    document.body.insertAdjacentHTML("beforeend", `<nav data-ui="primary-navigation"></nav>`);
    const { put, rerender } = setup({ initial: fakeProgress({ position: "tour.library" }) });
    await tick(0);
    expect((ui("tutorial-next") as HTMLButtonElement).disabled).toBe(true);
    expect(ui("tutorial-waiting")?.textContent).toContain("打开文献库后自动前进");
    expect(ui("tutorial-skip-step")).not.toBeNull();
    expect(ui("tutorial-highlight")?.className).toContain("pulse");
    rerender(fakePage("library"));
    await tick(0);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toMatchObject({ position: "tour.library", steps: { "tour.library": { state: "done", at: AT } } });
    expect(ui("tutorial-waiting")?.getAttribute("data-state")).toBe("passed");
    expect((ui("tutorial-next") as HTMLButtonElement).disabled).toBe(false);
    await tick(899);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.library");
    await tick(1);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.split");
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![0]).toMatchObject({ position: "tour.split" });
  });

  it("skip records skipped and moves on at once; coming back with the gate holding records done", async () => {
    const { put } = setup({ initial: fakeProgress({ position: "tour.palette" }) });
    await tick(0);
    fireEvent.click(ui("tutorial-skip-step")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.tweaks");
    expect(lastWrite(put)).toMatchObject({ position: "tour.tweaks", steps: { "tour.palette": { state: "skipped" } } });
    expect(ui("tutorial-step", "tour.palette")?.getAttribute("data-state")).toBe("skipped");
    // the user opens the command palette later, then comes back to the step
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="command-palette"></div>`);
    fireEvent.click(ui("tutorial-previous")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.palette");
    expect(put.mock.calls.some(([p]) => p.steps["tour.palette"]?.state === "done")).toBe(true);
    expect(ui("tutorial-step", "tour.palette")?.getAttribute("data-state")).toBe("done");
  });

  it("a step without a gate is recorded done by Next; Back is disabled on the very first step", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="workspace-pane" data-ui-key="1"><div data-ui="pane-header"></div></div>`);
    const { put } = setup({ initial: fakeProgress({ position: "prepare.settings" }) });
    await tick(0);
    expect((ui("tutorial-previous") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ui("tutorial-step", "tour.pane-views") ?? ui("tutorial-chapter", "tour")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.library");
    fireEvent.click(ui("tutorial-step", "tour.pane-views")!);
    await tick(0);
    fireEvent.click(ui("tutorial-next")!);
    await tick(0);
    expect(lastWrite(put)).toMatchObject({ position: "tour.close-pane", steps: { "tour.pane-views": { state: "done" } } });
  });
});

describe("docked cards", () => {
  it("anchor missing: waiting, then 'the interface has changed' after 3 s; Next stays usable", async () => {
    setup({ initial: fakeProgress({ position: "tour.tweaks" }) });
    await tick(0);
    expect(card()?.getAttribute("data-state")).toBe("waiting");
    expect(ui("tutorial-anchor-waiting")).not.toBeNull();
    await tick(2999);
    expect(ui("tutorial-anchor-missing")).toBeNull();
    await tick(1);
    expect(card()?.getAttribute("data-state")).toBe("missing");
    expect(ui("tutorial-anchor-missing")?.textContent).toContain("界面已变化");
    expect((ui("tutorial-next") as HTMLButtonElement).disabled).toBe(false);
    expect(ui("tutorial-highlight")).toBeNull();
  });
  it("the anchor appearing within 3 s anchors the card", async () => {
    setup({ initial: fakeProgress({ position: "tour.tweaks" }) });
    await tick(1000);
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    await tick(50);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    await tick(3000);
    expect(ui("tutorial-anchor-missing")).toBeNull();
  });
  it("out of view: docked with 'scroll to it'", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    setup({ initial: fakeProgress({ position: "tour.tweaks" }), deps: { measure: () => ({ rect: null, visible: false }) } });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("offscreen");
    expect(ui("scroll-to-tutorial-anchor")?.textContent).toBe("滚动到该位置");
  });
  it("requirement not met: 'first go back to Settings', only the hint (no registered action)", async () => {
    setup({ initial: fakeProgress({ position: "prepare.ads" }) });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("requires");
    expect(ui("tutorial-requires")?.textContent).toContain("先回到设置页");
    expect(ui("tutorial-take-me-there")).toBeNull();
  });
  it("a requirement with a registered action: 'take me there' runs it, nothing else", async () => {
    const chapters: ChapterDefinition[] = [
      { id: "tour", n: 1, steps: [{ id: "tour.library", kind: "look", anchors: [{ ui: "open-tweaks" }], requires: { test: (s) => s.page.view === "library", where: "library", takeMeThere: { action: "switch_view", view: "library" } } }] },
    ];
    const { onViewAction } = setup({ chapters, initial: fakeProgress({ position: "tour.library" }) });
    await tick(16);
    fireEvent.click(ui("tutorial-take-me-there")!);
    expect(onViewAction).toHaveBeenCalledWith({ action: "switch_view", view: "library" });
  });
  it("a product modal: the card yields and the spotlight hides; it comes back when the modal closes", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    setup({ initial: fakeProgress({ position: "tour.tweaks" }) });
    await tick(16);
    expect(ui("tutorial-highlight")).not.toBeNull();
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="dialog-overlay"></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
    expect(ui("tutorial-modal-yield")?.textContent).toBe("关掉对话框后继续");
    expect(ui("tutorial-highlight")).toBeNull();
    ui("dialog-overlay")!.remove();
    await tick(32);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
  });
  it("the browser form's agent card has no anchor: docked, with the browser copy and no skill line", async () => {
    setup({ desktop: false, initial: fakeProgress({ position: "prepare.agent" }) });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("none");
    expect(card()?.textContent).toContain("argelanderspace tutorial");
    expect(ui("tutorial-prepared-text")?.textContent).toContain("github.com/HerculeWu/argelanderspace/tree/main/skills");
    expect(ui("tutorial-agent-skills")).toBeNull();
    expect(ui("tutorial-agent-tag")?.textContent).toBe("也可以让 agent 做");
    expect(ui("tutorial-next")?.textContent).toBe("下一章");
  });
});

describe("prepared text", () => {
  it("copy reports success, and a refused clipboard as refused", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    onTestFinished(() => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });
    setup({ initial: fakeProgress({ position: "prepare.agent" }) });
    await tick(16);
    expect(ui("tutorial-agent-skills")?.textContent).toContain("argelander-read-paper");
    fireEvent.click(ui("copy-tutorial-text")!);
    await tick(0);
    expect(writeText).toHaveBeenCalledWith("读一遍 ArgelanderSpace 的 skills 目录，告诉我每个 skill 能做什么");
    expect(ui("copy-tutorial-text")?.textContent).toBe("已复制");
    fireEvent.click(ui("copy-tutorial-text")!);
    await tick(0);
    expect(ui("tutorial-copy-failed")?.textContent).toBe("没有复制成功：浏览器不允许写剪贴板");
    expect(ui("copy-tutorial-text")?.textContent).toBe("复制");
  });
});

describe("leaving and the capsule", () => {
  it("× asks with a dialog; staying keeps the card; leaving folds the rail into the capsule, which resumes", async () => {
    const { put } = setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
    fireEvent.click(ui("exit-tutorial", "card")!);
    await tick(0);
    expect(ui("exit-tutorial-dialog")?.textContent).toContain("退出教程？");
    fireEvent.click(ui("exit-tutorial-keep")!);
    await tick(0);
    expect(ui("exit-tutorial-dialog")).toBeNull();
    expect(card()).not.toBeNull();
    fireEvent.click(ui("exit-tutorial", "rail")!);
    await tick(0);
    fireEvent.click(ui("exit-tutorial-confirm")!);
    await tick(0);
    expect(card()).toBeNull();
    expect(ui("tutorial-chapter-rail")).toBeNull();
    expect(ui("tutorial-capsule")?.textContent).toContain("第 1 章");
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(ui("tutorial-capsule")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.pane-views");
  });
  it("Escape with nothing focused asks to leave; Escape while the command palette is open does not", async () => {
    setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="command-palette"></div>`);
    fireEvent.keyDown(window, { key: "Escape" });
    await tick(0);
    expect(ui("exit-tutorial-dialog")).toBeNull();
    ui("command-palette")!.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    await tick(0);
    expect(ui("exit-tutorial-dialog")).not.toBeNull();
  });
  it("Escape that the Shell uses to close the command palette (its listener came first) does not ask to leave", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="command-palette"></div>`);
    const shellEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") document.querySelector('[data-ui="command-palette"]')?.remove();
    };
    window.addEventListener("keydown", shellEscape);
    try {
      setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
      await tick(16);
      fireEvent.keyDown(window, { key: "Escape" });
      await tick(0);
      expect(ui("command-palette")).toBeNull();
      expect(ui("exit-tutorial-dialog")).toBeNull();
    } finally {
      window.removeEventListener("keydown", shellEscape);
    }
  });
});

describe("the rail folds away from the highlighted element (user ruling 2026-10-21)", () => {
  const RAIL = () => new DOMRect(62, 0, 232, 900);
  // The anchor of 0.3 under the rail (the settings groups), of 0.A on the right.
  const boxes: Record<string, DOMRect> = { "settings-group": new DOMRect(66, 200, 200, 40), "ads-credential": new DOMRect(320, 160, 800, 60) };
  const measure = (el: Element) => {
    const box = boxes[el.getAttribute("data-ui") ?? ""] ?? new DOMRect(400, 400, 40, 20);
    return { rect: box, box, visible: true };
  };
  const settings = () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="settings-group" data-ui-key="services"></button><button data-ui="settings-group" data-ui-key="cli"></button>`);
  };
  const collapsed = () => ui("tutorial-chapter-rail")?.classList.contains("collapsed");

  it("an anchor under the open rail folds it to 44 px; an anchor clear of it leaves it open", async () => {
    settings();
    setup({ context: fakePage("settings"), initial: fakeProgress({ position: "prepare.ads" }), deps: { measure, railBox: RAIL } });
    await tick(32);
    expect(collapsed()).toBe(true);
    cleanup();
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    setup({ initial: fakeProgress({ position: "tour.tweaks" }), deps: { measure, railBox: RAIL } });
    await tick(32);
    expect(collapsed()).toBe(false);
  });
  it("opened again by the user, it stays open for the rest of that step; the next covered step folds it again", async () => {
    settings();
    setup({ context: fakePage("settings"), initial: fakeProgress({ position: "prepare.ads" }), deps: { measure, railBox: RAIL } });
    await tick(32);
    expect(collapsed()).toBe(true);
    fireEvent.click(ui("toggle-tutorial-chapters")!);
    await tick(64);
    expect(collapsed()).toBe(false);
    fireEvent.click(ui("tutorial-next")!);
    await tick(64);
    expect(card()?.getAttribute("data-ui-key")).toBe("prepare.agent");
    expect(collapsed()).toBe(true);
  });
});

describe("progress not saved", () => {
  it("a failed write is reported once; the tutorial goes on (the notice stays until dismissed, see the review tests)", async () => {
    const put = vi.fn(async (_progress: TutorialProgress): Promise<unknown> => {
      throw new Error("write_failed");
    });
    setup({ initial: fakeProgress({ position: "tour.pane-views" }), deps: { put } });
    await tick(16);
    fireEvent.click(ui("tutorial-next")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.close-pane");
    expect(ui("tutorial-progress-not-saved")?.textContent).toContain("进度没有保存");
    fireEvent.click(ui("tutorial-skip-step")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.palette");
    expect(put).toHaveBeenCalledTimes(2);
    expect(ui("tutorial-progress-not-saved")).not.toBeNull();
  });
});

describe("the chapter rail", () => {
  const AT2 = { state: "done" as const, at: AT };
  const chapters: ChapterDefinition[] = [
    { id: "prepare", n: 0, steps: [{ id: "prepare.a", kind: "look", anchors: [] }] },
    { id: "tour", n: 1, steps: [{ id: "tour.a", kind: "look", anchors: [] }, { id: "tour.b", kind: "look", anchors: [] }] },
    { id: "library", n: 2, steps: [{ id: "library.a", kind: "look", anchors: [] }, { id: "library.b", kind: "do", anchors: [], gate: () => false, needsTex: true }] },
    { id: "reading", n: 3, steps: [{ id: "reading.a", kind: "look", anchors: [] }] },
  ];
  it("five states: not started, in progress, done, skipped, needs TeX (with check again)", async () => {
    const checkTex = vi.fn(async () => false);
    setup({ chapters, deps: { checkTex }, initial: fakeProgress({ position: "tour.b", steps: { "prepare.a": AT2, "library.a": AT2, "library.b": { state: "skipped", at: AT } } }) });
    await tick(16);
    const state = (id: string) => ui("tutorial-chapter", id)?.getAttribute("data-state");
    expect(state("prepare")).toBe("done");
    expect(state("tour")).toBe("inProgress");
    expect(state("library")).toBe("skipped");
    expect(state("reading")).toBe("notStarted");
    expect(ui("tutorial-chapter", "library")?.textContent).toContain("已跳过");
    // the separator before "needs TeX" is drawn by the stylesheet (no copy concatenated in code)
    expect(ui("tutorial-chapter", "library")?.querySelector('[data-ui="tutorial-chapter-needs-tex"]')?.textContent).toBe("需要 TeX");
    expect(ui("tutorial-chapter", "reading")?.textContent).toContain("未开始");
    expect(ui("tutorial-chapter", "tour")?.getAttribute("aria-current")).toBe("step");
    fireEvent.click(ui("tutorial-recheck-tex", "library")!);
    expect(checkTex).toHaveBeenCalledTimes(2);
  });
  it("a chapter picked in the rail goes to its first step; the rail collapses to 44 px numbers", async () => {
    setup({ chapters, initial: fakeProgress({ position: "tour.b" }) });
    await tick(16);
    fireEvent.click(ui("tutorial-chapter", "reading")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("reading.a");
    fireEvent.click(ui("toggle-tutorial-chapters")!);
    await tick(0);
    expect(ui("tutorial-chapter-rail")?.className).toContain("collapsed");
    expect(ui("tutorial-chapter", "reading")?.getAttribute("aria-label")).toContain("阅读与标注");
  });
  it("a needs-TeX step without TeX: warning with check again (busy while checking), skip is the way on", async () => {
    let resolve: (v: boolean) => void = () => {};
    const checkTex = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise<boolean>((r) => { resolve = r; }));
    setup({ chapters, deps: { checkTex }, initial: fakeProgress({ position: "library.b" }) });
    await tick(16);
    expect(ui("tutorial-needs-tex")?.textContent).toContain("本机没有找到 TeX");
    expect((ui("tutorial-next") as HTMLButtonElement).disabled).toBe(false);
    expect(ui("tutorial-skip-step")).not.toBeNull();
    fireEvent.click(ui("tutorial-recheck-tex", "card")!);
    await tick(0);
    expect(ui("tutorial-recheck-tex", "card")?.textContent).toBe("正在检查…");
    expect((ui("tutorial-recheck-tex", "card") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(true));
    expect(ui("tutorial-needs-tex")).toBeNull();
  });
});
