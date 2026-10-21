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
});
