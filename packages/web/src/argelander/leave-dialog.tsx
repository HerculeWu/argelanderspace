import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton, Dialog } from "../ui";
import { registerWorkspaceLeaveGuard, type LeaveOrigin } from "./workspace";

/**
 * The one question the leave guards of the Doc views and the Writer manuscript delete ask (the argument graph page asks
 * the same, worded alike): "this would lose unsaved work: keep it or discard it?", in the app's own `Dialog` (never
 * `window.confirm`; only the browser's `beforeunload` prompt stays native). Stay is the safe default (initial focus,
 * Esc, backdrop, close button).
 *
 * `ask(body, origin)` resolves true when the person chose to discard. One question at a time, and the latest wins:
 * asking while another is open answers the earlier one no and the one dialog carries the new question (no dead dialog
 * is left whose answer nobody is waiting for). Two cases answer no without a dialog:
 * - `origin: "agent"`: false at once. The Copilot is waiting for an answer and the person has not chosen to leave.
 * - another modal dialog is open (a browser Back or a programmatic switch reaching past it): two modals never stack,
 *   their focus traps fight and Enter or Escape would settle one while the other stayed open. The check runs a
 *   task later (a microtask is too early: React commits an event's state change in a microtask of its own), so a caller
 *   that steps its own dialog aside in the same event (the Library's delete dialog) is already gone from the document.
 *   The refusal is not silent: a short status toast tells the person to close the open dialog first.
 * A question still open when the host unmounts is a no.
 *
 * `useLeaveQuestionOpen()` says whether any such question is pending or showing anywhere: a dialog of another view that
 * stepped aside for the question (the Library's delete dialog) comes back only when it is false, so a superseded question
 * (a browser Back while the delete question was open) never lets the two stack again.
 */
let openQuestions = 0;
const questionListeners = new Set<() => void>();
function countQuestion(delta: 1 | -1) {
  openQuestions += delta;
  for (const listener of questionListeners) listener();
}
export function useLeaveQuestionOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      questionListeners.add(listener);
      return () => void questionListeners.delete(listener);
    },
    () => openQuestions > 0,
    () => false
  );
}
const NOTICE_MS = 5000;

export function useLeaveDialog(): { ask: (body: string | string[], origin?: LeaveOrigin) => false | Promise<boolean>; dialog: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState<{ body: string[] } | null>(null);
  /** The pending question's resolver, from the moment it is asked (before its dialog shows) until it is answered. */
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const shown = useRef(false);
  shown.current = open !== null;
  const stayRef = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState(false);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback(() => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(true);
    noticeTimer.current = window.setTimeout(() => setNotice(false), NOTICE_MS);
  }, []);
  const ask = useCallback((body: string | string[], origin: LeaveOrigin = "user"): false | Promise<boolean> => {
    if (origin === "agent") return false;
    return new Promise<boolean>((resolve) => {
      const earlier = pending.current;
      pending.current = resolve;
      if (earlier) earlier(false); // superseded: its caller treats it as a "keep editing" (still one open question)
      else countQuestion(1);
      setTimeout(() => {
        if (pending.current !== resolve) return; // answered or superseded again, or the host went away
        if (!shown.current && document.querySelector('[role="dialog"][aria-modal="true"]')) {
          pending.current = null;
          countQuestion(-1);
          showNotice();
          resolve(false);
          return;
        }
        setOpen({ body: Array.isArray(body) ? body : [body] });
      }, 0);
    });
  }, [showNotice]);
  const answer = (discard: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    if (resolve) countQuestion(-1);
    setOpen(null);
    resolve?.(discard);
  };
  useEffect(() => () => {
    const resolve = pending.current;
    pending.current = null;
    if (resolve) countQuestion(-1);
    resolve?.(false);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);
  const dialog = open ? (
    <Dialog
      title={t("leaveDialog.title")}
      uiId="leave-dialog"
      closeLabel={t("leaveDialog.stay")}
      onClose={() => answer(false)}
      width={420}
      initialFocusRef={stayRef}
      footer={
        <>
          <ActionButton ref={stayRef} mode="text" label={t("leaveDialog.stay")} data-ui="leave-dialog-stay" onClick={() => answer(false)}>
            {t("leaveDialog.stay")}
          </ActionButton>
          <ActionButton mode="text" appearance="primary" tone="danger" label={t("leaveDialog.discard")} data-ui="leave-dialog-discard" onClick={() => answer(true)}>
            {t("leaveDialog.discard")}
          </ActionButton>
        </>
      }
    >
      <div data-ui="leave-dialog-body">{open.body.map((line) => <p key={line}>{line}</p>)}</div>
    </Dialog>
  ) : null;
  const toast = notice ? (
    <div className="leave-blocked-toast view-in" role="status" data-ui="leave-blocked-notice">
      {t("leaveDialog.blockedByDialog")}
    </div>
  ) : null;
  return {
    ask,
    dialog: (
      <>
        {dialog}
        {toast}
      </>
    ),
  };
}

/**
 * One Doc's leave question, shared by everything in it that can hold unsaved work (the PDF Reader, the text source editor,
 * the Reader's annotation drafts): a text Doc with an unsaved source and an annotation draft is asked about ONCE, the
 * dialog naming both. Mount it around the Doc's views; each registers its describer with `useUnsavedSource`.
 */
const SourcesContext = createContext<Set<() => string | null> | null>(null);

export function DocLeaveScope({ children }: { children: ReactNode }) {
  const [sources] = useState(() => new Set<() => string | null>());
  const { ask, dialog } = useLeaveDialog();
  useEffect(
    () =>
      registerWorkspaceLeaveGuard((origin) => {
        const unsaved = [...sources].map((describe) => describe()).filter((line): line is string => line !== null);
        return unsaved.length === 0 ? true : ask(unsaved, origin);
      }),
    [sources, ask]
  );
  return (
    <SourcesContext.Provider value={sources}>
      {children}
      {dialog}
    </SourcesContext.Provider>
  );
}

/**
 * A view that holds unsaved work says what would be lost (`describe` returns the sentence while there is some, else null).
 * Inside a `DocLeaveScope` it joins the Doc's one question; on its own (a view rendered without the Doc around it) it
 * registers its own guard and returns the dialog to render. `describe` is read when the question is asked.
 */
export function useUnsavedSource(describe: () => string | null): ReactNode {
  const scope = useContext(SourcesContext);
  const own = useLeaveDialog();
  const latest = useRef(describe);
  latest.current = describe;
  useEffect(() => {
    const read = () => latest.current();
    if (scope) {
      scope.add(read);
      return () => void scope.delete(read);
    }
    return registerWorkspaceLeaveGuard((origin) => {
      const line = read();
      return line === null ? true : own.ask([line], origin);
    });
  }, [scope, own.ask]);
  return scope ? null : own.dialog;
}
