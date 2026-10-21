/**
 * The polish round (in-app-tutorial ticket 21, F2): measuring a highlighted element stops clipping at a fixed-position
 * element. A fixed popover or editor whose DOM sits inside the reader's scroll container is placed against the window,
 * not that container, and is not "out of view" because the container is smaller. (happy-dom has no layout: the boxes and
 * computed styles are given.)
 */
import { describe, expect, it } from "vitest";
import { fitsBeside } from "../src/tutorial/StepCard";
import { measure } from "../src/tutorial/anchors";

type Box = [left: number, top: number, width: number, height: number];
/** A chain body > outer > ... built from [box, style] pairs; returns the innermost element and a fake window. */
function chain(levels: Array<{ box: Box; style?: Partial<CSSStyleDeclaration> }>) {
  const styles = new Map<Element, Partial<CSSStyleDeclaration>>();
  let parent: Element = document.body;
  let el: Element = parent;
  for (const level of levels) {
    el = document.createElement("div");
    parent.append(el);
    const [l, t, w, h] = level.box;
    (el as HTMLElement).getBoundingClientRect = () => new DOMRect(l, t, w, h);
    styles.set(el, level.style ?? {});
    parent = el;
  }
  const win = {
    document,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: (e: Element) => ({ overflowX: "visible", overflowY: "visible", position: "static", ...styles.get(e) }) as CSSStyleDeclaration,
  } as unknown as Window;
  return { el, win };
}

describe("measure and fixed positioning", () => {
  it("an element in a small scroll container is clipped by it (more than half cut off: out of view)", () => {
    const { el, win } = chain([
      { box: [100, 100, 400, 100], style: { overflowY: "auto" } },
      { box: [100, 150, 300, 300] },
    ]);
    expect(measure(el, win).visible).toBe(false);
  });
  it("a fixed element inside that container is not clipped by it", () => {
    const { el, win } = chain([
      { box: [100, 100, 400, 100], style: { overflowY: "auto" } },
      { box: [100, 150, 300, 300], style: { position: "fixed" } },
    ]);
    const m = measure(el, win);
    expect(m.visible).toBe(true);
    expect(m.rect).toEqual(new DOMRect(100, 150, 300, 300));
  });
  it("a child of a fixed element is clipped by that element's own overflow, not by the containers above it", () => {
    const { el, win } = chain([
      { box: [100, 100, 400, 100], style: { overflowY: "auto" } },
      { box: [100, 150, 300, 300], style: { position: "fixed", overflowY: "auto" } },
      { box: [120, 160, 200, 200] },
    ]);
    const m = measure(el, win);
    expect(m.visible).toBe(true);
    expect(m.rect).toEqual(new DOMRect(120, 160, 200, 200));
  });
  it("the window still clips a fixed element", () => {
    const { el, win } = chain([{ box: [1300, 100, 400, 100], style: { position: "fixed" } }]);
    expect(measure(el, win).visible).toBe(false);
  });
});

describe("fitsBeside: is there room for the card on any side of its anchor", () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 340, height: 300 };
  const padding = { top: 12, right: 12, bottom: 12, left: 118 };
  it("a small anchor leaves room on its right", () => {
    expect(fitsBeside(new DOMRect(400, 200, 100, 30), card, view, padding)).toBe(true);
  });
  it("an anchor against the right edge still has room on its left", () => {
    expect(fitsBeside(new DOMRect(1000, 200, 400, 30), card, view, padding)).toBe(true);
  });
  it("a wide short anchor has room below or above", () => {
    expect(fitsBeside(new DOMRect(118, 100, 1300, 60), card, view, padding)).toBe(true);
  });
  it("an anchor filling the window (a whole reader pane) leaves no room on any side", () => {
    expect(fitsBeside(new DOMRect(106, 32, 1334, 868), card, view, padding)).toBe(false);
  });
});
