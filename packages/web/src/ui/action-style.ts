import { cloneElement, isValidElement, type ReactNode, type SVGProps } from "react";

export type IconSize = "small" | "regular" | "navigation";
export type ActionStyle = {
  iconSize?: IconSize;
} & (
  | { appearance?: undefined; tone?: never; variant?: "default" | "primary" | "danger" | "ghost" }
  | { appearance: "quiet" | "secondary" | "primary"; tone?: "neutral" | "danger"; variant?: never }
);

export function actionClasses(appearance?: ActionStyle["appearance"], tone?: ActionStyle["tone"]): string {
  return appearance ? `ui-action ui-action--${appearance}${tone === "danger" ? " ui-action--danger" : ""}` : "";
}

/** Presets pair artwork size and normal-scaling stroke; never change the button target. */
export function sizedIcon(icon: ReactNode, size?: IconSize): ReactNode {
  if (!size || !isValidElement<SVGProps<SVGSVGElement>>(icon) || icon.type !== "svg") return icon;
  return cloneElement(icon, { className: `ui-icon ui-icon-size--${size}` });
}
