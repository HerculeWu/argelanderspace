/**
 * The tutorial layer after the ticket-19 review round: a gated step whose anchor is missing, the rail yielding to a
 * product modal, L2 data kept apart per step with its baseline taken after the step's first read, a needs-TeX step
 * without TeX, the auto-advance timer cancelled on leaving, unrendered rungs, the not-saved notice, Escape, a skipped
 * step shown again, 0.A's requirement, the shared controls and the measuring loop.
 */
import type { PageContext, TutorialProgress } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TutorialRunner, type RunnerDeps } from "../src/tutorial/TutorialLayer";
import type { ChapterDefinition, L2Source } from "../src/tutorial/types";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

const AT = "2026-10-21T02:00:00.000Z";
const VISIBLE = () => ({ rect: new DOMRect(400, 300, 40, 20), box: new DOMRect(400, 300, 40, 20), visible: true });

function setup(over: Partial<Parameters<typeof TutorialRunner>[0]> & { deps?: Partial<RunnerDeps> } = {}) {
  const put = vi.fn(async (_progress: TutorialProgress): Promise<unknown> => ({}));
  const onViewAction = vi.fn(async () => ({ ok: true }));
  const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: VISIBLE, rendered: () => true, ...over.deps };
  const props = { initial: fakeProgress(), context: fakePage("plan"), onViewAction, desktop: true, entered: true, ...over, deps };
  const view = render(<TutorialRunner {...props} />);
  const rerender = (context: PageContext) => view.rerender(<TutorialRunner {...props} context={context} />);
  return { ...view, put: (deps.put ?? put) as typeof put, onViewAction, rerender };
}
const lastWrite = (put: { mock: { calls: [TutorialProgress][] } }) => put.mock.calls[put.mock.calls.length - 1]![0];
const card = () => document.querySelector('[data-ui="tutorial-step-card"]');
const ui = (name: string, key?: string) => document.querySelector(`[data-ui="${name}"]${key ? `[data-ui-key="${key}"]` : ""}`) as HTMLElement | null;
const nextButton = () => ui("tutorial-next") as HTMLButtonElement;
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

describe("a gated step whose anchor is missing (review 1)", () => {
  it("waiting and then missing: Next is usable; Next records done and moves on in one write", async () => {
    // 1.1 is gated on the library view; its anchors are not on the page
    const { put } = setup({ initial: fakeProgress({ position: "tour.library" }) });
    await tick(0);
    expect(card()?.getAttribute("data-state")).toBe("waiting");
    expect(nextButton().disabled).toBe(false);
    await tick(3000);
    expect(card()?.getAttribute("data-state")).toBe("missing");
    expect(nextButton().disabled).toBe(false);
    fireEvent.click(nextButton());
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.split");
    expect(put).toHaveBeenCalledTimes(1);
    expect(lastWrite(put)).toMatchObject({ position: "tour.split", steps: { "tour.library": { state: "done" } } });
  });
  it("anchored or out of view, a gated step's Next stays disabled", async () => {
    document.body.insertAdjacentHTML("beforeend", `<nav data-ui="primary-navigation"></nav>`);
    setup({ initial: fakeProgress({ position: "tour.library" }), deps: { measure: () => ({ rect: null, box: null, visible: false }) } });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("offscreen");
    expect(nextButton().disabled).toBe(true);
  });
});

describe("a product modal (review 2)", () => {
  it("the chapter rail yields below the dialog's overlay and takes no input; it comes back when the dialog closes", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    setup({ initial: fakeProgress({ position: "tour.tweaks" }) });
    await tick(16);
    const rail = () => ui("tutorial-chapter-rail")!;
    expect(rail().classList.contains("yielded")).toBe(false);
    expect(rail().hasAttribute("inert")).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="dialog-overlay"></div>`);
    await tick(32);
    expect(rail().classList.contains("yielded")).toBe(true);
    expect(rail().hasAttribute("inert")).toBe(true);
    ui("dialog-overlay")!.remove();
    await tick(32);
    expect(rail().classList.contains("yielded")).toBe(false);
    expect(rail().hasAttribute("inert")).toBe(false);
  });
  it("the stylesheet puts the yielded rail below the overlay (z 250)", () => {
    const css = readFileSync(fileURLToPath(new NodeURL("../src/tutorial/tutorial.css", import.meta.url)), "utf8");
    const rule = /\.tut-rail\.yielded\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(Number(/z-index:\s*(\d+)/.exec(rule)?.[1])).toBeLessThan(250);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});

describe("L2 data and baselines (review 3)", () => {
  /** A source whose answers are queued by the test, and whose event the test fires. */
  function source(id: string) {
    const answers: unknown[] = [];
    let changed: () => void = () => {};
    const reads: Array<(v: unknown) => void> = [];
    const src: L2Source = {
      id,
      subscribe: (fn) => {
        changed = fn;
        return () => {
          changed = () => {};
        };
      },
      read: () => new Promise((resolve) => (answers.length ? resolve(answers.shift()) : reads.push(resolve))),
    };
    return { src, answer: (v: unknown) => (reads.length ? reads.shift()!(v) : answers.push(v)), fire: () => changed() };
  }

  it("a +N gate counts from the step's own first read, never from the step before's data", async () => {
    const a = source("count");
    const b = source("count");
    const chapters: ChapterDefinition[] = [
      {
        id: "library",
        n: 2,
        steps: [
          { id: "library.a", kind: "look", anchors: [], sources: [a.src] },
          {
            id: "library.b",
            kind: "do",
            anchors: [],
            sources: [b.src],
            gate: (s, run) => typeof s.data.count === "number" && typeof run.baseline.data.count === "number" && s.data.count >= run.baseline.data.count + 1,
          },
          { id: "library.c", kind: "look", anchors: [] },
        ],
      },
    ];
    a.answer(5);
    const { put } = setup({ chapters, initial: fakeProgress({ position: "library.a" }) });
    await tick(16);
    fireEvent.click(nextButton());
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("library.b");
    // the step's own first read: 10 (the step before saw 5); that is the baseline, not a pass
    await act(async () => b.answer(10));
    await tick(16);
    expect(put.mock.calls.some(([p]) => p.steps["library.b"]?.state === "done")).toBe(false);
    expect(nextButton().disabled).toBe(true);
    // one more Work: 11 = baseline + 1
    act(() => b.fire());
    await act(async () => b.answer(11));
    await tick(16);
    expect(put.mock.calls.some(([p]) => p.steps["library.b"]?.state === "done")).toBe(true);
  });
});

describe("a needs-TeX step without TeX (review 4)", () => {
  it("Next records it skipped and moves on, so the chapter can complete", async () => {
    const chapters: ChapterDefinition[] = [
      { id: "library", n: 2, steps: [{ id: "library.upload", kind: "do", anchors: [], gate: () => false, needsTex: true }] },
      { id: "reading", n: 3, steps: [{ id: "reading.a", kind: "look", anchors: [] }] },
    ];
    const { put } = setup({ chapters, deps: { checkTex: async () => false }, initial: fakeProgress({ position: "library.upload" }) });
    await tick(16);
    expect(ui("tutorial-needs-tex")).not.toBeNull();
    fireEvent.click(nextButton());
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("reading.a");
    expect(lastWrite(put)).toMatchObject({ position: "reading.a", steps: { "library.upload": { state: "skipped" } } });
    expect(ui("tutorial-chapter", "library")?.getAttribute("data-state")).toBe("skipped");
  });
});

describe("the auto-advance timer (review 5)", () => {
  it("leaving within 0.9 s after the gate passed does not move the position", async () => {
    document.body.insertAdjacentHTML("beforeend", `<nav data-ui="primary-navigation"></nav>`);
    const { put, rerender } = setup({ initial: fakeProgress({ position: "tour.library" }) });
    await tick(0);
    rerender(fakePage("library"));
    await tick(100);
    expect(put).toHaveBeenCalledTimes(1);
    fireEvent.click(ui("exit-tutorial", "rail")!);
    await tick(0);
    fireEvent.click(ui("exit-tutorial-confirm")!);
    await tick(2000);
    expect(put).toHaveBeenCalledTimes(1);
    fireEvent.click(ui("tutorial-capsule")!);
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.library");
  });
});

describe("unrendered rungs (review 6)", () => {
  it("a higher rung that is not rendered (hidden, zero-size) does not hide a lower one", async () => {
    document.body.insertAdjacentHTML("beforeend", `<nav data-ui="primary-navigation"></nav><button data-ui="navigate-view" data-ui-key="library" data-probe-hidden></button>`);
    const measure = vi.fn((el: Element) => ({ ...VISIBLE(), el }));
    setup({ initial: fakeProgress({ position: "tour.library" }), deps: { measure, rendered: (el) => !el.hasAttribute("data-probe-hidden") } });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    expect(measure.mock.calls[measure.mock.calls.length - 1]![0].getAttribute("data-ui")).toBe("primary-navigation");
    expect(ui("tutorial-highlight")).not.toBeNull();
  });
  it("an anchor that is present but not rendered counts as missing, not as out of view", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="open-tweaks"></button>`);
    setup({ initial: fakeProgress({ position: "tour.tweaks" }), deps: { rendered: () => false } });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("waiting");
    await tick(3000);
    expect(card()?.getAttribute("data-state")).toBe("missing");
  });
});

describe("progress not saved (review 7)", () => {
  const failing = () =>
    vi.fn(async (_progress: TutorialProgress): Promise<unknown> => {
      throw new Error("write_failed");
    });
  it("stays across steps until dismissed, shown once only", async () => {
    const put = failing();
    setup({ initial: fakeProgress({ position: "tour.pane-views" }), deps: { put } });
    await tick(16);
    fireEvent.click(nextButton());
    await tick(0);
    expect(ui("tutorial-progress-not-saved")).not.toBeNull();
    fireEvent.click(ui("tutorial-skip-step")!);
    await tick(0);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.palette");
    expect(ui("tutorial-progress-not-saved")).not.toBeNull();
    fireEvent.click(ui("dismiss-tutorial-progress-notice")!);
    await tick(0);
    expect(ui("tutorial-progress-not-saved")).toBeNull();
    fireEvent.click(ui("tutorial-skip-step")!);
    await tick(0);
    expect(ui("tutorial-progress-not-saved")).toBeNull();
  });
  it("the leave dialog does not say the progress is saved after a failed write", async () => {
    setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
    fireEvent.click(ui("exit-tutorial", "card")!);
    await tick(0);
    expect(ui("exit-tutorial-dialog")?.textContent).toContain("进度已经保存");
    cleanup();
    setup({ initial: fakeProgress({ position: "tour.pane-views" }), deps: { put: failing() } });
    await tick(16);
    fireEvent.click(nextButton());
    await tick(0);
    fireEvent.click(ui("exit-tutorial", "card")!);
    await tick(0);
    expect(ui("exit-tutorial-dialog")?.textContent).not.toContain("进度已经保存");
    expect(ui("exit-tutorial-dialog")?.textContent).toContain("没有保存");
  });
});

describe("Escape (review 8)", () => {
  const press = (target: Element | Document | Window = document.body) => fireEvent.keyDown(target, { key: "Escape", bubbles: true });
  const asked = () => ui("exit-tutorial-dialog") !== null;
  async function shown() {
    setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
  }

  it("asks to leave with the focus on a product button", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="some-product-button">x</button>`);
    await shown();
    ui("some-product-button")!.focus();
    press(ui("some-product-button")!);
    await tick(0);
    expect(asked()).toBe(true);
  });
  it("leaves an Escape the product handled (default prevented) alone", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="product-thing" tabindex="0"></div>`);
    await shown();
    ui("product-thing")!.addEventListener("keydown", (e) => e.preventDefault());
    press(ui("product-thing")!);
    await tick(0);
    expect(asked()).toBe(false);
  });
  it("leaves an Escape the product stopped alone", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="product-thing" tabindex="0"></div>`);
    await shown();
    ui("product-thing")!.addEventListener("keydown", (e) => e.stopPropagation());
    press(ui("product-thing")!);
    await tick(0);
    expect(asked()).toBe(false);
  });
  for (const [what, html] of [
    ["an input", `<input data-ui="field">`],
    ["a textarea", `<textarea data-ui="field"></textarea>`],
    ["a contenteditable", `<div data-ui="field" contenteditable="true" tabindex="0"></div>`],
  ] as const) {
    it(`does nothing while typing in ${what}`, async () => {
      document.body.insertAdjacentHTML("beforeend", html);
      await shown();
      ui("field")!.focus();
      press(ui("field")!);
      await tick(0);
      expect(asked()).toBe(false);
    });
  }
  for (const [what, html] of [
    ["a product dialog", `<div data-ui="dialog-overlay"></div>`],
    ["the command palette", `<div data-ui="command-palette"></div>`],
    ["a menu", `<div role="menu"><button role="menuitem">a</button></div>`],
    ["an open popup (aria-expanded)", `<button aria-haspopup="listbox" aria-expanded="true">a</button>`],
    ["the selection toolbar", `<div data-ui="latex-selection-tools"></div>`],
    ["an annotation popover", `<div data-ui="latex-annotation-popover"></div>`],
    ["an argument panel floating over the graph", `<aside data-ui="argument-detail" data-placement="overlay"></aside>`],
    ["the writer's cell menu", `<div data-ui="add-cell-menu"></div>`],
    ["the library's import menu", `<div data-ui="import-menu"></div>`],
    ["the quick appearance popover", `<div data-ui="tweaks-popover"></div>`],
  ] as const) {
    it(`does nothing while ${what} is open, even when the product's own Escape removes it first`, async () => {
      document.body.insertAdjacentHTML("beforeend", `<div id="owner">${html}</div>`);
      await shown();
      // the product closes its layer on the same Escape (without preventing the default), before the bubble reaches window
      const owner = document.getElementById("owner")!;
      const remove = () => owner.remove();
      document.body.addEventListener("keydown", remove);
      press();
      document.body.removeEventListener("keydown", remove);
      await tick(0);
      expect(asked()).toBe(false);
    });
  }
  it("closes the tutorial's own overflow menu first (focus back on its button), then asks", async () => {
    await shown();
    fireEvent.click(ui("tutorial-rail-more")!);
    await tick(0);
    expect(ui("tutorial-rail-menu")).not.toBeNull();
    press(document.activeElement ?? document.body);
    await tick(0);
    expect(ui("tutorial-rail-menu")).toBeNull();
    expect(asked()).toBe(false);
    expect(document.activeElement).toBe(ui("tutorial-rail-more"));
    press(document.activeElement!);
    await tick(0);
    expect(asked()).toBe(true);
  });
  it("a second Escape in the leave dialog is the dialog's (it closes, no new question)", async () => {
    await shown();
    press();
    await tick(0);
    expect(asked()).toBe(true);
    press(document.activeElement ?? document.body);
    await tick(0);
    expect(asked()).toBe(false);
  });
});

describe("a skipped step shown again (review 9)", () => {
  it("its gate still false: shown as usual, with the skip link again", async () => {
    document.body.insertAdjacentHTML("beforeend", `<nav data-ui="primary-navigation"></nav>`);
    setup({ initial: fakeProgress({ position: "tour.palette", steps: { "tour.palette": { state: "skipped", at: AT } } }) });
    await tick(16);
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.palette");
    expect(nextButton().disabled).toBe(true);
    expect(ui("tutorial-waiting")).not.toBeNull();
    expect(ui("tutorial-skip-step")).not.toBeNull();
  });
});

describe("0.A needs the settings page on the desktop (review 10)", () => {
  it("away from settings: docked 'first go back to Settings', not 'the interface has changed'", async () => {
    setup({ context: fakePage("library"), initial: fakeProgress({ position: "prepare.agent" }) });
    await tick(3100);
    expect(card()?.getAttribute("data-state")).toBe("requires");
    expect(ui("tutorial-requires")?.textContent).toContain("先回到设置页");
  });
  it("the browser form: still docked without an anchor", async () => {
    setup({ desktop: false, context: fakePage("library"), initial: fakeProgress({ position: "prepare.agent" }) });
    await tick(16);
    expect(card()?.getAttribute("data-state")).toBe("none");
  });
});

describe("shared controls (review 11, 12)", () => {
  it("the icon controls are ActionButtons with icons from icons.json and a text name", async () => {
    await (async () => {
      setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
      await tick(16);
    })();
    for (const [name, key] of [["exit-tutorial", "card"], ["tutorial-rail-more", undefined], ["toggle-tutorial-chapters", undefined]] as const) {
      const button = ui(name, key)!;
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.querySelector("svg")).not.toBeNull();
      // the SVG comes from icons.json (parsed resource), not a lucide component
      expect(button.querySelector("svg")!.classList.contains("lucide")).toBe(false);
      expect(button.closest(".ui-tooltip-anchor")).not.toBeNull();
    }
  });
  it("the collapsed rail's chapter buttons use the shared tooltip, not a native title", async () => {
    setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
    fireEvent.click(ui("toggle-tutorial-chapters")!);
    await tick(0);
    const chapter = ui("tutorial-chapter", "tour")!;
    expect(chapter.hasAttribute("title")).toBe(false);
    expect(chapter.closest(".ui-tooltip-anchor")).not.toBeNull();
    expect(chapter.getAttribute("aria-label")).toContain("工作台导览");
  });
  it("the capsule's accessible name contains its visible text; its hint is the shared tooltip", async () => {
    setup({ entered: false, initial: fakeProgress({ position: "tour.split" }) });
    await tick(0);
    const capsule = ui("tutorial-capsule")!;
    expect(capsule.hasAttribute("title")).toBe(false);
    const name = capsule.getAttribute("aria-label") ?? capsule.textContent ?? "";
    expect(name).toContain(capsule.textContent!.trim());
    expect(capsule.closest(".ui-tooltip-anchor")).not.toBeNull();
  });
  it("the overflow menu: focus moves into it, arrows move between items, Escape closes it back onto its button", async () => {
    setup({ initial: fakeProgress({ position: "tour.pane-views" }) });
    await tick(16);
    const more = ui("tutorial-rail-more")!;
    fireEvent.click(more);
    await tick(0);
    const item = ui("tutorial-restart")!;
    expect(document.activeElement).toBe(item);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(item, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "End" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "Escape" });
    await tick(0);
    expect(ui("tutorial-rail-menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

describe("the measuring loop (review 15)", () => {
  it("does not run every frame while the card is docked without an anchor or yielding to a modal", async () => {
    const railBox = vi.fn(() => new DOMRect(62, 0, 232, 900));
    setup({ desktop: false, context: fakePage("settings"), initial: fakeProgress({ position: "prepare.agent" }), deps: { railBox } });
    await tick(16);
    const before = railBox.mock.calls.length;
    await tick(500);
    expect(railBox.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});

describe("reduced motion (review 14)", () => {
  it("the endless animations stop when the user asks for reduced motion", () => {
    const css = readFileSync(fileURLToPath(new NodeURL("../src/tutorial/tutorial.css", import.meta.url)), "utf8");
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/\.tut-ring\.pulse[^{]*\{[^}]*animation:\s*none/);
    expect(block).toMatch(/\.tut-wait svg[^{]*\{[^}]*animation:\s*none/);
  });
  it("the unused notice style is gone", () => {
    const css = readFileSync(fileURLToPath(new NodeURL("../src/tutorial/tutorial.css", import.meta.url)), "utf8");
    expect(css).not.toContain(".tut-notice");
  });
});
