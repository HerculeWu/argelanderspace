import type { ReactNode } from "react";
import { Icon } from "../lib/icons";

export function InlineMessage({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger";
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`ui-inline-message ${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "info" ? "info" : "triangle-alert"} cls="ico-sm" />
      <div>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}
