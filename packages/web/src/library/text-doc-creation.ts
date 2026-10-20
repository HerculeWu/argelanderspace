import { useRef, useState } from "react";
import { createTextDoc } from "../api/text-docs";
import type { WorkJobs } from "./work-jobs";

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
 */
export function useTextDocCreation(
  workId: string,
  session: WorkJobs["session"],
  onOpenDoc: (docId: string) => void
): TextDocCreation {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<{ workId: string; id: string } | null>(null);
  const create = () => {
    const started = { ...session.current() };
    setBusy(true);
    setError(null);
    const attempt =
      operation.current?.workId === workId ? operation.current : { workId, id: `create-${crypto.randomUUID()}` };
    operation.current = attempt;
    void createTextDoc(workId, attempt.id).then((result) => {
      if (result.ok || result.status === 409) operation.current = null;
      if (!session.isCurrent(started)) return;
      setBusy(false);
      if (result.ok) onOpenDoc(result.docId);
      else setError(result.detail);
    });
  };
  return { busy, error, create };
}
