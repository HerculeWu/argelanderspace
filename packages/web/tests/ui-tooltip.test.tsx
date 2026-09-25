import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip } from "../src/ui/Tooltip";

afterEach(cleanup);

function twoActions() {
  const { container } = render(<>
    <Tooltip content="First tip"><button type="button">First action</button></Tooltip>
    <Tooltip content="Second tip"><button type="button">Second action</button></Tooltip>
  </>);
  const anchors = Array.from(container.querySelectorAll<HTMLElement>(".ui-tooltip-anchor"));
  const visible = () => Array.from(container.querySelectorAll('[role="tooltip"]:not([aria-hidden="true"])')).map((tip) => tip.textContent);
  return { anchors, visible };
}

describe("Tooltip dismissal", () => {
  it("closes on click and pointer exit, without keeping an old focused tooltip alongside a new one", () => {
    const { anchors, visible } = twoActions();
    const first = anchors[0].querySelector("button")!;
    expect(visible()).toEqual([]);
    fireEvent.pointerEnter(anchors[0]);
    expect(visible()).toEqual(["First tip"]);
    fireEvent.pointerDown(first);
    fireEvent.focus(first);
    fireEvent.click(first);
    expect(visible()).toEqual([]);
    fireEvent.pointerLeave(anchors[0]);
    fireEvent.pointerEnter(anchors[1]);
    expect(visible()).toEqual(["Second tip"]);
    fireEvent.pointerLeave(anchors[1]);
    expect(visible()).toEqual([]);
  });

  it("keeps only one tooltip open when keyboard focus moves while the mouse stays over another", () => {
    const { anchors, visible } = twoActions();
    fireEvent.pointerEnter(anchors[0]);
    expect(visible()).toEqual(["First tip"]);
    fireEvent.focus(anchors[1].querySelector("button")!);
    expect(visible()).toEqual(["Second tip"]);
  });

  it("opens for keyboard focus but dismisses after activation or Escape", () => {
    const { anchors, visible } = twoActions();
    const first = anchors[0].querySelector("button")!;
    fireEvent.focus(first);
    expect(visible()).toEqual(["First tip"]);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(visible()).toEqual([]);
    fireEvent.blur(first);
    fireEvent.focus(first);
    expect(visible()).toEqual(["First tip"]);
    fireEvent.click(first);
    expect(visible()).toEqual([]);
  });
});
