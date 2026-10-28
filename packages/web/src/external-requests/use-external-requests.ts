import type { ExternalRequest } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { dismissExternalRequest, fetchExternalRequests } from "../api/external-requests";
import { bus } from "../api/ws-instance";

/**
 * The confirmation cards external agents raised through the CLI (release-0.2 ticket 04): the server's queue, read again
 * whenever the server says it changed and on every reconnect (a change may have been missed while the socket was down).
 * Nothing is kept across a reload: the queue lives in the workbench process.
 */
export function useExternalRequests(): { requests: ExternalRequest[]; refresh: () => Promise<void>; dismiss: (id: string) => Promise<void> } {
  const [requests, setRequests] = useState<ExternalRequest[]>([]);
  // Reads can answer out of order: only the newest one's answer is shown.
  const sent = useRef(0);
  const applied = useRef(0);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const mine = ++sent.current;
    try {
      const next = await fetchExternalRequests();
      if (!alive.current || mine < applied.current) return;
      applied.current = mine;
      setRequests(next);
    } catch {
      /* the next change or reconnect reads again; the cards on screen stay as they were */
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    // Subscribes on the page's bus directly, so a test that stubs ws.ts for another feature is not disturbed (as the Shelf does).
    const offs = [bus.on("external-requests.changed", () => void refresh()), bus.onResync(() => void refresh())];
    return () => { alive.current = false; for (const off of offs) off(); };
  }, [refresh]);
  const dismiss = useCallback(async (id: string) => {
    try { await dismissExternalRequest(id); } finally { await refresh(); }
  }, [refresh]);
  return { requests, refresh, dismiss };
}
