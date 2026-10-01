import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

import { actionClasses, type ActionStyle } from "./action-style";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ActionStyle & {
  busy?: boolean;
  busyLabel?: ReactNode;
  /** Keep a caller's established control styling instead of layering the generic button surface. */
  unstyled?: boolean;
}

/** Shared action control. `busy` owns duplicate-submit prevention and its accessible state. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { appearance, tone, iconSize: _iconSize, variant = "default", busy = false, busyLabel, disabled, unstyled = false, className = "", children, type = "button", ...props },
  ref
) {
  const surfaceVariant = appearance ? (tone === "danger" ? "danger" : appearance === "primary" ? "primary" : "default") : variant;
  const classes = [unstyled ? "" : "btn ui-button", unstyled || surfaceVariant === "default" ? "" : surfaceVariant, actionClasses(appearance, tone), className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      data-ui="button"
      {...props}
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
});
