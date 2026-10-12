/**
 * The viewport behaviour both renderers share (`useGraphViewport`): the wheel zooms and keeps the page from
 * scrolling, with the same limits; a drag that starts on a node moves it only past a few pixels; panning
 * takes the view over from the automatic fit.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArgumentGraphCanvas } from "../src/argument/ArgumentGraphCanvas";
import { type CanvasNode, GraphCanvas } from "../src/graph/GraphCanvas";
import { ZOOM_MAX, ZOOM_MIN } from "../src/graph/useGraphViewport";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal("ResizeObserver", RO));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NODES: CanvasNode[] = ["A", "B"].map((id, i) => ({ id, title: `Paper ${id}`, label: `Doe ’2${i}`, year: 2020 + i, citations: 3, filled: true, diamond: false, seed: false, venue: "ApJ", roleTag: null }));
const force = () => render(<GraphCanvas nodes={NODES} edges={[["A", "B"]]} selectedId={null} onSelect={() => {}} stash={{}} layoutKey="k" heading="h" note="n" />);
const layered = (stash: Record<string, unknown> = {}) => render(<ArgumentGraphCanvas graph={ARGUMENT_FIXTURES.clean()} selectedId={null} onSelect={() => {}} stash={stash} sceneKey="w" />);
const zoom = () => Number.parseInt(document.querySelector(".zoom-value")?.textContent ?? "0", 10);

describe.each([
  ["force layout", force],
  ["layered layout", () => layered()],
])("shared viewport (%s)", (_name, mount) => {
  it("wheel zooms, prevents the page from scrolling, and stops at the same limits", () => {
    mount();
    const svg = document.querySelector("svg.cg-svg")!;
    const ev = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    svg.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    for (let i = 0; i < 80; i++) fireEvent.wheel(svg, { deltaY: -400 });
    expect(zoom()).toBe(Math.round(ZOOM_MAX * 100));
    for (let i = 0; i < 160; i++) fireEvent.wheel(svg, { deltaY: 400 });
    expect(zoom()).toBe(Math.round(ZOOM_MIN * 100));
  });
});

describe("layered viewport takeover", () => {
  it("a pan past the click threshold ends the automatic fit; a click does not", () => {
    const stash: { auto?: boolean } = { auto: true };
    layered(stash);
    const svg = document.querySelector("svg.cg-svg")!;
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 12, clientY: 11 });
    expect(stash.auto).toBe(true);
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 60, clientY: 50 });
    expect(stash.auto).toBe(false);
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 60, clientY: 50 });
  });
});
