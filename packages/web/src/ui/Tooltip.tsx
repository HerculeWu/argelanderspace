import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

type ActiveTooltip = { token: object; dismiss: () => void };
let activeTooltip: ActiveTooltip | null = null;
// React 18 types do not know the `popover` attribute yet; it is passed through to the DOM as written.
const POPOVER_MANUAL = { popover: "manual" } as object;

/**
 * The tooltip bubble: a `popover="manual"` element, so it sits in the top layer and no ancestor's `overflow` or
 * `z-index` can clip or cover it. While `open` it is placed with floating-ui — below the anchor by default,
 * flipped above when it would not fit, shifted back inside the window — and follows scroll and resize.
 */
export function TooltipBubble({ id, open, anchorRef, children }: {
  id: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const bubble = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const tip = bubble.current;
    const anchor = anchorRef.current;
    if (!tip || !anchor || !open) return;
    try { tip.showPopover?.(); } catch { /* already open, or not connected */ }
    const place = () => {
      void computePosition(anchor, tip, {
        strategy: "fixed",
        placement: "bottom",
        middleware: [offset(7), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
      });
    };
    const stop = autoUpdate(anchor, tip, place);
    return () => {
      stop();
      try { tip.hidePopover?.(); } catch { /* already hidden */ }
    };
  }, [open, anchorRef]);
  return (
    <span ref={bubble} id={id} {...POPOVER_MANUAL} className="ui-tooltip" data-ui="control-tooltip" role="tooltip" aria-hidden={!open}>
      {children}
    </span>
  );
}

/**
 * The "one tooltip at a time" rule: `reveal` closes whichever other tooltip is open before opening this one.
 * Shared by `Tooltip` and by controls that render `TooltipBubble` themselves.
 */
export function useSingleTooltip() {
  const [open, setOpen] = useState(false);
  const token = useRef({});
  useEffect(() => {
    const owner = token.current;
    return () => { if (activeTooltip?.token === owner) activeTooltip = null; };
  }, []);
  const dismiss = () => {
    setOpen(false);
    if (activeTooltip?.token === token.current) activeTooltip = null;
  };
  const reveal = () => {
    if (activeTooltip?.token !== token.current) activeTooltip?.dismiss();
    activeTooltip = { token: token.current, dismiss };
    setOpen(true);
  };
  return { open, reveal, dismiss };
}

export function Tooltip({
  content,
  children,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = `tooltip-${useId().replace(/:/g, "")}`;
  const { open, reveal, dismiss } = useSingleTooltip();
  const anchorRef = useRef<HTMLSpanElement>(null);
  if (!isValidElement(children)) return children;
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span ref={anchorRef} className="ui-tooltip-anchor" data-tooltip-open={open || undefined}
      onPointerEnter={reveal} onPointerLeave={dismiss}
      onFocusCapture={reveal}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dismiss(); }}
      onPointerDownCapture={dismiss} onClickCapture={dismiss}
      onKeyDownCapture={(event) => { if (event.key === "Escape") dismiss(); }}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      <TooltipBubble id={id} open={open} anchorRef={anchorRef}>{content}</TooltipBubble>
    </span>
  );
}
