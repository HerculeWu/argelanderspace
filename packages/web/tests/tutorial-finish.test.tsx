/**
 * The finish page (in-app-tutorial ticket 23): registered last, reached by finishing the last chapter or straight from
 * the chapter rail, docked at the bottom right, with its three ways out; closing stays in the tutorial project.
 */
import type { TutorialProgress } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { FINISH, FINISH_STEP_ID } from "../src/tutorial/chapters/finish";
import { TutorialRunner, type RunnerDeps } from "../src/tutorial/TutorialLayer";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

const host = vi.hoisted(() => ({ pick: null as null | (() => Promise<boolean>) }));
vi.mock("../src/host", async (original) => ({ ...(await original<typeof import("../src/host")>()), useHostRequest: (kind: string) => (kind === "pick_folder" ? host.pick : null) }));

const AT = "2026-10-21T02:00:00.000Z";
const VISIBLE = () => ({ rect: new DOMRect(10, 10, 40, 20), visible: true });
/** The last step before the finish page: the last registered chapter's last step. */
const BEFORE_FINISH = CHAPTERS.filter((c) => c.id !== FINISH.id);
const LAST_CHAPTER_STEPS = BEFORE_FINISH[BEFORE_FINISH.length - 1]!.steps;
const LAST = LAST_CHAPTER_STEPS[LAST_CHAPTER_STEPS.length - 1]!;

function setup(over: { position?: string; desktop?: boolean; steps?: TutorialProgress["steps"] } = {}) {
  const put = vi.fn(async (_progress: TutorialProgress) => ({}));
  const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: VISIBLE, rendered: () => true };
  render(
    <TutorialRunner
      initial={fakeProgress({ position: over.position ?? FINISH_STEP_ID, steps: over.steps ?? {} })}
      context={fakePage("plan")}
      onViewAction={vi.fn(async () => ({ ok: true }))}
      desktop={over.desktop ?? true}
      entered
      deps={deps}
    />,
  );
  return { put };
}
const lastWrite = (put: { mock: { calls: [TutorialProgress][] } }) => put.mock.calls[put.mock.calls.length - 1]![0];
const ui = (name: string, key?: string) => document.querySelector(`[data-ui="${name}"]${key ? `[data-ui-key="${key}"]` : ""}`) as HTMLElement | null;
const card = () => ui("tutorial-step-card");
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  host.pick = null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the finish page is registered last", () => {
  it("one step without anchor, gate or requirement", () => {
    expect(CHAPTERS[CHAPTERS.length - 1]).toBe(FINISH);
    expect(FINISH.steps.map((s) => s.id)).toEqual([FINISH_STEP_ID]);
    expect(FINISH.steps[0]).toMatchObject({ anchors: [] });
    expect(FINISH.steps[0]!.gate).toBeUndefined();
    expect(FINISH.steps[0]!.requires).toBeUndefined();
  });
});

describe("when the finish page appears", () => {
  it("after the last chapter: its last step's button says 'Finish tutorial' and leads to the finish page", async () => {
    const { put } = setup({ position: LAST.id });
    await tick(16);
    expect(ui("tutorial-next")?.textContent).toBe("完成教程");
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(ui("tutorial-finish")).not.toBeNull();
    expect(card()?.getAttribute("data-ui-key")).toBe(FINISH_STEP_ID);
    expect(card()?.getAttribute("data-state")).toBe("none");
    expect(lastWrite(put)).toMatchObject({ position: FINISH_STEP_ID, steps: { [LAST.id]: { state: "done" } } });
    // Docked, no spotlight.
    expect(ui("tutorial-highlight")).toBeNull();
    expect(card()?.className).toContain("docked");
  });
  it("straight from the chapter rail: its last row, a flag without a state line", async () => {
    setup({ position: "prepare.settings" });
    await tick(16);
    const rows = [...document.querySelectorAll('[data-ui="tutorial-chapter"]')];
    const row = rows[rows.length - 1] as HTMLElement;
    expect(row.getAttribute("data-ui-key")).toBe(FINISH.id);
    expect(row.textContent).toBe("结束");
    expect(row.querySelector(".tut-ch-state")).toBeNull();
    fireEvent.click(row);
    await tick(16);
    expect(ui("tutorial-finish")).not.toBeNull();
    expect(row.getAttribute("aria-current")).toBe("step");
    // No step list under the finish row.
    expect(ui("tutorial-step", FINISH_STEP_ID)).toBeNull();
  });
  it("the finish page shows its title, body and the two notes", async () => {
    setup();
    await tick(16);
    expect(card()?.querySelector("h2")?.textContent).toBe("教程走完了");
    expect(card()?.textContent).toContain("这个项目会留着，随时能回来。");
    expect(ui("tutorial-finish-settings-note")?.textContent).toBe("外观、语言和日志级别都在设置页改。");
    expect(ui("tutorial-finish-trouble-note")?.textContent).toContain("「导出诊断包…」");
    // No Next / Skip of a step card.
    expect(ui("tutorial-next")).toBeNull();
    expect(ui("tutorial-skip-step")).toBeNull();
  });
});

describe("the three ways out", () => {
  it("desktop: 'Open your own project' asks the desktop app for the folder picker (the same request as 'Open another folder…')", async () => {
    const pick = vi.fn(async () => true);
    host.pick = pick;
    setup();
    await tick(16);
    expect(ui("tutorial-finish-open-own-browser")).toBeNull();
    fireEvent.click(ui("tutorial-finish-open-own")!);
    await tick(0);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(ui("tutorial-finish-open-own-failed")).toBeNull();
  });
  it("desktop: a request the desktop app did not take is said in the card", async () => {
    host.pick = vi.fn(async () => false);
    setup();
    await tick(16);
    fireEvent.click(ui("tutorial-finish-open-own")!);
    await tick(0);
    expect(ui("tutorial-finish-open-own-failed")?.textContent).toContain("桌面应用没有接受这个请求。");
  });
  it("browser form: no button, the command to run in a terminal", async () => {
    setup({ desktop: false });
    await tick(16);
    expect(ui("tutorial-finish-open-own")).toBeNull();
    const line = ui("tutorial-finish-open-own-browser")!;
    expect(line.textContent).toContain("argelanderspace serve");
    expect(line.querySelector("code")?.textContent).toBe("argelanderspace serve");
  });
  it("'Review any chapter' opens the folded chapter rail and puts the focus on its first chapter", async () => {
    setup();
    await tick(16);
    fireEvent.click(ui("toggle-tutorial-chapters")!);
    await tick(16);
    expect(ui("tutorial-chapter-rail")?.classList.contains("collapsed")).toBe(true);
    fireEvent.click(ui("tutorial-finish-review")!);
    await tick(16);
    expect(ui("tutorial-chapter-rail")?.classList.contains("collapsed")).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('[data-ui="tutorial-chapter"]'));
  });
  it("'Close the tutorial' records the finish page done and leaves the capsule (still in the tutorial project), which reopens it", async () => {
    const { put } = setup();
    await tick(16);
    fireEvent.click(ui("tutorial-finish-close")!);
    await tick(16);
    expect(card()).toBeNull();
    expect(ui("exit-tutorial-dialog")).toBeNull();
    expect(lastWrite(put)).toMatchObject({ position: FINISH_STEP_ID, steps: { [FINISH_STEP_ID]: { state: "done" } } });
    const capsule = ui("tutorial-capsule")!;
    expect(capsule.textContent).toBe("教程");
    fireEvent.click(capsule);
    await tick(16);
    expect(ui("tutorial-finish")).not.toBeNull();
  });
});

describe("a product modal on the finish page (review B1)", () => {
  it("the finish card yields below the dialog's overlay like a step card and takes no input; it comes back when the dialog closes", async () => {
    setup();
    await tick(16);
    expect(card()?.className).not.toContain("yielded");
    expect(card()?.hasAttribute("inert")).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="dialog-overlay"></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
    expect(card()?.getAttribute("data-state")).toBe("modal");
    expect(card()?.hasAttribute("inert")).toBe(true);
    expect(ui("tutorial-modal-yield")?.textContent).toBe("关掉对话框后继续");
    ui("dialog-overlay")!.remove();
    await tick(32);
    expect(card()?.className).not.toContain("yielded");
    expect(card()?.hasAttribute("inert")).toBe(false);
    expect(card()?.getAttribute("data-state")).toBe("none");
  });
  it("the tutorial's own leave dialog, opened from the finish card, puts the card below its overlay", async () => {
    setup();
    await tick(16);
    fireEvent.click(ui("exit-tutorial", "card")!);
    await tick(32);
    expect(ui("exit-tutorial-dialog")).not.toBeNull();
    expect(card()?.className).toContain("yielded");
    expect(card()?.hasAttribute("inert")).toBe(true);
  });
  it("a Writer dialog's overlay counts as a product modal too (review B2)", async () => {
    setup();
    await tick(16);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="writer-dialog-overlay"></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
  });
});
