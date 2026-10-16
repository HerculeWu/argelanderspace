import { useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipBubble, useSingleTooltip } from "../src/ui/Tooltip";

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

describe("Tooltip top layer", () => {
  it("is a manual popover that is shown and hidden with the tooltip (happy-dom has no layout: placement is checked in a real browser)", () => {
    const proto = HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
    const show = vi.fn();
    const hide = vi.fn();
    const saved = { show: proto.showPopover, hide: proto.hidePopover };
    proto.showPopover = show;
    proto.hidePopover = hide;
    try {
      const { anchors } = twoActions();
      const tip = anchors[0].querySelector<HTMLElement>('[role="tooltip"]')!;
      expect(tip.getAttribute("popover")).toBe("manual");
      expect(show).not.toHaveBeenCalled();
      fireEvent.pointerEnter(anchors[0]);
      expect(show).toHaveBeenCalledTimes(1);
      fireEvent.pointerLeave(anchors[0]);
      expect(hide).toHaveBeenCalled();
    } finally {
      proto.showPopover = saved.show;
      proto.hidePopover = saved.hide;
    }
  });
});

function Summary() {
  const { open, reveal, dismiss } = useSingleTooltip();
  const ref = useRef<HTMLElement>(null);
  return (
    <details><summary ref={ref} data-testid="sum" onPointerEnter={reveal} onPointerLeave={dismiss}>
      x<TooltipBubble id="sum-tip" open={open} anchorRef={ref}>Summary tip</TooltipBubble>
    </summary></details>
  );
}

describe("Tooltip single registry", () => {
  it("a control that renders TooltipBubble itself and a Tooltip never show together", () => {
    const { container, getByTestId } = render(<>
      <Tooltip content="Button tip"><button type="button">B</button></Tooltip>
      <Summary />
    </>);
    const visible = () => Array.from(container.querySelectorAll('[role="tooltip"]:not([aria-hidden="true"])')).map((tip) => tip.textContent);
    const anchor = container.querySelector<HTMLElement>(".ui-tooltip-anchor")!;
    fireEvent.pointerEnter(anchor);
    expect(visible()).toEqual(["Button tip"]);
    fireEvent.pointerEnter(getByTestId("sum"));
    expect(visible()).toEqual(["Summary tip"]);
    fireEvent.pointerEnter(anchor);
    expect(visible()).toEqual(["Button tip"]);
  });
});
