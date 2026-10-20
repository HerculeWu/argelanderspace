import { useRef, useState } from "react";
import { createTextDoc } from "../api/text-docs";
import type { WorkJobs, WorkSession } from "./work-jobs";

export interface TextDocCreation {
  /** One create request is in flight. */
  busy: boolean;
  /** The last failed create's detail, shown under the full-text tab's actions. */
  error: string | null;
  /** Create an empty text Doc under the current Work; on success the new Doc opens (its source editor). */
  create(): void;
}

/**
 * Text Doc creation from a Work's full-text tab (Copilot ticket 25). One operation id per create ATTEMPT: a retry
 * after a lost response or an error reuses it (the server then finds the same Doc instead of making another) until
 * the creation succeeded, the Work changed, or the server says the operation can no longer be completed (409). An
 * answer whose Work session is no longer current is dropped: it changes neither busy nor error and opens nothing.
 * Busy and error belong to the Work session they were set in: once the Work changes (another Work, or the same Work
 * in a later session) both read as clear, even while that session's request is still in flight (ticket 14).
 */
export function useTextDocCreation(
  workId: string,
  session: WorkJobs["session"],
  onOpenDoc: (docId: string) => void
): TextDocCreation {
  const [state, setState] = useState<{ session: WorkSession; busy: boolean; error: string | null } | null>(null);
  const operation = useRef<{ workId: string; id: string } | null>(null);
  const shown = state && session.isCurrent(state.session) ? state : null;
  const create = () => {
    const started = { ...session.current() };
    setState({ session: started, busy: true, error: null });
    const attempt =
      operation.current?.workId === workId ? operation.current : { workId, id: `create-${crypto.randomUUID()}` };
    operation.current = attempt;
    void createTextDoc(workId, attempt.id).then((result) => {
      // Only this attempt is spent: by now another Work may have started its own (ticket 14 fix round 1).
      if ((result.ok || result.status === 409) && operation.current === attempt) operation.current = null;
      if (!session.isCurrent(started)) return;
      setState({ session: started, busy: false, error: result.ok ? null : result.detail });
      if (result.ok) onOpenDoc(result.docId);
    });
  };
  return { busy: shown?.busy ?? false, error: shown?.error ?? null, create };
}
