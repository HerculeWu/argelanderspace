/** The step card's placement (review 16): an answer for an anchor the card no longer sits beside is dropped. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { StepCard, type StepCardProps } from "../src/tutorial/StepCard";

const h = vi.hoisted(() => ({ pending: [] as Array<{ anchor: Element; resolve: (v: { x: number; y: number }) => void }> }));
vi.mock("@floating-ui/dom", () => ({
  autoUpdate: (_anchor: Element, _el: Element, update: () => void) => {
    update();
    return () => {};
  },
  computePosition: (anchor: Element) => new Promise((resolve) => h.pending.push({ anchor, resolve })),
  offset: () => ({}),
  flip: () => ({}),
  shift: () => ({}),
}));

afterEach(() => {
  cleanup();
  h.pending.length = 0;
  document.body.innerHTML = "";
});

describe("StepCard placement", () => {
  it("a late answer for the previous anchor does not overwrite the new position", async () => {
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.append(a, b);
    const chapter = CHAPTERS.find((c) => c.id === "tour")!;
    const noop = () => {};
    const props: StepCardProps = {
      chapter, step: chapter.steps[0]!, index: 1, count: chapter.steps.length, anchor: a, dock: null, avoidLeft: 12, browserCopy: false,
      gated: false, passed: false, skipped: false, texBlocked: false, texBusy: false, firstStep: false, nextLabel: "next", notSaved: false,
      onBack: noop, onNext: noop, onSkip: noop, onLeave: noop, onTakeMeThere: noop, onScrollTo: noop, onRecheck: noop,
    };
    const view = render(<StepCard {...props} />);
    view.rerender(<StepCard {...props} anchor={b} />);
    const forB = h.pending.find((p) => p.anchor === b)!;
    const forA = h.pending.find((p) => p.anchor === a)!;
    await act(async () => forB.resolve({ x: 200, y: 100 }));
    await act(async () => forA.resolve({ x: 10, y: 10 }));
    const el = document.querySelector<HTMLElement>('[data-ui="tutorial-step-card"]')!;
    expect(el.style.transform).toBe("translate(200px, 100px)");
  });
  it("no room on any side of the anchor (a whole pane): the card sits at the bottom right, as a docked card, not over the page's top left", async () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-ui", "latex-reader");
    document.body.append(pane);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === pane) return new DOMRect(106, 32, W - 106, H - 32);
      if (this.getAttribute("data-ui") === "tutorial-step-card") return new DOMRect(0, 0, 340, 300);
      return new DOMRect(0, 0, 0, 0);
    });
    try {
      const chapter = CHAPTERS.find((c) => c.id === "tour")!;
      const noop = () => {};
      render(
        <StepCard
          chapter={chapter} step={chapter.steps[0]!} index={1} count={chapter.steps.length} anchor={pane} dock={null} avoidLeft={118} browserCopy={false}
          gated={false} passed={false} skipped={false} texBlocked={false} texBusy={false} firstStep={false} nextLabel="next" notSaved={false}
          onBack={noop} onNext={noop} onSkip={noop} onLeave={noop} onTakeMeThere={noop} onScrollTo={noop} onRecheck={noop}
        />,
      );
      await act(async () => {});
      const el = document.querySelector<HTMLElement>('[data-ui="tutorial-step-card"]')!;
      expect(el.style.transform).toBe(`translate(${W - 340 - 16}px, ${H - 300 - 16}px)`);
      expect(el.dataset.placement).toBe("fallback");
      expect(el.style.visibility).toBe("");
      // No placement was asked of floating-ui for it.
      expect(h.pending.some((p) => p.anchor === pane)).toBe(false);
    } finally {
      rects.mockRestore();
    }
  });
});

describe("the card's entry animation leaves its placement alone (final check, probe 25's rail menu)", () => {
  it("the step card's keyframes do not animate `transform` (the placement is an inline transform the animation would override, leaving the card at the top left over the rail while it plays)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const css = read("../src/tutorial/tutorial.css");
    const rule = /\.tut-card\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const name = /animation:\s*([\w-]+)/.exec(rule)?.[1];
    expect(name).toBeTruthy();
    const all = css + read("../src/argelander.css");
    const frames = new RegExp(`@keyframes\\s+${name}\\s*\\{((?:[^{}]*\\{[^}]*\\})*)[^}]*\\}`).exec(all)?.[1];
    expect(frames).toBeTruthy();
    expect(frames).not.toMatch(/(^|[\s;{])transform\s*:/);
  });
});
