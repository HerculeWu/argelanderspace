import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

type ActiveTooltip = { token: object; dismiss: () => void };
let activeTooltip: ActiveTooltip | null = null;

/**
 * Where the tooltip opens below its control: centred under it (default), or with its right edge at the control's
 * right edge (`end`) — for a control at the right edge of its area, so a narrow window does not cut the tooltip off.
 */
export type TooltipAlign = "center" | "end";

export function Tooltip({
  content,
  children,
  align = "center",
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  align?: TooltipAlign;
}) {
  const id = `tooltip-${useId().replace(/:/g, "")}`;
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
  if (!isValidElement(children)) return children;
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span className="ui-tooltip-anchor" data-tooltip-open={open || undefined} data-tooltip-align={align === "center" ? undefined : align}
      onPointerEnter={reveal} onPointerLeave={dismiss}
      onFocusCapture={reveal}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dismiss(); }}
      onPointerDownCapture={dismiss} onClickCapture={dismiss}
      onKeyDownCapture={(event) => { if (event.key === "Escape") dismiss(); }}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span id={id} className="ui-tooltip" data-ui="control-tooltip" role="tooltip" aria-hidden={!open}>
        {content}
      </span>
    </span>
  );
}
