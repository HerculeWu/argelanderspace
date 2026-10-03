/**
 * The graph's discrete buttons can be pressed from outside (Copilot) through the same functions the clicks call.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CanvasNode, GraphCanvas, type GraphCanvasController } from "../src/graph/GraphCanvas";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const NODES: CanvasNode[] = ["A", "B"].map((id, i) => ({ id, title: `Paper ${id}`, label: `Doe ’2${i}`, year: 2020 + i, citations: 3, filled: true, diamond: false, seed: false, venue: "ApJ", roleTag: null }));
afterEach(cleanup);

function mount(extra: Record<string, unknown> = {}) {
  vi.stubGlobal("ResizeObserver", RO);
  let controller: GraphCanvasController | null = null;
  const view = render(
    <GraphCanvas nodes={NODES} edges={[["A", "B"]]} selectedId={null} onSelect={() => {}} stash={{}} layoutKey="k" heading="h" note="n" onController={(c) => { controller = c; }} {...extra} />
  );
  return { view, controller: () => controller! };
}
const zoomText = () => document.querySelector(".zoom-value")?.textContent;

describe("GraphCanvas controller", () => {
  it("zoom in/out run the buttons' own zoom step, and the controller is dropped on unmount", () => {
    const { view, controller } = mount();
    const start = Number.parseInt(zoomText() ?? "0", 10);
    act(() => controller().zoomIn());
    const zoomedIn = Number.parseInt(zoomText() ?? "0", 10);
    expect(zoomedIn).toBe(Math.round(start * 1.25));
    // Same state as pressing the on-screen button.
    fireEvent.click(document.querySelector('[data-ui="zoom-in"]')!);
    const clicked = Number.parseInt(zoomText() ?? "0", 10);
    expect(clicked).toBeGreaterThan(zoomedIn);
    act(() => controller().zoomOut());
    expect(Number.parseInt(zoomText() ?? "0", 10)).toBe(Math.round(clicked * 0.8));
    const { fit: fitView, relayout } = controller();
    act(() => {
      fitView();
      relayout();
    });
    expect(zoomText()).toMatch(/%$/);
    const handle = controller();
    view.unmount();
    const { fit: fitAfterUnmount } = handle;
    expect(() => fitAfterUnmount()).not.toThrow();
  });

  it("the labels toggle is controlled: the button reports its change and the prop drives its state", () => {
    const changes: boolean[] = [];
    const { view } = mount({ labelsOn: false, onLabelsOnChange: (on: boolean) => changes.push(on) });
    const button = () => document.querySelector('[data-ui="toggle-graph-labels"]') as HTMLElement;
    expect(button().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button());
    expect(changes).toEqual([true]);
    view.rerender(<GraphCanvas nodes={NODES} edges={[["A", "B"]]} selectedId={null} onSelect={() => {}} stash={{}} layoutKey="k" heading="h" note="n" labelsOn onLabelsOnChange={(on) => changes.push(on)} />);
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });
});
