import type { MailFolderRole, MailHeader } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../api/mail";
import { deleteMailMessage, moveMailMessage, setMailFlag } from "../api/mail-manage";
import { failureKind, manageReason } from "./manage-error";
import type { MailToast } from "./MailToasts";

export interface MessageRef {
  accountId: string;
  folder: string;
  uid: number;
}

/** What the actions need from the page that owns the lists (MailView). */
export interface MailActionsEnv {
  find(ref: MessageRef): MailHeader | undefined;
  /** Apply flags to every list showing the row (folder list and search results). */
  patch(ref: MessageRef, p: Partial<Pick<MailHeader, "unread" | "starred">>): void;
  /** Take the row out of every list; the returned function puts it back where it was. */
  remove(ref: MessageRef): () => void;
  /** Shift a folder's unread count in the folder tree. */
  bumpUnread(accountId: string, folder: string, delta: number): void;
  uidValidity(ref: MessageRef): number | undefined;
  folderRole(accountId: string, folder: string): MailFolderRole | undefined;
  folderName(accountId: string, folder: string): string;
  /** Close the reader if it shows this message; the returned function reopens what was shown. */
  closeIfOpen(ref: MessageRef): () => void;
  /**
   * Reload a folder list from the server if it has been loaded, without a spinner and keeping the pages the
   * user already loaded. Resolves false when the server could not be asked (what is shown then stays).
   */
  refreshLoaded(accountId: string, folder: string): Promise<boolean>;
  /** Reload an account's folder list and counts from the server (same contract). */
  refreshFolders(accountId: string): Promise<boolean>;
  /** Run the active search again; false when no search is active. */
  refreshSearch(): boolean;
  /** The account's Trash folder, if the folder list shows one. */
  trashFolder(accountId: string): string | undefined;
}

export interface PermanentDeleteState {
  ref: MessageRef;
  subject: string;
  busy: boolean;
  code: string | null;
}

const refKey = (r: MessageRef) => `${r.accountId}\u0000${r.folder}\u0000${r.uid}`;
const codeOf = (e: unknown) => (e instanceof MailApiError ? e.code : "unreachable");

/**
 * Optimistic mail management with honest rollback (Mail ticket 06). The UI shows
 * the change at once; the server's answer decides. A failure puts back exactly
 * what was shown before (flags, row position, folder counts, the open reader)
 * and says why. A permanent delete is the one change that is NOT optimistic: it
 * is irreversible, so the row only goes once the server has deleted it.
 */
export function useMailActions(env: MailActionsEnv) {
  const { t } = useTranslation();
  const envRef = useRef(env);
  envRef.current = env;
  const [toasts, setToasts] = useState<MailToast[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [confirm, setConfirm] = useState<PermanentDeleteState | null>(null);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const pendingTimers = timers.current;
    return () => {
      alive.current = false;
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);
  const push = useCallback(
    (toast: Omit<MailToast, "id">) => {
      if (!alive.current) return;
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-2), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), toast.tone === "danger" ? 12_000 : 8_000)
      );
    },
    [dismiss]
  );

  const fail = (key: "flagFailed" | "moveFailed" | "deleteFailed", code: string) => {
    const reason = manageReason(t, code);
    const kind = failureKind(code);
    push({
      tone: "danger",
      text:
        kind === "unknown"
          ? t("mail.manage.outcomeUnknown", { reason })
          : kind === "gone"
            ? t("mail.manage.gone", { reason })
            : kind === "partial"
              ? t("mail.manage.partial")
              : t(`mail.manage.${key}`, { reason }),
    });
  };
  /**
   * After a broken connection nobody knows whether the change happened. The optimistic view is rolled back
   * (the page must not keep claiming a result) and the affected lists are reloaded SILENTLY, so what stays on
   * screen is what the server says. Chosen over "ask the user to refresh" because the server is the only
   * authority. If the reload fails too, the rolled-back state stays and the user is told that nothing could be
   * confirmed; a success is said just as plainly. An active search is run again as well.
   */
  const reloadFromServer = async (accountId: string, folders: (string | null | undefined)[]) => {
    const env = envRef.current;
    const results = await Promise.all([
      env.refreshFolders(accountId),
      ...[...new Set(folders)].filter((f): f is string => !!f).map((f) => env.refreshLoaded(accountId, f)),
    ]);
    env.refreshSearch();
    if (!alive.current) return;
    push(
      results.every(Boolean)
        ? { tone: "info", text: t("mail.manage.reloaded") }
        : { tone: "danger", text: t("mail.manage.unconfirmed") }
    );
  };

  const setBusy = (key: string, on: boolean) => {
    if (on) pendingRef.current.add(key);
    else pendingRef.current.delete(key);
    if (alive.current) setPending(new Set(pendingRef.current));
  };

  // ---- flags ---------------------------------------------------------------------
  const toggleFlag = async (ref: MessageRef, flag: "seen" | "flagged", value: boolean) => {
    const env = envRef.current;
    const key = refKey(ref);
    const header = env.find(ref);
    if (!header || pendingRef.current.has(key)) return;
    const before = { unread: header.unread, starred: header.starred };
    const optimistic = flag === "seen" ? { unread: !value } : { starred: value };
    const countDelta = (from: boolean, to: boolean) => (from === to ? 0 : to ? 1 : -1);
    setBusy(key, true);
    env.patch(ref, optimistic);
    if (flag === "seen") env.bumpUnread(ref.accountId, ref.folder, countDelta(before.unread, !value));
    try {
      const r = await setMailFlag(ref.accountId, {
        folder: ref.folder,
        uid: ref.uid,
        uidValidity: env.uidValidity(ref),
        flag,
        value,
      });
      if (!alive.current) return;
      // Settle on what the server holds, which is normally what was asked for.
      env.patch(ref, { unread: r.unread, starred: r.starred });
      if (flag === "seen") env.bumpUnread(ref.accountId, ref.folder, countDelta(!value, r.unread));
    } catch (e) {
      if (!alive.current) return;
      const code = codeOf(e);
      env.patch(ref, before);
      if (flag === "seen") env.bumpUnread(ref.accountId, ref.folder, countDelta(!value, before.unread));
      if (code === "message_not_found") {
        env.remove(ref);
        env.closeIfOpen(ref);
      }
      fail("flagFailed", code);
      if (failureKind(code) === "unknown") void reloadFromServer(ref.accountId, [ref.folder]);
    } finally {
      setBusy(key, false);
    }
  };
  const toggleRead = (ref: MessageRef) => {
    const h = envRef.current.find(ref);
    if (h) void toggleFlag(ref, "seen", h.unread); // unread now -> mark read
  };
  const toggleStar = (ref: MessageRef) => {
    const h = envRef.current.find(ref);
    if (h) void toggleFlag(ref, "flagged", !h.starred);
  };

  // ---- move and delete -------------------------------------------------------------
  /** Run a move/trash optimistically. `request` resolves to where the message now is. */
  const relocate = async (
    ref: MessageRef,
    request: () => Promise<{ destination: string | null; uid: number | null; uidValidity: number | null }>,
    destinationHint: string | null,
    kind: "move" | "delete"
  ) => {
    const env = envRef.current;
    const key = refKey(ref);
    const header = env.find(ref);
    if (!header || pendingRef.current.has(key)) return;
    setBusy(key, true);
    const putBackRow = env.remove(ref);
    const putBackReader = env.closeIfOpen(ref);
    if (header.unread) env.bumpUnread(ref.accountId, ref.folder, -1);
    if (header.unread && destinationHint) env.bumpUnread(ref.accountId, destinationHint, 1);
    const rollback = () => {
      putBackRow();
      putBackReader();
      if (header.unread) env.bumpUnread(ref.accountId, ref.folder, 1);
      if (header.unread && destinationHint) env.bumpUnread(ref.accountId, destinationHint, -1);
    };
    try {
      const r = await request();
      if (!alive.current) return;
      const dest = r.destination ?? destinationHint;
      // A reload that raced this call may have brought the row back from the server: it is gone now.
      env.remove(ref);
      if (dest) void env.refreshLoaded(ref.accountId, dest);
      const undo =
        dest && r.uid !== null && r.uidValidity !== null
          ? {
              label: t("mail.manage.undo"),
              run: () => void undoRelocation(ref, header, dest, r.uid as number, r.uidValidity as number),
            }
          : undefined;
      push({
        tone: "info",
        text:
          kind === "delete"
            ? t("mail.manage.trashed")
            : t("mail.manage.movedTo", { folder: dest ? env.folderName(ref.accountId, dest) : "" }),
        action: undo,
      });
    } catch (e) {
      if (!alive.current) return;
      const code = codeOf(e);
      if (code === "message_not_found") {
        // Gone on the server: it must not come back into the list; only the counts are put back.
        if (header.unread) env.bumpUnread(ref.accountId, ref.folder, 1);
        if (header.unread && destinationHint) env.bumpUnread(ref.accountId, destinationHint, -1);
        fail(kind === "delete" ? "deleteFailed" : "moveFailed", code);
      } else {
        rollback();
        // The server knows this folder is the Trash although the folder list did not say so.
        if (code === "confirmation_required")
          setConfirm({ ref, subject: header.subject, busy: false, code: null });
        else {
          fail(kind === "delete" ? "deleteFailed" : "moveFailed", code);
          const failure = failureKind(code);
          const target = destinationHint ?? env.trashFolder(ref.accountId);
          if (failure === "unknown") void reloadFromServer(ref.accountId, [ref.folder, target]);
          // a copy exists in the destination: show it there (the state is known, so no "unknown" notice)
          else if (failure === "partial" && target) void env.refreshLoaded(ref.accountId, target);
        }
      }
    } finally {
      setBusy(key, false);
    }
  };

  const undoRelocation = async (
    ref: MessageRef,
    header: MailHeader,
    from: string,
    newUid: number,
    newValidity: number
  ) => {
    const env = envRef.current;
    try {
      await moveMailMessage(ref.accountId, {
        folder: from,
        uid: newUid,
        uidValidity: newValidity,
        destination: ref.folder,
      });
      if (!alive.current) return;
      if (header.unread) {
        env.bumpUnread(ref.accountId, from, -1);
        env.bumpUnread(ref.accountId, ref.folder, 1);
      }
      void env.refreshLoaded(ref.accountId, ref.folder);
      void env.refreshLoaded(ref.accountId, from);
      push({ tone: "info", text: t("mail.manage.undone") });
    } catch (e) {
      if (!alive.current) return;
      const code = codeOf(e);
      fail("moveFailed", code);
      if (failureKind(code) === "unknown") void reloadFromServer(ref.accountId, [ref.folder, from]);
    }
  };

  const move = (ref: MessageRef, destination: string) =>
    relocate(
      ref,
      async () => {
        const r = await moveMailMessage(ref.accountId, {
          folder: ref.folder,
          uid: ref.uid,
          uidValidity: envRef.current.uidValidity(ref),
          destination,
        });
        return { destination: r.destination, uid: r.uid, uidValidity: r.uidValidity };
      },
      destination,
      "move"
    );

  const deleteTo = (ref: MessageRef) =>
    relocate(
      ref,
      async () => {
        const r = await deleteMailMessage(ref.accountId, {
          folder: ref.folder,
          uid: ref.uid,
          uidValidity: envRef.current.uidValidity(ref),
        });
        return { destination: r.destination, uid: r.uid, uidValidity: r.uidValidity };
      },
      null,
      "delete"
    );

  /** Delete: into Trash at once (undoable); inside Trash only after the user confirms (irreversible). */
  const requestDelete = (ref: MessageRef) => {
    const env = envRef.current;
    const header = env.find(ref);
    if (!header) return;
    if (env.folderRole(ref.accountId, ref.folder) === "trash")
      setConfirm({ ref, subject: header.subject, busy: false, code: null });
    else void deleteTo(ref);
  };

  const confirmingRef = useRef(false);
  const confirmPermanent = async () => {
    const cur = confirm;
    // A synchronous guard: two clicks in one tick both see busy=false in the closure, the ref does not.
    if (!cur || cur.busy || confirmingRef.current) return;
    confirmingRef.current = true;
    const env = envRef.current;
    const uidValidity = env.uidValidity(cur.ref);
    if (uidValidity === undefined) {
      // An irreversible delete must name the exact uid generation; without one nothing is sent.
      confirmingRef.current = false;
      setConfirm({ ...cur, code: "invalid_input" });
      return;
    }
    setConfirm({ ...cur, busy: true, code: null });
    try {
      await deleteMailMessage(cur.ref.accountId, {
        folder: cur.ref.folder,
        uid: cur.ref.uid,
        uidValidity,
        permanent: true,
      });
      if (!alive.current) return;
      env.remove(cur.ref);
      env.closeIfOpen(cur.ref);
      void env.refreshLoaded(cur.ref.accountId, env.trashFolder(cur.ref.accountId) ?? cur.ref.folder);
      setConfirm(null);
      push({ tone: "info", text: t("mail.manage.deletedForever") });
    } catch (e) {
      if (!alive.current) return;
      const code = codeOf(e);
      if (code === "message_not_found") {
        env.remove(cur.ref);
        env.closeIfOpen(cur.ref);
      }
      setConfirm({ ...cur, busy: false, code }); // the dialog stays open with the reason
      // After a broken connection the message may be gone or not: ask the server (silently).
      if (failureKind(code) === "unknown") void reloadFromServer(cur.ref.accountId, [cur.ref.folder]);
    } finally {
      confirmingRef.current = false;
    }
  };

  return {
    toasts,
    dismissToast: dismiss,
    pending,
    confirm,
    cancelConfirm: () => setConfirm((c) => (c?.busy ? c : null)),
    toggleRead,
    toggleStar,
    move,
    requestDelete,
    confirmPermanent,
  };
}
