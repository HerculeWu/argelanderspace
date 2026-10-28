/**
 * Chapter 9 "intake" (project-intake ticket 07): registration and numbering, the replay's "take me there" (the registered
 * `open_copilot` carrying the preset conversation's id), the degraded form while no preset conversation is given
 * (`intakeChapter(null)`; the sample now holds one, recorded by ticket 10), nothing sent by the tutorial, a finished tutorial's progress file read with the new steps, and the copy's guards.
 * The preset conversation here is a temporary fixture, not part of the sample.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { PageContext, TutorialProgress } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { INTAKE, intakeChapter } from "../src/tutorial/chapters/intake";
import { FINISH, FINISH_STEP_ID } from "../src/tutorial/chapters/finish";
import { alignPosition, chapterStatus, nextStepId, previousStepId } from "../src/tutorial/machine";
import { SAMPLE_INTAKE_CONVERSATION } from "../src/tutorial/sample-ids";
import { stepNumber } from "../src/tutorial/ChapterRail";
import { TutorialRunner, type RunnerDeps } from "../src/tutorial/TutorialLayer";
import type { ChapterDefinition, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeDom, fakePage, fakeProgress, fakeSnapshot } from "./tutorial-fixtures";

vi.mock("../src/host", async (original) => ({ ...(await original<typeof import("../src/host")>()), useHostRequest: () => null }));

const AT = "2026-10-27T02:00:00.000Z";
const FIXTURE = { id: "11111111-2222-4333-8444-555555555555", replies: { interview: "aa11bb22", summary: "cc33dd44" } } as const;
const WITH_REPLAY = intakeChapter(FIXTURE);
const step = (chapter: ChapterDefinition, id: string): StepDefinition => chapter.steps.find((s) => s.id === id)!;
const shape = (anchors: StepDefinition["anchors"]) => anchors.map((a) => [a.ui, a.key ?? null]);

function panel(open: boolean, dom: Record<string, Record<string, string>> = {}): WorkbenchSnapshot {
  const page = fakePage("doc") as unknown as { workspace: Record<string, unknown> };
  page.workspace = { ...page.workspace, copilotOpen: open };
  return fakeSnapshot({ page: page as unknown as PageContext, dom: fakeDom(dom) });
}

describe("chapter 9 is registered between the Copilot chapter and the finish page", () => {
  it("its steps and numbers: 9.1, 9.2 and the agent card 9.A; the finish page becomes the tenth entry", () => {
    expect(CHAPTERS.map((c) => c.id).slice(-3)).toEqual(["copilot", "intake", "finish"]);
    expect(INTAKE.n).toBe(9);
    expect(CHAPTERS.map((c) => c.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(FINISH.n).toBe(10);
    expect(INTAKE.steps.map((s) => s.id)).toEqual(["intake.interview", "intake.summary", "intake.agent"]);
    expect(INTAKE.steps.map((s) => stepNumber(INTAKE, s))).toEqual(["9.1", "9.2", "9.A"]);
    expect(INTAKE.steps.map((s) => s.kind)).toEqual(["look", "look", "agent"]);
  });
  it("nothing to type, no gate, no TeX: only looks and the agent card (Next moves on by itself)", () => {
    for (const s of INTAKE.steps) {
      expect(s.gate).toBeUndefined();
      expect(s.needsTex).toBeFalsy();
      expect(s.preparedText).toBeUndefined();
      expect(s.sources).toBeUndefined();
    }
    expect(step(INTAKE, "intake.agent").anchors).toEqual([]);
    expect(step(INTAKE, "intake.agent").requires).toBeUndefined();
  });
  it("Next/Back cross into and out of the chapter: 8.A -> 9.1 ... 9.A -> finish page", () => {
    expect(nextStepId(CHAPTERS, "copilot.agent")).toBe("intake.interview");
    expect(previousStepId(CHAPTERS, "intake.interview")).toBe("copilot.agent");
    expect(nextStepId(CHAPTERS, "intake.agent")).toBe(FINISH_STEP_ID);
    expect(previousStepId(CHAPTERS, FINISH_STEP_ID)).toBe("intake.agent");
  });
});

describe("the replay: 'take me there' is the registered open_copilot carrying the conversation id", () => {
  it("with a preset conversation: the anchors climb from the messages area to the reply, 'take me there' names the conversation", () => {
    expect(shape(step(WITH_REPLAY, "intake.interview").anchors)).toEqual([["copilot-messages", null], ["copilot-message", "aa11bb22"]]);
    expect(shape(step(WITH_REPLAY, "intake.summary").anchors)).toEqual([["copilot-messages", null], ["copilot-message", "cc33dd44"]]);
    for (const id of ["intake.interview", "intake.summary"]) {
      expect(step(WITH_REPLAY, id).requires?.takeMeThere).toEqual({ action: "open_copilot", conversationId: FIXTURE.id });
      expect(step(WITH_REPLAY, id).requires?.where).toBe("copilot");
    }
  });
  it("the requirement is the panel open AND the replay shown (its reply is in the page); closed, or showing another conversation, is not met", () => {
    const r = step(WITH_REPLAY, "intake.interview").requires!;
    expect(r.test(panel(true, { "copilot-message[aa11bb22]": {} }))).toBe(true);
    expect(r.test(panel(true))).toBe(false); // open on another conversation
    expect(r.test(panel(false, { "copilot-message[aa11bb22]": {} }))).toBe(false);
    const s = step(WITH_REPLAY, "intake.summary").requires!;
    expect(s.test(panel(true, { "copilot-message[aa11bb22]": {} }))).toBe(false); // the summary reply is its own
    expect(s.test(panel(true, { "copilot-message[cc33dd44]": {} }))).toBe(true);
  });
  it("degraded while the sample holds no move-in conversation: the messages area is the anchor and the panel open is enough", () => {
    const bare = intakeChapter(null);
    for (const id of ["intake.interview", "intake.summary"]) {
      expect(shape(step(bare, id).anchors)).toEqual([["copilot-messages", null]]);
      expect(step(bare, id).requires?.takeMeThere).toEqual({ action: "open_copilot" });
      expect(step(bare, id).requires?.test(panel(true))).toBe(true);
      expect(step(bare, id).requires?.test(panel(false))).toBe(false);
    }
  });
  it("the registered chapter points at the recorded conversation's two replies (ticket 15)", () => {
    expect(SAMPLE_INTAKE_CONVERSATION).toEqual({ id: "fee7ecc0-b8e9-49b0-9ac7-a582faaa984c", replies: { interview: "f84833ef", summary: "af6c9a4f" } });
    expect(shape(step(INTAKE, "intake.interview").anchors)).toEqual([["copilot-messages", null], ["copilot-message", "f84833ef"]]);
    expect(shape(step(INTAKE, "intake.summary").anchors)).toEqual([["copilot-messages", null], ["copilot-message", "af6c9a4f"]]);
    expect(step(INTAKE, "intake.interview").requires?.takeMeThere).toEqual({ action: "open_copilot", conversationId: "fee7ecc0-b8e9-49b0-9ac7-a582faaa984c" });
    expect(step(INTAKE, "intake.interview").bodyKey).toBeUndefined();
  });
});

describe("in the layer", () => {
  const VISIBLE = () => ({ rect: new DOMRect(400, 300, 40, 20), box: new DOMRect(400, 300, 40, 20), visible: true });
  function setup(chapters: readonly ChapterDefinition[], position: string, context: PageContext) {
    const put = vi.fn(async (_progress: TutorialProgress): Promise<unknown> => ({}));
    const onViewAction = vi.fn(async () => ({ ok: true }));
    const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: VISIBLE, rendered: () => true };
    const props = { initial: fakeProgress({ position }), context, onViewAction, desktop: true, entered: true, chapters, deps };
    const view = render(<TutorialRunner {...props} />);
    return { ...view, put, onViewAction, rerender: (next: PageContext) => view.rerender(<TutorialRunner {...props} context={next} />) };
  }
  const ui = (name: string, key?: string) => document.querySelector(`[data-ui="${name}"]${key ? `[data-ui-key="${key}"]` : ""}`) as HTMLElement | null;
  const card = () => ui("tutorial-step-card");
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const open = (copilotOpen: boolean) => { const page = fakePage("doc") as unknown as { workspace: Record<string, unknown> }; page.workspace = { ...page.workspace, copilotOpen }; return page as unknown as PageContext; };
  const withReplay = CHAPTERS.map((c) => (c.id === "intake" ? WITH_REPLAY : c));
  const withoutReplay = CHAPTERS.map((c) => (c.id === "intake" ? intakeChapter(null) : c));
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
    fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

  it("a closed panel docks 9.1 with the hint and 'take me there', which runs only the registered action (no request, no write)", async () => {
    const { onViewAction, put } = setup(withReplay, "intake.interview", open(false));
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("requires");
    expect(ui("tutorial-requires")?.textContent).toContain("先回到Copilot 面板");
    const writes = put.mock.calls.length;
    fireEvent.click(ui("tutorial-take-me-there")!);
    expect(onViewAction).toHaveBeenCalledTimes(1);
    expect(onViewAction).toHaveBeenCalledWith({ action: "open_copilot", conversationId: FIXTURE.id });
    await tick(16);
    expect(put.mock.calls.length).toBe(writes);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("once the replay is shown the card anchors on its reply; Next goes 9.1 -> 9.2 -> 9.A -> finish page, each recorded done, still no request", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="copilot-messages"><article data-ui="copilot-message" data-ui-key="aa11bb22"></article><article data-ui="copilot-message" data-ui-key="cc33dd44"></article></div>`);
    const { put } = setup(withReplay, "intake.interview", open(true));
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    expect(card()?.textContent).toContain("迁入是一场访谈");
    expect(card()?.textContent).toContain("回放里的 Copilot");
    expect(card()?.textContent).toContain("1/3");
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("intake.summary");
    expect(card()?.textContent).toContain("每批一张汇总表");
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("intake.agent");
    expect(card()?.getAttribute("data-state")).toBe("none");
    expect(ui("tutorial-next")?.textContent).toBe("完成教程");
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe(FINISH_STEP_ID);
    const last = put.mock.calls[put.mock.calls.length - 1]![0];
    expect(last).toMatchObject({ position: FINISH_STEP_ID, steps: { "intake.interview": { state: "done" }, "intake.summary": { state: "done" }, "intake.agent": { state: "done" } } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a preset conversation (a build without the sample): the open panel is enough, the card reads on the messages area and Next works", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="copilot-messages"></div>`);
    setup(withoutReplay, "intake.interview", open(true));
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    expect(ui("tutorial-requires")).toBeNull();
    expect(card()?.textContent).toContain("迁入是一场访谈");
    expect(card()?.textContent).toContain("迁入时，Copilot 先问你的 Project 文件夹");
    expect(card()?.textContent).not.toContain("回放");
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("intake.summary");
    expect(card()?.textContent).not.toContain("回放");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a closed panel without a preset conversation still offers 'take me there' = the plain open_copilot", async () => {
    const { onViewAction } = setup(withoutReplay, "intake.summary", open(false));
    await tick(16);
    fireEvent.click(ui("tutorial-take-me-there")!);
    expect(onViewAction).toHaveBeenCalledWith({ action: "open_copilot" });
  });

  it("the agent card 9.A has the prompt and skill of the intake skill, as agent cards do", async () => {
    setup(CHAPTERS, "intake.agent", open(false));
    await tick(16);
    expect(card()?.textContent).toContain("外部 agent 帮你准备");
    expect(card()?.textContent).toContain("argelander-project-intake");
    expect(card()?.textContent).toContain("3/3");
  });
});

describe("a progress file written before chapter 9 existed", () => {
  const OLD: TutorialProgress["steps"] = Object.fromEntries(
    CHAPTERS.filter((c) => c.id !== "intake").flatMap((c) => c.steps.map((s) => [s.id, { state: "done" as const, at: AT }])),
  );
  it("keeps its position (the finish page); the new chapter is simply not started, the rest stay done", () => {
    expect(alignPosition(CHAPTERS, FINISH_STEP_ID)).toBe(FINISH_STEP_ID);
    expect(chapterStatus(INTAKE, OLD, FINISH_STEP_ID)).toBe("notStarted");
    for (const c of CHAPTERS.filter((c) => c.id !== "intake" && c.id !== "finish")) expect(chapterStatus(c, OLD, FINISH_STEP_ID)).toBe("done");
  });
  it("a position at the old last step (8.A) goes on to 9.1 on Next", () => {
    expect(alignPosition(CHAPTERS, "copilot.agent")).toBe("copilot.agent");
    expect(nextStepId(CHAPTERS, "copilot.agent")).toBe("intake.interview");
  });
  describe("shown by the layer", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] }); });
    afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ""; });
    it("opens on the finish page as before, the rail lists chapter 9 as not started, and nothing is written", async () => {
      const put = vi.fn(async () => ({}));
      const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: () => ({ rect: new DOMRect(1, 1, 1, 1), visible: true }), rendered: () => true };
      render(<TutorialRunner initial={fakeProgress({ position: FINISH_STEP_ID, steps: { ...OLD, [FINISH_STEP_ID]: { state: "done", at: AT } } })} context={fakePage("plan")} onViewAction={vi.fn(async () => ({ ok: true }))} desktop entered deps={deps} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      expect(document.querySelector('[data-ui="tutorial-step-card"]')?.getAttribute("data-ui-key")).toBe(FINISH_STEP_ID);
      const row = document.querySelector('[data-ui="tutorial-chapter"][data-ui-key="intake"]') as HTMLElement;
      expect(row.getAttribute("data-state")).toBe("notStarted");
      expect(row.textContent).toContain("迁入已有项目");
      const copilotRow = document.querySelector('[data-ui="tutorial-chapter"][data-ui-key="copilot"]') as HTMLElement;
      expect(copilotRow.getAttribute("data-state")).toBe("done");
      expect(put).not.toHaveBeenCalled();
    });
  });
});

describe("chapter 9 copy", () => {
  const LOCALES = fileURLToPath(new NodeURL("../src/locales", import.meta.url));
  const load = (name: string) => JSON.parse(readFileSync(`${LOCALES}/${name}`, "utf8")) as { tutorial: { steps: Record<string, Record<string, Record<string, string>>> } };
  const zh = load("zh-CN.json").tutorial.steps;
  const en = load("en.json").tutorial.steps;
  it("9.1 and 9.2 say what the approved prototype says: the checklist, never moving your files; the five rows, exact matches only", () => {
    expect(zh.intake!.interview!.body).toContain("迁入清单");
    expect(zh.intake!.interview!.body).toContain("从不移动、改写或删除");
    expect(en.intake!.interview!.body).toContain("intake checklist");
    expect(en.intake!.interview!.body).toContain("never moves, edits or deletes");
    expect(zh.intake!.summary!.body).toContain("新建、并入已有、被拒、失败、待定");
    expect(zh.intake!.summary!.body).toContain("精确命中");
    expect(en.intake!.summary!.body).toContain("created, merged into existing, rejected, failed, pending");
    expect(en.intake!.summary!.body).toContain("exact DOI or arXiv match");
  });
  it("without a replay 9.1 uses its own body, which does not speak of one; with one, the original body; 9.2 has a single body that never mentions a replay", () => {
    expect(step(intakeChapter(null), "intake.interview").bodyKey).toBe("bodyNoReplay");
    expect(step(WITH_REPLAY, "intake.interview").bodyKey).toBeUndefined();
    expect(step(intakeChapter(null), "intake.summary").bodyKey).toBeUndefined();
    expect(zh.intake!.interview!.body).toContain("回放里的 Copilot");
    expect(en.intake!.interview!.body).toContain("In the replay");
    for (const text of [zh.intake!.interview!.bodyNoReplay!, en.intake!.interview!.bodyNoReplay!, zh.intake!.summary!.body!, en.intake!.summary!.body!]) expect(text).not.toMatch(/回放|replay/i);
    // Both versions of 9.1 keep the facts the prototype fixed.
    expect(zh.intake!.interview!.bodyNoReplay).toContain("迁入清单");
    expect(zh.intake!.interview!.bodyNoReplay).toContain("从不移动、改写或删除");
    expect(en.intake!.interview!.bodyNoReplay).toContain("intake checklist");
    expect(en.intake!.interview!.bodyNoReplay).toContain("never moves, edits or deletes");
  });
  it("9.A: the Copilot writes, an external agent only prepares (ADR 0014); it names the real skill and the real checklist file", () => {
    for (const steps of [zh, en]) {
      expect(steps.intake!.agent!.skill).toBe("argelander-project-intake");
      expect(steps.intake!.agent!.prompt).toContain("argelanderspace-intake.md");
    }
    expect(zh.intake!.agent!.intro).toContain("写入由 Copilot 完成");
    expect(en.intake!.agent!.intro).toContain("Copilot does the writing");
  });
  it("0.A and 8.A (ruling 10): the intake skill only prepares there, the Copilot writes; 8.A no longer hands 'adding literature' to the external agent", () => {
    expect(zh.prepare!.agent!.intro).toContain("写入由工作台里的 Copilot 完成");
    expect(zh.prepare!.agent!.introBrowser).toContain("写入交给工作台里的 Copilot");
    expect(en.prepare!.agent!.intro).toContain("the Copilot in the workbench does the writing");
    expect(en.prepare!.agent!.introBrowser).toContain("the Copilot in the workbench does the writing");
    expect(zh.copilot!.agent!.intro).toContain("迁入的文献和计划由它写进 Project");
    expect(zh.copilot!.agent!.intro).not.toContain("添加文献");
    expect(en.copilot!.agent!.intro).toContain("it writes the moved-in literature and plans into the Project");
    expect(en.copilot!.agent!.intro).not.toMatch(/Adding literature/);
  });
  it("the finish page names the empty library's button as the product does, in both languages", () => {
    const label = (name: string) => (JSON.parse(readFileSync(`${LOCALES}/${name}`, "utf8")) as { library: { intake: { start: string } } }).library.intake.start;
    const finish = (steps: typeof zh) => steps.finish!.page!;
    expect(finish(zh).openOwnHint).toContain(`「${label("zh-CN.json")}」`);
    expect(finish(zh).openOwnBrowser).toContain(`「${label("zh-CN.json")}」`);
    expect(finish(en).openOwnHint).toContain(`“${label("en.json")}”`);
    expect(finish(en).openOwnBrowser).toContain(`“${label("en.json")}”`);
    expect(finish(en).openOwnBrowser).toContain("`argelanderspace serve`");
  });
  it("the card says 'three skills' and the Copilot allow-list has three", () => {
    const resources = readFileSync(fileURLToPath(new NodeURL("../../server/src/copilot-resources.ts", import.meta.url)), "utf8");
    const allowed = [...(resources.match(/COPILOT_SKILL_NAMES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)];
    expect(allowed).toHaveLength(3);
    expect(zh.copilot!.agent!.intro).toContain("三个 skill");
    expect(en.copilot!.agent!.intro).toContain("three skills");
  });
});
