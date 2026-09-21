import type { ReactNode } from "react";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent";
  children: ReactNode;
}) {
  return <span className={`ui-badge ${tone}`}>{children}</span>;
}
