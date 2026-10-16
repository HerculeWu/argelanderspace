import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

import { actionClasses, sizedIcon, type ActionStyle } from "./action-style";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & ActionStyle & {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  unstyled?: boolean;
}

/** Icon-only action with one accessible name and the shared keyboard/pointer tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip = label, icon, appearance, tone, iconSize, variant = "default", unstyled = false, className = "", type = "button", ...props },
  ref
) {
  const surfaceVariant = appearance ? (tone === "danger" ? "danger" : appearance === "primary" ? "primary" : "default") : variant;
  return (
    <Tooltip content={tooltip}>
      <button
        data-ui="icon-button"
        {...props}
        ref={ref}
        type={type}
        className={[unstyled ? "" : "btn ui-button icon", unstyled || surfaceVariant === "default" ? "" : surfaceVariant, actionClasses(appearance, tone), className]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
      >
        {sizedIcon(icon, iconSize)}
      </button>
    </Tooltip>
  );
});
