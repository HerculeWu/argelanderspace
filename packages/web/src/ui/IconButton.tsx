import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
  variant?: "default" | "ghost";
}

/** Icon-only action with one accessible name and the shared keyboard/pointer tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "default", className = "", type = "button", ...props },
  ref
) {
  return (
    <Tooltip content={label}>
      <button
        {...props}
        ref={ref}
        type={type}
        className={["btn", "ui-button", "icon", variant === "ghost" ? "ghost" : "", className]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
