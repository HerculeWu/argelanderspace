import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

export function Tooltip({
  content,
  children,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = `tooltip-${useId().replace(/:/g, "")}`;
  if (!isValidElement(children)) return children;
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span className="ui-tooltip-anchor">
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span id={id} className="ui-tooltip" data-ui="control-tooltip" role="tooltip">
        {content}
      </span>
    </span>
  );
}
