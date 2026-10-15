import { useHostInfo } from "../host";
import { Icon } from "../lib/icons";

/**
 * The title bar's window buttons: decoration only (they have no actions), as in the browser form's design. In the
 * desktop app the window has the system's frame and its buttons, so these are not shown there (user decision
 * 2026-10-15, desktop-app ticket 21); the browser form keeps them unchanged. Until the server's answer is known the
 * page is in the browser form (host.ts) — the workbench and the welcome page wait for that answer before rendering.
 */
export function DecorativeWindowControls() {
  const host = useHostInfo();
  if (host?.mode === "desktop") return null;
  return (
    <div className="win-ctrl">
      <span className="win-b">
        <Icon name="minus" cls="ico-sm" />
      </span>
      <span className="win-b">
        <Icon name="square" cls="ico-sm" />
      </span>
      <span className="win-b close">
        <Icon name="x" cls="ico-sm" />
      </span>
    </div>
  );
}
