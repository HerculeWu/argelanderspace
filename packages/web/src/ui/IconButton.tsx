import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  variant?: "default" | "primary" | "danger" | "ghost";
  unstyled?: boolean;
}

/** Icon-only action with one accessible name and the shared keyboard/pointer tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip = label, icon, variant = "default", unstyled = false, className = "", type = "button", ...props },
  ref
) {
  return (
    <Tooltip content={tooltip}>
      <button
        data-ui="icon-button"
        {...props}
        ref={ref}
        type={type}
        className={[unstyled ? "" : "btn ui-button icon", unstyled || variant === "default" ? "" : variant, className]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
