/**
 * Writing, sending and the 8 second undo (Mail ticket 07). Three pieces share one provider mounted by
 * MailView: the floating composer, the undo countdowns at the bottom of the page, and the reply /
 * forward actions of the open message. The server owns every window (it sends at the deadline unless
 * undone); this component only shows them, calls undo, and reports what the server says happened,
 * including after a restart (interrupted / unknown). Several sends may be in their window at once,
 * each with its own countdown, undo and result. Nothing here ever replaces text the user is typing.
 */

import {
  MAIL_ATTACHMENT_MAX_BYTES,
  MAIL_ATTACHMENT_TOTAL_MAX_BYTES,
  type MailAccount,
  type MailComposeDraft,
  type MailMessage,
  type MailSendStatus,
} from "@argelanderspace/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../api/mail";
import {
  discardMailDraft,
  dismissMailSend,
  fetchMailOutbox,
  fetchMailSendStatus,
  initMailCompose,
  removeMailAttachment,
  saveMailDraft,
  startMailSend,
  undoMailSend,
  uploadMailAttachment,
} from "../api/mail-compose";
import { Icon } from "../lib/icons";
import { Button, IconButton } from "../ui";
import { type ComposeState, ComposeWindow } from "./ComposeWindow";
import "./compose.css";

const SAVE_DELAY_MS = 1200;
const POLL_MS = 600;
const GIVE_UP_MS = 10 * 60 * 1000;
/** Set when leaving Mail could not save the open draft; reported the next time Mail opens. */
const UNSAVED_KEY = "argelander.mail.unsavedDraft";

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Edits the server does not have: anything but the draft object it last confirmed, or a changed sender. */
const isUnsaved = (c: ComposeState) =>
  c.touched && (c.draft !== c.savedDraft || c.savedOn !== c.accountId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorCode = (e: unknown) => (e instanceof MailApiError ? e.code : "unreachable");
const clock = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export interface Notice {
  id: number;
  tone: "info" | "warning" | "danger";
  text: string;
  action?: { label: string; run: (id: number) => void };
  /** Server marker to forget when the user closes this notice. */
  forget?: { accountId: string; sendId: string };
  autoCloseMs?: number;
}

interface Pending {
  accountId: string;
  sendId: string;
  subject: string;
  endsAt: number;
  phase: "window" | "sending";
  /** The server could not be reached the last time we asked how this send ended. */
  unreachable: boolean;
  /** What was in the composer, to restore on undo / failure. Null after a page reload. */
  snapshot: ComposeState | null;
}

export interface MailComposeApi {
  startNew(): void;
  startFrom(mode: "reply" | "replyAll" | "forward", message: MailMessage): void;
  editDraft(message: MailMessage): void;
  busy: boolean;
  canCompose: boolean;
  isDraftsFolder(accountId: string, folder: string): boolean;
}

const Ctx = createContext<MailComposeApi | null>(null);
const LayerCtx = createContext<{
  compose: ComposeState | null;
  pendings: Pending[];
  now: number;
  notices: Notice[];
  actions: {
    change: (patch: Partial<MailComposeDraft> & { accountId?: string }) => void;
    showCc: () => void;
    minimize: (v: boolean) => void;
    attach: (files: File[]) => void;
    removeAttachment: (id: string) => void;
    send: () => void;
    close: () => void;
    discard: () => Promise<string | null>;
    undo: (sendId: string) => void;
    closeNotice: (id: number) => void;
  };
  accounts: MailAccount[];
} | null>(null);

export const useMailCompose = () => useContext(Ctx);

export interface MailComposeProviderProps {
  accounts: MailAccount[];
  /** Account ids that can currently send (logged in). */
  sendableIds: string[];
  /** Show the Drafts folder of this account. */
  onOpenDrafts: (accountId: string) => void;
  /** Something changed on the server (a send finished, a draft changed): refresh the lists. */
  onChanged: () => void;
  isDraftsFolder: (accountId: string, folder: string) => boolean;
  children: ReactNode;
}

function emptyDraft(account: MailAccount): MailComposeDraft {
  const domain = account.address.split("@")[1] ?? "localhost";
  return {
    messageId: `<${uuid()}@${domain.replace(/[^A-Za-z0-9.-]/g, "")}>`,
    inReplyTo: null,
    references: [],
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    attachments: [],
  };
}

export function MailComposeProvider(props: MailComposeProviderProps) {
  const { t, i18n } = useTranslation();
  const { accounts, sendableIds } = props;
  const sendable = useMemo(
    () => accounts.filter((a) => sendableIds.includes(a.id)),
    [accounts, sendableIds]
  );
  const [compose, setComposeState] = useState<ComposeState | null>(null);
  const [pendings, setPendingsState] = useState<Pending[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState(false);
  const composeRef = useRef<ComposeState | null>(null);
  const pendingsRef = useRef<Pending[]>([]);
  const noticeSeq = useRef(1);
  const alive = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;
  const saver = useRef({
    timer: null as ReturnType<typeof setTimeout> | null,
    inflight: false,
    dirty: false,
  });
  /** Send ids whose result is being polled right now (one loop each). */
  const watching = useRef(new Set<string>());
  /** The id of the send the user just asked for: reused while the same draft is retried. */
  const intent = useRef<{ sig: string; id: string } | null>(null);

  const setCompose = useCallback((c: ComposeState | null) => {
    composeRef.current = c;
    setComposeState(c);
  }, []);
  const patchCompose = useCallback((f: (c: ComposeState) => ComposeState) => {
    const cur = composeRef.current;
    if (!cur) return;
    const next = f(cur);
    composeRef.current = next;
    setComposeState(next);
  }, []);
  const setPendings = useCallback((f: (list: Pending[]) => Pending[]) => {
    const next = f(pendingsRef.current);
    pendingsRef.current = next;
    setPendingsState(next);
  }, []);
  const patchPending = useCallback(
    (sendId: string, patch: Partial<Pending>) =>
      setPendings((list) => list.map((p) => (p.sendId === sendId ? { ...p, ...patch } : p))),
    [setPendings]
  );

  const notify = useCallback((n: Omit<Notice, "id">): number => {
    const id = noticeSeq.current++;
    setNotices((list) => [
      ...list.filter((x) => !(n.forget && x.forget?.sendId === n.forget.sendId)),
      { ...n, id },
    ]);
    if (n.autoCloseMs)
      setTimeout(() => {
        if (alive.current) setNotices((list) => list.filter((x) => x.id !== id));
      }, n.autoCloseMs);
    return id;
  }, []);
  const closeNotice = useCallback((id: number) => {
    setNotices((list) => {
      const gone = list.find((x) => x.id === id);
      if (gone?.forget) void dismissMailSend(gone.forget.accountId, gone.forget.sendId).catch(() => {});
      return list.filter((x) => x.id !== id);
    });
  }, []);

  const errText = useCallback(
    (code: string) =>
      t(`mail.compose.error.${code}`, {
        defaultValue: t(`mail.error.${code}`, { defaultValue: t("mail.error.unknown") }),
        name: "",
        limit: "",
      }),
    [t]
  );

  // ---- saving the draft to the server ------------------------------------------------
  const runSave = useCallback(async () => {
    const s = saver.current;
    if (s.inflight) {
      s.dirty = true;
      return;
    }
    const c = composeRef.current;
    if (!c || !c.touched || c.sending) return;
    s.inflight = true;
    patchCompose((x) => ({ ...x, save: "saving" }));
    try {
      const staleOn = c.savedOn && c.savedOn !== c.accountId ? c.savedOn : null;
      if (staleOn) {
        // The sender changed: the copy in the old account's Drafts has to go. Without the attachments:
        // they are staged independent of the account and move with the draft.
        await discardMailDraft(staleOn, { ...c.draft, attachments: [] }).catch(() => {});
      }
      await saveMailDraft(c.accountId, c.draft);
      if (alive.current)
        patchCompose((x) => ({
          ...x,
          save: "saved",
          saveCode: null,
          savedAt: clock(),
          savedOn: c.accountId,
          // Only what was sent counts as saved: an edit made meanwhile stays "unsaved".
          savedDraft: c.draft,
        }));
    } catch (e) {
      if (alive.current) patchCompose((x) => ({ ...x, save: "failed", saveCode: errorCode(e) }));
    } finally {
      s.inflight = false;
      if (s.dirty) {
        s.dirty = false;
        void runSave();
      }
    }
  }, [patchCompose]);

  const scheduleSave = useCallback(() => {
    const s = saver.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      void runSave();
    }, SAVE_DELAY_MS);
  }, [runSave]);

  // Leaving Mail with text the server does not have yet: send it now, best effort. If that fails too,
  // remember it so the next visit says so instead of silently losing the edit.
  useEffect(() => {
    alive.current = true;
    try {
      if (sessionStorage.getItem(UNSAVED_KEY)) {
        sessionStorage.removeItem(UNSAVED_KEY);
        notify({ tone: "warning", text: t("mail.compose.unsavedOnLeave") });
      }
    } catch {
      /* storage unavailable: nothing to report */
    }
    return () => {
      alive.current = false;
      const s = saver.current;
      const c = composeRef.current;
      if (s.timer) clearTimeout(s.timer);
      if (c && !c.sending && isUnsaved(c)) {
        void saveMailDraft(c.accountId, c.draft).catch(() => {
          try {
            sessionStorage.setItem(UNSAVED_KEY, "1");
          } catch {
            /* storage unavailable */
          }
        });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- opening the composer ------------------------------------------------------------
  const open = useCallback(
    (state: ComposeState) => {
      if (saver.current.timer) clearTimeout(saver.current.timer);
      setCompose(state);
    },
    [setCompose]
  );

  const baseState = (
    mode: ComposeState["mode"],
    accountId: string,
    draft: MailComposeDraft
  ): ComposeState => ({
    uid: uuid(),
    mode,
    accountId,
    draft,
    savedDraft: null,
    attachments: [],
    uploading: [],
    showCc: draft.cc !== "" || draft.bcc !== "",
    minimized: false,
    save: "idle",
    savedAt: null,
    savedOn: null,
    touched: false,
    error: null,
    errorName: null,
    sending: false,
  });

  /** Show a composer, but never over a window that is open: then it is offered in a notice (with "Open"). */
  const closeCurrentRef = useRef<() => Promise<boolean>>(async () => true);
  const closeNoticeRef = useRef<(id: number) => void>(() => {});
  const present = useCallback(
    (state: ComposeState, text: string, tone: Notice["tone"]) => {
      if (!composeRef.current) {
        open(state);
        return;
      }
      notify({
        tone,
        text,
        action: {
          label: t("mail.compose.openIt"),
          run: (id) => {
            // The open composer is saved to the server first; if that fails (or it is sending) it stays.
            void closeCurrentRef.current().then((closed) => {
              if (!closed) return;
              open(state);
              closeNoticeRef.current(id);
            });
          },
        },
      });
    },
    [notify, open, t]
  );

  const startNew = useCallback(() => {
    const a = sendable[0];
    if (!a) return;
    open(baseState("new", a.id, emptyDraft(a)));
  }, [sendable, open]);

  const startFromServer = useCallback(
    async (mode: "reply" | "replyAll" | "forward" | "draft", message: MailMessage) => {
      const account = accounts.find((a) => a.id === message.accountId);
      if (!account) return;
      setBusy(true);
      try {
        const r = await initMailCompose(account.id, {
          mode,
          folder: message.folder,
          uid: message.uid,
          uidValidity: message.uidValidity,
          locale: i18n.language === "en" ? "en" : "zh-CN",
        });
        if (!alive.current) return;
        const st = baseState(mode, account.id, r.draft);
        st.attachments = r.attachments;
        // An edited draft is already on the server under that Message-ID.
        if (mode === "draft") {
          st.savedOn = account.id;
          st.save = "saved";
          st.savedDraft = r.draft;
        }
        present(
          st,
          t("mail.compose.initReady", { subject: r.draft.subject || t("mail.noSubject") }),
          "info"
        );
      } catch (e) {
        if (alive.current)
          notify({
            tone: "danger",
            text: `${t("mail.compose.initFailed")} ${errText(errorCode(e))}`,
            autoCloseMs: 8000,
          });
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [accounts, i18n.language, present, notify, errText, t]
  );

  // ---- editing --------------------------------------------------------------------------
  const change = useCallback(
    (patch: Partial<MailComposeDraft> & { accountId?: string }) => {
      const { accountId, ...fields } = patch;
      if (composeRef.current?.sending) return; // a send in flight owns the text
      patchCompose((c) => ({
        ...c,
        accountId: accountId ?? c.accountId,
        draft: { ...c.draft, ...fields },
        touched: true,
        error: null,
        errorName: null,
        save: c.save === "failed" ? "idle" : c.save,
      }));
      scheduleSave();
    },
    [patchCompose, scheduleSave]
  );

  const attach = useCallback(
    (files: File[]) => {
      const c = composeRef.current;
      if (!c || c.sending) return;
      const accountId = c.accountId;
      for (const file of files) {
        const have = composeRef.current?.attachments.reduce((n, a) => n + a.size, 0) ?? 0;
        if (file.size > MAIL_ATTACHMENT_MAX_BYTES || have + file.size > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
          patchCompose((x) => ({ ...x, error: "attachment_too_large", errorName: file.name }));
          continue;
        }
        patchCompose((x) => ({ ...x, uploading: [...x.uploading, file.name], error: null, errorName: null }));
        void uploadMailAttachment(accountId, file)
          .then((staged) => {
            if (!alive.current) return;
            patchCompose((x) => ({
              ...x,
              uploading: x.uploading.filter((n) => n !== file.name),
              attachments: [...x.attachments, staged],
              draft: { ...x.draft, attachments: [...x.draft.attachments, staged.id] },
              touched: true,
            }));
            scheduleSave();
          })
          .catch((e) => {
            if (alive.current)
              patchCompose((x) => ({
                ...x,
                uploading: x.uploading.filter((n) => n !== file.name),
                error: errorCode(e),
                errorName: file.name,
              }));
          });
      }
    },
    [patchCompose, scheduleSave]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const c = composeRef.current;
      if (!c || c.sending) return;
      void removeMailAttachment(c.accountId, id).catch(() => {});
      patchCompose((x) => ({
        ...x,
        attachments: x.attachments.filter((a) => a.id !== id),
        draft: { ...x.draft, attachments: x.draft.attachments.filter((a) => a !== id) },
        touched: true,
      }));
      scheduleSave();
    },
    [patchCompose, scheduleSave]
  );

  // ---- closing and discarding ------------------------------------------------------------
  /** Close the open composer after making sure the server has its text. False: it stays open (save failed). */
  const closeCurrent = useCallback(async (): Promise<boolean> => {
    const c = composeRef.current;
    if (!c) return true;
    if (c.sending) return false; // a send in flight cannot be walked away from
    const s = saver.current;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    // Never lose text: whatever the server does not have yet (edits after the last save included, also
    // the ones whose delayed save we just cancelled) is written first; the window stays if that fails.
    for (let attempt = 0; attempt < 4; attempt++) {
      while (s.inflight) await sleep(50);
      const cur = composeRef.current;
      if (!cur || cur.uid !== c.uid) return false;
      if (!isUnsaved(cur)) break;
      await runSave();
      while (s.inflight) await sleep(50);
      if (composeRef.current?.save === "failed") return false;
    }
    const last = composeRef.current;
    if (!last || last.uid !== c.uid || last.sending || isUnsaved(last)) return false;
    if (alive.current) setCompose(null);
    if (c.savedOn) propsRef.current.onChanged();
    return true;
  }, [runSave, setCompose]);

  closeCurrentRef.current = closeCurrent;
  closeNoticeRef.current = closeNotice;

  /** Returns the failure code (the dialog shows it and stays open) or null when the draft is gone. */
  const discard = useCallback(async (): Promise<string | null> => {
    const c = composeRef.current;
    if (!c) return null;
    if (saver.current.timer) clearTimeout(saver.current.timer);
    if (c.savedOn) {
      try {
        await discardMailDraft(c.savedOn, c.draft);
      } catch (e) {
        return errorCode(e);
      }
      propsRef.current.onChanged();
    } else {
      for (const a of c.attachments) void removeMailAttachment(c.accountId, a.id).catch(() => {});
    }
    setCompose(null);
    return null;
  }, [setCompose]);

  // ---- sending, the windows and what happened -----------------------------------------------
  /** Put a restored composer in front of the user, but never over text they are typing now. */
  const restoreCompose = useCallback(
    (p: Pending, code: string | null) => {
      const snap = p.snapshot;
      const subject = p.subject || t("mail.noSubject");
      const openDrafts = {
        label: t("mail.compose.openDrafts"),
        run: () => propsRef.current.onOpenDrafts(p.accountId),
      };
      if (!snap) {
        notify({
          tone: code ? "danger" : "info",
          text: code ? errText(code) : t("mail.compose.undone"),
          action: openDrafts,
          autoCloseMs: 10000,
        });
        return;
      }
      const restored: ComposeState = {
        ...snap,
        sending: false,
        error: code,
        errorName: null,
        save: "idle",
        // The server may or may not hold the final version (a failure before Drafts): treat it as unsaved.
        savedDraft: null,
        savedOn: p.accountId,
        minimized: false,
      };
      present(
        restored,
        code
          ? t("mail.compose.restoreFailed", { subject, reason: errText(code) })
          : t("mail.compose.restoreUndone", { subject }),
        code ? "danger" : "info"
      );
    },
    [errText, notify, present, t]
  );

  const settle = useCallback(
    (p: Pending, st: MailSendStatus) => {
      setPendings((list) => list.filter((x) => x.sendId !== p.sendId));
      const forget = { accountId: p.accountId, sendId: p.sendId };
      const subject = p.subject || t("mail.noSubject");
      const openDrafts = {
        label: t("mail.compose.openDrafts"),
        run: () => propsRef.current.onOpenDrafts(p.accountId),
      };
      if (st.state === "sent") {
        notify({ tone: "info", text: t("mail.compose.sentNamed", { subject }), autoCloseMs: 4000 });
        // Anything the user must know (no Sent copy, refused recipients, a draft copy left behind) stays
        // on screen, and the server keeps the result until it is closed.
        const warnings: string[] = [];
        if (st.sentCopy === "failed") warnings.push(t("mail.compose.sentNoCopy"));
        else if (st.draftKept) warnings.push(t("mail.compose.sentDraftKept"));
        if (st.rejected > 0) warnings.push(t("mail.compose.rejectedSome", { n: st.rejected }));
        if (warnings.length > 0)
          notify({ tone: "warning", text: warnings.join(" "), action: openDrafts, forget });
        else void dismissMailSend(p.accountId, p.sendId).catch(() => {});
        propsRef.current.onChanged();
      } else if (st.state === "failed") {
        void dismissMailSend(p.accountId, p.sendId).catch(() => {});
        restoreCompose(p, st.code ?? "unknown");
        propsRef.current.onChanged();
      } else if (st.state === "cancelled") {
        void dismissMailSend(p.accountId, p.sendId).catch(() => {});
        restoreCompose(p, null);
      } else if (st.state === "interrupted") {
        notify({
          tone: "warning",
          text: t("mail.compose.interrupted", { subject }),
          action: openDrafts,
          forget,
        });
        propsRef.current.onChanged();
      } else {
        notify({
          tone: "warning",
          text: t("mail.compose.unknown", { subject }),
          action: openDrafts,
          forget,
        });
        propsRef.current.onChanged();
      }
    },
    [notify, restoreCompose, setPendings, t]
  );

  /** After the window: ask the server until the send reached a final state (also across a server restart). */
  const watch = useCallback(
    async (first: Pending) => {
      if (watching.current.has(first.sendId)) return;
      watching.current.add(first.sendId);
      const started = Date.now();
      let delay = POLL_MS;
      const lost = (p: Pending) => {
        setPendings((list) => list.filter((x) => x.sendId !== p.sendId));
        notify({
          tone: "warning",
          text: t("mail.compose.statusLost", { subject: p.subject || t("mail.noSubject") }),
          action: { label: t("mail.compose.openDrafts"), run: () => propsRef.current.onOpenDrafts(p.accountId) },
        });
      };
      try {
        for (;;) {
          const p = pendingsRef.current.find((x) => x.sendId === first.sendId);
          if (!alive.current || !p) return;
          try {
            const st = await fetchMailSendStatus(p.accountId, p.sendId);
            if (!alive.current) return;
            if (st.state === "pending" && !st.ownedElsewhere && st.remainingMs !== null && st.remainingMs > 0) {
              // Clock skew: the server still counts the window down.
              patchPending(p.sendId, { endsAt: Date.now() + st.remainingMs, phase: "window", unreachable: false });
              return;
            }
            if (st.state !== "pending" && st.state !== "sending") return settle(p, st);
            if (p.unreachable) patchPending(p.sendId, { unreachable: false });
            delay = POLL_MS;
          } catch (e) {
            if (e instanceof MailApiError && e.status === 404) return lost(p);
            patchPending(p.sendId, { unreachable: true });
            delay = Math.min(delay * 1.6, 4000);
          }
          if (Date.now() - started > GIVE_UP_MS) return lost(p);
          await new Promise((r) => setTimeout(r, delay));
        }
      } finally {
        watching.current.delete(first.sendId);
      }
    },
    [notify, patchPending, setPendings, settle, t]
  );

  const send = useCallback(async () => {
    const c = composeRef.current;
    if (!c || c.sending) return;
    if (`${c.draft.to}${c.draft.cc}${c.draft.bcc}`.trim() === "") {
      patchCompose((x) => ({ ...x, error: "no_recipients" }));
      return;
    }
    if (c.uploading.length > 0) return;
    if (saver.current.timer) {
      clearTimeout(saver.current.timer);
      saver.current.timer = null;
    }
    patchCompose((x) => ({ ...x, sending: true, error: null, errorName: null }));
    // The same content retried (the first answer may have been lost) is the same send, not a second one.
    const sig = `${c.accountId}\u0000${JSON.stringify(c.draft)}`;
    const sendId = intent.current?.sig === sig ? intent.current.id : uuid();
    intent.current = { sig, id: sendId };
    try {
      const st = await startMailSend(c.accountId, sendId, c.draft);
      intent.current = null;
      if (!alive.current) return;
      // The snapshot is this composer's (by uid); a different window is never closed or rewritten here.
      const mine = composeRef.current?.uid === c.uid ? composeRef.current : null;
      const snapshot = { ...(mine ?? c), sending: false };
      if (mine) setCompose(null);
      setPendings((list) => [
        ...list.filter((x) => x.sendId !== sendId),
        {
          accountId: c.accountId,
          sendId,
          subject: c.draft.subject,
          endsAt: Date.now() + (st.remainingMs ?? 0),
          phase: "window",
          unreachable: false,
          snapshot,
        },
      ]);
      setNow(Date.now());
    } catch (e) {
      if (!alive.current) return;
      const code = errorCode(e);
      if (composeRef.current?.uid === c.uid) {
        patchCompose((x) => ({ ...x, sending: false, error: code, errorName: null }));
      } else {
        // Its window is gone: the text is not lost, it comes back through a notice.
        present(
          {
            ...c,
            sending: false,
            error: code,
            errorName: null,
            save: "idle",
            savedDraft: null,
            minimized: false,
          },
          t("mail.compose.restoreFailed", {
            subject: c.draft.subject || t("mail.noSubject"),
            reason: errText(code),
          }),
          "danger"
        );
      }
    }
  }, [patchCompose, setCompose, setPendings, present, errText, t]);

  // One ticker for all countdowns; a window that reaches zero starts watching its send.
  const anyWindow = pendings.some((p) => p.phase === "window");
  useEffect(() => {
    if (!anyWindow) return;
    const id = setInterval(() => {
      const t0 = Date.now();
      setNow(t0);
      for (const p of pendingsRef.current) {
        if (p.phase === "window" && t0 >= p.endsAt) {
          const next = { ...p, phase: "sending" as const };
          patchPending(p.sendId, { phase: "sending" });
          void watch(next);
        }
      }
    }, 200);
    return () => clearInterval(id);
  }, [anyWindow, watch, patchPending]);

  const undoOnce = useCallback(
    async (p: Pending) => {
      try {
        settle(p, await undoMailSend(p.accountId, p.sendId));
      } catch (e) {
        const code = errorCode(e);
        if (code !== "not_pending" && code !== "owned_elsewhere" && code !== "not_found") {
          notify({ tone: "danger", text: errText(code), autoCloseMs: 8000 });
          return;
        }
        // The server said it is not (or no longer) undoable. Ask what actually happened before saying anything:
        // after a restart the window is simply gone, which is not the same as "already being sent".
        try {
          const st = await fetchMailSendStatus(p.accountId, p.sendId);
          if (st.ownedElsewhere && st.state === "pending") {
            // Another Mail window of the app holds this send; only it can undo.
            notify({ tone: "warning", text: t("mail.compose.ownedElsewhere"), autoCloseMs: 8000 });
          } else if (st.state === "sending" || st.state === "pending") {
            notify({ tone: "warning", text: t("mail.compose.tooLate"), autoCloseMs: 6000 });
            patchPending(p.sendId, { phase: "sending" });
            void watch({ ...p, phase: "sending" });
          } else settle(p, st);
        } catch (e2) {
          notify({ tone: "danger", text: errText(errorCode(e2)), autoCloseMs: 8000 });
        }
      }
    },
    [errText, notify, patchPending, settle, t, watch]
  );

  const undoing = useRef(new Set<string>());
  const undo = useCallback(
    async (sendId: string) => {
      const p = pendingsRef.current.find((x) => x.sendId === sendId);
      if (!p || undoing.current.has(sendId)) return;
      undoing.current.add(sendId);
      try {
        await undoOnce(p);
      } finally {
        undoing.current.delete(sendId);
      }
    },
    [undoOnce]
  );

  // On opening Mail: anything the server still holds from before (in its window, finished, or ended without a send).
  useEffect(() => {
    let cancelled = false;
    void fetchMailOutbox()
      .then(({ sends }) => {
        if (cancelled || !alive.current) return;
        for (const st of sends) {
          const base: Pending = {
            accountId: st.accountId,
            sendId: st.sendId,
            subject: st.subject,
            endsAt: Date.now() + (st.remainingMs ?? 0),
            phase: st.state === "pending" ? "window" : "sending",
            unreachable: false,
            snapshot: null,
          };
          if (st.state === "pending" || st.state === "sending") {
            if (pendingsRef.current.some((x) => x.sendId === st.sendId)) continue;
            setPendings((list) => [...list, base]);
            if (base.phase === "sending") void watch(base);
          } else settle(base, st);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const api = useMemo<MailComposeApi>(
    () => ({
      startNew,
      startFrom: (mode, message) => void startFromServer(mode, message),
      editDraft: (message) => void startFromServer("draft", message),
      busy,
      canCompose: sendable.length > 0 && compose === null,
      isDraftsFolder: props.isDraftsFolder,
    }),
    [startNew, startFromServer, busy, sendable.length, props.isDraftsFolder, compose]
  );

  const layer = useMemo(
    () => ({
      compose,
      pendings,
      now,
      notices,
      accounts: sendable,
      actions: {
        change,
        showCc: () => patchCompose((c) => ({ ...c, showCc: true })),
        minimize: (v: boolean) => patchCompose((c) => ({ ...c, minimized: v })),
        attach,
        removeAttachment,
        send: () => void send(),
        close: () => void closeCurrent(),
        discard,
        undo: (sendId: string) => void undo(sendId),
        closeNotice,
      },
    }),
    [compose, pendings, now, notices, sendable, change, patchCompose, attach, removeAttachment, send, closeCurrent, discard, undo, closeNotice]
  );

  return (
    <Ctx.Provider value={api}>
      <LayerCtx.Provider value={layer}>{props.children}</LayerCtx.Provider>
    </Ctx.Provider>
  );
}

/** The floating composer, the undo countdowns and the notices. Mount once inside the Mail page's root. */
export function MailComposeLayer() {
  const { t } = useTranslation();
  const layer = useContext(LayerCtx);
  if (!layer) return null;
  const { compose, pendings, now, notices, actions, accounts } = layer;
  return (
    <>
      {compose && (
        <ComposeWindow
          state={compose}
          accounts={accounts}
          onChange={actions.change}
          onShowCc={actions.showCc}
          onMinimize={actions.minimize}
          onAttach={actions.attach}
          onRemoveAttachment={actions.removeAttachment}
          onSend={actions.send}
          onClose={actions.close}
          onDiscard={actions.discard}
        />
      )}
      {(pendings.length > 0 || notices.length > 0) && (
        <div className="mc-toasts" data-ui="mail-toasts">
          {pendings.map((p) => {
            const seconds = Math.max(0, Math.ceil((p.endsAt - now) / 1000));
            return (
              <div
                key={p.sendId}
                className="mc-toast"
                data-ui="mail-send-undo"
                data-ui-key={p.sendId}
                data-phase={p.phase}
                role="status"
              >
                <Icon
                  name={p.phase === "window" ? "send" : "loader-circle"}
                  cls={p.phase === "window" ? "ico-sm" : "ico-sm mail-spin"}
                />
                <span>
                  {p.phase === "window"
                    ? t("mail.compose.sending", { n: seconds })
                    : p.unreachable
                      ? t("mail.compose.reconnecting")
                      : t("mail.compose.sendingNow")}
                </span>
                <span className="mc-toast-meta">{p.subject || t("mail.noSubject")}</span>
                {p.phase === "window" && (
                  <Button
                    data-ui="mail-send-undo-action"
                    data-ui-key={p.sendId}
                    onClick={() => actions.undo(p.sendId)}
                  >
                    {t("mail.compose.undo")}
                  </Button>
                )}
              </div>
            );
          })}
          {notices.map((n) => (
            <div
              key={n.id}
              className={`mc-toast ${n.tone}`}
              data-ui="mail-notice"
              data-tone={n.tone}
              role={n.tone === "info" ? "status" : "alert"}
            >
              <Icon name={n.tone === "info" ? "check" : "triangle-alert"} cls="ico-sm" />
              <span>{n.text}</span>
              {n.action && (
                <Button data-ui="mail-notice-action" onClick={() => n.action?.run(n.id)}>
                  {n.action.label}
                </Button>
              )}
              <IconButton
                unstyled
                className="btn icon ghost"
                data-ui="mail-notice-close"
                icon={<Icon name="x" cls="ico-sm" />}
                label={t("mail.compose.dismiss")}
                onClick={() => actions.closeNotice(n.id)}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** "Write" button of the folder pane. */
export function ComposeButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const api = useMailCompose();
  if (!api) return null;
  return compact ? (
    <IconButton
      unstyled
      className="btn icon ghost"
      data-ui="mail-compose-compact"
      disabled={!api.canCompose}
      icon={<Icon name="square-pen" cls="ico-sm" />}
      label={t("mail.compose.write")}
      onClick={api.startNew}
    />
  ) : (
    <div className="mc-write-row">
      <Button appearance="primary" data-ui="mail-compose" disabled={!api.canCompose} onClick={api.startNew}>
        <Icon name="square-pen" cls="ico-sm" />
        {t("mail.compose.write")}
      </Button>
    </div>
  );
}

/** Reply / reply all / forward (or, in Drafts, edit) for the open message. One mount point in the reader. */
export function MailComposeActions({ message }: { message: MailMessage }) {
  const { t } = useTranslation();
  const api = useMailCompose();
  if (!api) return null;
  const inDrafts = api.isDraftsFolder(message.accountId, message.folder);
  const disabled = api.busy || !api.canCompose;
  return (
    <div className="mc-actions" data-ui="mail-compose-actions" role="group" aria-label={t("mail.compose.actions")}>
      {inDrafts ? (
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-edit-draft"
          disabled={disabled}
          icon={<Icon name="square-pen" cls="ico-sm" />}
          label={t("mail.compose.editDraft")}
          onClick={() => api.editDraft(message)}
        />
      ) : (
        <>
          <IconButton unstyled className="btn icon ghost" data-ui="mail-reply" disabled={disabled} icon={<Icon name="reply" cls="ico-sm" />} label={t("mail.compose.reply")} onClick={() => api.startFrom("reply", message)} />
          <IconButton unstyled className="btn icon ghost" data-ui="mail-reply-all" disabled={disabled} icon={<Icon name="reply-all" cls="ico-sm" />} label={t("mail.compose.replyAll")} onClick={() => api.startFrom("replyAll", message)} />
          <IconButton unstyled className="btn icon ghost" data-ui="mail-forward" disabled={disabled} icon={<Icon name="forward" cls="ico-sm" />} label={t("mail.compose.forward")} onClick={() => api.startFrom("forward", message)} />
        </>
      )}
    </div>
  );
}
