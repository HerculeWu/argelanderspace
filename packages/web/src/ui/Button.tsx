import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  busyLabel?: ReactNode;
  /** Keep a caller's established control styling instead of layering the generic button surface. */
  unstyled?: boolean;
}

/** Shared action control. `busy` owns duplicate-submit prevention and its accessible state. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", busy = false, busyLabel, disabled, unstyled = false, className = "", children, type = "button", ...props },
  ref
) {
  const classes = [unstyled ? "" : "btn ui-button", unstyled || variant === "default" ? "" : variant, className]
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
