import type { ReactNode } from "react";
import icons from "./icons.json";
import { parseIconSvg } from "./icon-svg";
export { parseIconSvg } from "./icon-svg";

type IconEntry = string | Record<string, string>;

/** Every action is addressed by its stable data-ui; iconName selects a state variant only. */
export function getConfiguredIcon(name: string, uiId?: string): ReactNode | null {
  if (!uiId) return null;
  const entry = (icons as Record<string, IconEntry>)[uiId];
  const source = typeof entry === "string" ? entry : entry?.[name];
  return typeof source === "string" ? parseIconSvg(source) : null;
}
