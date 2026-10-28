import type { IntakeChecklistState } from "@argelanderspace/contracts";
import { useEffect, useState } from "react";
import { fetchIntakeChecklistState } from "../api/intake";
import { bus } from "../api/ws-instance";

/**
 * The intake checklist's state as the server reports it (project-intake ticket 06): `null` until the first answer, then
 * kept current by the server's `intake.changed` (the file appeared or went) and by every reconnect of the socket.
 * Subscribes on the page's bus directly, like the Shelf: the entry does not depend on how a test stubs `api/ws`.
 */
export function useIntakeChecklist(): IntakeChecklistState | null {
  const [state, setState] = useState<IntakeChecklistState | null>(null);
  useEffect(() => {
    let alive = true;
    // Answers can come back out of order: only the newest read may set the state.
    let latest = 0;
    const read = () => {
      const mine = ++latest;
      void fetchIntakeChecklistState().then((next) => alive && mine === latest && setState(next));
    };
    read();
    const offs = [bus.on("intake.changed", read), bus.onResync(read)];
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, []);
  return state;
}
