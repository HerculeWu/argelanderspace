import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button, type ButtonVariant } from "./Button";
import { IconButton } from "./IconButton";
import { getConfiguredIcon } from "./icon-resource";
import { Tooltip } from "./Tooltip";

type SharedProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  /** Stable UI identifier and icon-catalog key (required to resolve icon-mode resources). */
  "data-ui"?: string;
  tooltip?: string;
  variant?: ButtonVariant;
  busy?: boolean;
  busyLabel?: ReactNode;
  /** Use an established local appearance while retaining names, tooltip, and action semantics. */
  unstyled?: boolean;
};

export type ActionButtonProps =
  | (SharedProps & { mode: "icon"; iconName: string })
  | (SharedProps & { mode: "text"; children: ReactNode });

/** Public shared action interface; presentation is selected in code, never by resource data. */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(props, ref) {
  if (props.mode === "text") {
    const { mode: _mode, label, tooltip, children, ...buttonProps } = props;
    const button = <Button {...buttonProps} ref={ref} aria-label={label}>{props.busy && props.busyLabel !== undefined ? props.busyLabel : children}</Button>;
    return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
  }

  const { mode: _mode, label, tooltip, iconName, busy, disabled, ...buttonProps } = props;
  const icon = getConfiguredIcon(iconName, props["data-ui"]);
  if (!icon) {
    const { className, style, ...fallbackProps } = buttonProps;
    return <Button {...fallbackProps} ref={ref} unstyled={props.unstyled} className={className?.split(/\s+/).filter((token) => token !== "icon").join(" ")} style={{ ...style, width: "auto", minWidth: "max-content" }} disabled={disabled || busy} busy={busy} aria-label={label}>{label}</Button>;
  }
  return (
    <IconButton
      {...buttonProps}
      ref={ref}
      variant={props.variant}
      unstyled={props.unstyled}
      label={label}
      tooltip={tooltip}
      icon={icon}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    />
  );
});
