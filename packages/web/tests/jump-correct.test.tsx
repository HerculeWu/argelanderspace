import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DocIr } from "@argelanderspace/contracts";
import { StoreProvider, useStore } from "../src/store";

// jumpTo's landing correction: after the smooth scroll settles it re-measures
// the target and corrects drift (lazy images / panel transitions), bounded at
// two corrections, cancelled by user scroll input. Layout is mocked via rects.

const ir: DocIr = {
  docId: "t",
  title: "Test doc",
  sections: [],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
};

let store: ReturnType<typeof useStore>;
function Capture() {
  store = useStore();
  return null;
}

class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const scrollCalls: { behavior?: string }[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 100,
    left: 0,
    right: 500,
    width: 500,
    height: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setup() {
  const utils = render(
    <StoreProvider ir={ir}>
      <Capture />
      <div className="reader">
        <div className="block" data-block-id="fig-1" id="fig-1">
          fig
        </div>
      </div>
    </StoreProvider>
  );
  const reader = utils.container.querySelector(".reader") as HTMLElement;
  const el = utils.container.querySelector("#fig-1") as HTMLElement;
  store.registerReader(reader);
  return { reader, el, ...utils };
}

beforeEach(() => {
  scrollCalls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: unknown) {
    scrollCalls.push({ behavior: (arg as ScrollIntoViewOptions | undefined)?.behavior });
  });
  vi.stubGlobal("IntersectionObserver", IOStub);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = realScrollIntoView;
});

describe("jumpTo landing correction", () => {
  it("does nothing when the target lands aligned", () => {
    const { el } = setup();
    el.getBoundingClientRect = () => rect(0);
    store.jumpTo("fig-1");
    expect(scrollCalls).toEqual([{ behavior: "smooth" }]);
    vi.advanceTimersByTime(1500);
    expect(scrollCalls).toHaveLength(1);
  });

  it("corrects once when the target drifted, then re-checks and stops", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    // drifted 184px below the intended landing spot (image loaded en route)
    el.getBoundingClientRect = () => rect(184);
    store.jumpTo("fig-1");
    vi.advanceTimersByTime(900);
    expect(scrollCalls).toEqual([{ behavior: "smooth" }, { behavior: "auto" }]);
    // still off at the re-check → second (final) correction
    vi.advanceTimersByTime(400);
    expect(scrollCalls).toHaveLength(3);
    // bounded: a third check never corrects again
    vi.advanceTimersByTime(400);
    expect(scrollCalls).toHaveLength(3);
  });

  it("stops after one correction when the re-check lands aligned", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    let top = 184;
    el.getBoundingClientRect = () => rect(top);
    store.jumpTo("fig-1");
    vi.advanceTimersByTime(900);
    expect(scrollCalls).toHaveLength(2);
    top = 0; // the correction landed it
    vi.advanceTimersByTime(800);
    expect(scrollCalls).toHaveLength(2);
  });

  it("user scroll input cancels a pending correction", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    el.getBoundingClientRect = () => rect(184);
    store.jumpTo("fig-1");
    reader.dispatchEvent(new WheelEvent("wheel"));
    vi.advanceTimersByTime(1500);
    expect(scrollCalls).toHaveLength(1); // only the initial smooth scroll
  });

  it("re-arms while the scroll is still moving, corrects once settled", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    el.getBoundingClientRect = () => rect(184);
    // fake an in-flight smooth scroll: scrollTop keeps changing between samples
    let pos = 100;
    Object.defineProperty(reader, "scrollTop", { get: () => pos, configurable: true });
    store.jumpTo("fig-1");
    pos = 500; // moved since the sample taken at schedule time
    vi.advanceTimersByTime(900); // first check: still moving → re-arm, no correction
    expect(scrollCalls).toEqual([{ behavior: "smooth" }]);
    pos = 900;
    vi.advanceTimersByTime(250); // re-arm check: moved again → re-arm
    expect(scrollCalls).toHaveLength(1);
    // pos now holds still → next check corrects
    vi.advanceTimersByTime(250);
    expect(scrollCalls).toEqual([{ behavior: "smooth" }, { behavior: "auto" }]);
  });

  it("undo cancels a pending correction", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    reader.scrollTo = vi.fn();
    el.getBoundingClientRect = () => rect(184);
    vi.advanceTimersByTime(800); // past JUMP_ANIM_MS so the undo origin is captured
    store.jumpTo("fig-1");
    store.undo();
    vi.advanceTimersByTime(1500);
    // the instant landing correction never fired
    expect(scrollCalls).toEqual([{ behavior: "smooth" }]);
    expect(reader.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("a new jump supersedes the previous jump's pending correction", () => {
    const { reader, el } = setup();
    reader.getBoundingClientRect = () => rect(0);
    el.getBoundingClientRect = () => rect(0);
    store.jumpTo("fig-1");
    vi.advanceTimersByTime(400);
    el.getBoundingClientRect = () => rect(184);
    store.jumpTo("fig-1");
    vi.advanceTimersByTime(900);
    // the second jump's own cycle corrected once; the first cycle never fired
    expect(scrollCalls).toEqual([
      { behavior: "smooth" },
      { behavior: "smooth" },
      { behavior: "auto" },
    ]);
  });
});
