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
  type MailStagedAttachment,
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
import { MailApiError, mailErrorCode } from "../api/mail";
import {
  discardMailDraft,
  dismissMailSend,
  fetchMailOutbox,
  fetchMailSendStatus,
  initMailCompose,
  removeMailAttachment,
  saveMailDraft,
  startMailSend,
  uploadMailAttachment,
} from "../api/mail-compose";
import { Icon } from "../lib/icons";
import { ActionButton, Button, Dialog, IconButton } from "../ui";
import { type ComposeState, ComposeWindow } from "./ComposeWindow";
import {
  browserSendTrackerDeps,
  createSendTracker,
  MAIL_PAGE_SEND_POLICY,
  type SendTracker,
  type SendView,
} from "./send-tracker";
import "./compose.css";

const SAVE_DELAY_MS = 1200;
/**
 * Composer text that could not reach the server after the user left Mail (a draft that could not be
 * saved, a send that failed or lost its answer meanwhile). It is kept in this tab's sessionStorage and
 * offered ("Open") the next time Mail opens, instead of being lost. Only this browser tab sees it.
 */
const LEFT_KEY = "argelander.mail.leftBehind";

export interface LeftBehind {
  /** The composer it came from: a later record of the same window replaces an earlier one. */
  uid: string;
  /**
   * unsaved / notSent / notSentSaved / unknown: composer text that is kept here. attachment: a file that
   * finished uploading after the user left and was not added (no text kept). sentEdits: edits made to a
   * message that had already gone out (offered as a copy with a new Message-ID).
   */
  kind: "unsaved" | "notSent" | "notSentSaved" | "unknown" | "attachment" | "sentEdits";
  subject: string;
  code: string | null;
  /** The attachment of an `attachment` record. */
  name?: string;
  /** Version of this record: "Open" lets go only of the version it took over, never a newer one. */
  rev?: string;
  state: ComposeState;
}

/**
 * A record stays in the tab's storage until the user has it back in a composer ("Open") or explicitly
 * drops it; showing it is not enough (the user may leave again, or reload). The mounted Mail page is
 * told about new records and about records a later save made obsolete.
 */
let live: { show: (e: LeftBehind) => void; retract: (uid: string, rev?: string) => void } | null = null;

function readLeft(): LeftBehind[] {
  try {
    const raw = sessionStorage.getItem(LEFT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as LeftBehind[]) : [];
  } catch {
    return [];
  }
}
function writeLeft(list: LeftBehind[]): void {
  try {
    if (list.length === 0) sessionStorage.removeItem(LEFT_KEY);
    else sessionStorage.setItem(LEFT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable or full: nothing more can be kept */
  }
}
function recordLeft(entry: LeftBehind): void {
  const e = { ...entry, rev: uuid() };
  writeLeft([...readLeft().filter((x) => x.uid !== e.uid), e]);
  live?.show(e);
}
function findLeft(uid: string): LeftBehind | null {
  return readLeft().find((x) => x.uid === uid) ?? null;
}
/**
 * The record is no longer needed: back in a composer, dropped by the user, or made obsolete. With `rev`,
 * only that version goes; a newer one (say, a late attachment joined it meanwhile) stays and is offered.
 */
function clearLeft(uid: string, rev?: string): void {
  const list = readLeft();
  const gone = (x: LeftBehind) => x.uid === uid && (rev === undefined || x.rev === rev);
  if (list.some(gone)) writeLeft(list.filter((x) => !gone(x)));
  live?.retract(uid, rev);
}

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
/** Remove one occurrence (two uploads may share a file name). */
const dropOne = (list: string[], name: string) => {
  const i = list.indexOf(name);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
};

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
  /** The tab-kept record this notice offers. */
  left?: { uid: string; rev?: string; holdsText: boolean };
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
    closeNotice: (id: number, confirmed?: boolean) => void;
    copyNew: () => void;
    cancelDrop: () => void;
    dropLeft: (uid: string) => void;
  };
  confirmDrop: string | null;
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

const newMessageId = (address: string | undefined) =>
  `<${uuid()}@${(address?.split("@")[1] ?? "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost"}>`;

/**
 * The text of a message that already went out, as a new message (new Message-ID): the only way to
 * send or keep edits made after it was sent. Attachments come along only when they were staged afresh
 * from the Drafts copy (`restaged`); after a send the server deleted the staged files, so they are left
 * out and the window says they have to be added again.
 */
function copyAsNew(c: ComposeState, address: string | undefined): ComposeState {
  const keep = c.sent?.restaged === true;
  const dropped = keep ? [] : c.attachments.map((a) => a.filename);
  return {
    ...c,
    uid: uuid(),
    draft: {
      ...c.draft,
      messageId: newMessageId(address),
      attachments: keep ? c.draft.attachments : [],
    },
    attachments: keep ? c.attachments : [],
    savedDraft: null,
    savedOn: null,
    save: "idle",
    savedAt: null,
    saveCode: null,
    touched: true,
    sent: null,
    unconfirmed: null,
    error: dropped.length > 0 ? "attachments_readd" : null,
    errorName: dropped.length > 0 ? dropped.join(", ") : null,
    sending: false,
    uploading: [],
    minimized: false,
  };
}

function emptyDraft(account: MailAccount): MailComposeDraft {
  return {
    messageId: newMessageId(account.address),
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
  const noticesRef = useRef<Notice[]>([]);
  noticesRef.current = notices;
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
  /** Follows each send from its window to its end (see send-tracker); created and disposed with the page. */
  const tracker = useRef<SendTracker | null>(null);
  /** What this page knows about each followed send that the server does not: its subject and the composer text. */
  const sendMeta = useRef(new Map<string, { subject: string; snapshot: ComposeState | null }>());

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

  const notify = useCallback((n: Omit<Notice, "id">): number => {
    const id = noticeSeq.current++;
    setNotices((list) => [
      ...list.filter(
        (x) =>
          !(n.forget && x.forget?.sendId === n.forget.sendId) && !(n.left && x.left?.uid === n.left.uid)
      ),
      { ...n, id },
    ]);
    if (n.autoCloseMs)
      setTimeout(() => {
        if (alive.current) setNotices((list) => list.filter((x) => x.id !== id));
      }, n.autoCloseMs);
    return id;
  }, []);
  /** Remove a notice without any side effect (its action was taken). */
  const dropNotice = useCallback((id: number) => {
    setNotices((list) => list.filter((x) => x.id !== id));
  }, []);
  /** A notice holding kept text asks before it goes: closing it drops the text for good. */
  /** The kept record (by uid, not by notice: the notice may be replaced by a newer version meanwhile). */
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const closeNotice = useCallback((id: number, confirmed = false) => {
    const gone = noticesRef.current.find((x) => x.id === id);
    if (!gone) return;
    if (gone.left?.holdsText && !confirmed) {
      setConfirmDrop(gone.left.uid);
      return;
    }
    if (gone.forget) void dismissMailSend(gone.forget.accountId, gone.forget.sendId).catch(() => {});
    if (gone.left) clearLeft(gone.left.uid);
    setConfirmDrop(null);
    setNotices((list) => list.filter((x) => x.id !== id));
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
    // A message that already went out is never saved again (the server refuses it as well).
    if (!c || !c.touched || c.sending || c.sent) return;
    s.inflight = true;
    // The answer belongs to this window only: by then another one may be open.
    const patchMine = (f: (x: ComposeState) => ComposeState) => {
      if (alive.current && composeRef.current?.uid === c.uid) patchCompose(f);
    };
    patchMine((x) => ({ ...x, save: "saving" }));
    try {
      const staleOn = c.savedOn && c.savedOn !== c.accountId ? c.savedOn : null;
      if (staleOn) {
        // The sender changed: the copy in the old account's Drafts has to go. Without the attachments:
        // they are staged independent of the account and move with the draft.
        await discardMailDraft(staleOn, { ...c.draft, attachments: [] }).catch(() => {});
      }
      await saveMailDraft(c.accountId, c.draft);
      patchMine((x) => ({
        ...x,
        save: "saved",
        saveCode: null,
        savedAt: clock(),
        savedOn: c.accountId,
        // Only what was sent counts as saved: an edit made meanwhile stays "unsaved".
        savedDraft: c.draft,
      }));
    } catch (e) {
      const code = mailErrorCode(e);
      if (code === "already_sent")
        // Not a failure to retry: this message went out (from another window, tab or an earlier send).
        patchMine((x) => ({ ...x, save: "idle", saveCode: null, sent: x.sent ?? { sentCopy: null } }));
      else patchMine((x) => ({ ...x, save: "failed", saveCode: code }));
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

  /**
   * Windows that were open when the user left Mail with text the server did not have, or with an upload
   * still running: the text is saved now and an upload that finishes later is added to the same draft.
   * What cannot be saved is kept in the tab (see LEFT_KEY) and offered on the next visit.
   */
  const detached = useRef(new Map<string, { state: ComposeState; chain: Promise<void> }>());
  /** Windows the user discarded: an upload of theirs that finishes later is removed again. */
  const discarded = useRef(new Set<string>());
  /** Windows whose discard request is running: leaving Mail meanwhile must not save them back. */
  const discarding = useRef(new Set<string>());

  const saveDetached = useCallback((uid: string) => {
    const d = detached.current.get(uid);
    if (!d) return;
    const st = d.state;
    // Chained, so that a late upload of this window (see orphanUpload) is decided after this save.
    d.chain = d.chain.then(async () => {
      try {
        await saveMailDraft(st.accountId, st.draft);
      } catch (e) {
        recordLeft({ uid, kind: "unsaved", subject: st.draft.subject, code: mailErrorCode(e), state: st });
      }
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const s = saver.current;
      const c = composeRef.current;
      if (s.timer) clearTimeout(s.timer);
      // A window that is sending is taken care of by its send, which learns how it ended (see `send`);
      // one being discarded is going away on purpose.
      if (!c || c.sending || discarding.current.has(c.uid)) return;
      if (c.sent) {
        // It went out already: nothing can be saved. Edits made since are kept once, as a copy to offer.
        if (c.touched && c.draft !== c.savedDraft)
          recordLeft({ uid: c.uid, kind: "sentEdits", subject: c.draft.subject, code: null, state: c });
        if (c.uploading.length > 0) detached.current.set(c.uid, { state: c, chain: Promise.resolve() });
        return;
      }
      if (isUnsaved(c) || c.uploading.length > 0) {
        detached.current.set(c.uid, { state: c, chain: Promise.resolve() });
        if (isUnsaved(c)) saveDetached(c.uid);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- opening the composer ------------------------------------------------------------
  const open = useCallback(
    (state: ComposeState) => {
      if (saver.current.timer) clearTimeout(saver.current.timer);
      setCompose(state);
      // Text the server does not have (kept in the tab, a copy as new message) goes to Drafts soon.
      if (isUnsaved(state) && !state.sent) scheduleSave();
    },
    [setCompose, scheduleSave]
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
    unconfirmed: null,
    sent: null,
  });

  /** Offer a composer in a notice ("Open"); opening it first saves (and closes) the window that is open. */
  const closeCurrentRef = useRef<() => Promise<boolean>>(async () => true);
  const offer = useCallback(
    (state: ComposeState, text: string, tone: Notice["tone"], left?: Notice["left"]) => {
      notify({
        tone,
        text,
        ...(left ? { left } : {}),
        action: {
          label: t("mail.compose.openIt"),
          run: (id) => {
            // The open composer is saved to the server first; if that fails (or it is sending) it stays.
            void closeCurrentRef.current().then((closed) => {
              if (!closed) return;
              open(state);
              dropNotice(id);
              // Only now, with the text in a composer again, is the tab-kept copy let go.
              if (left) clearLeft(left.uid, left.rev);
            });
          },
        },
      });
    },
    [dropNotice, notify, open, t]
  );
  /** Show a composer, but never over a window that is open: then it is offered in a notice (with "Open"). */
  const present = useCallback(
    (state: ComposeState, text: string, tone: Notice["tone"]) => {
      if (!composeRef.current) open(state);
      else offer(state, text, tone);
    },
    [open, offer]
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
        // A copy a sent message left in Drafts: it can be read, copied as new or discarded, not sent again.
        st.sent = r.sent ? { ...r.sent, restaged: true } : null;
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
            text: `${t("mail.compose.initFailed")} ${errText(mailErrorCode(e))}`,
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
      const cur = composeRef.current;
      if (cur?.sending) return; // a send in flight owns the text
      // While an earlier send's answer is unknown the sender is fixed: the claim and the sent guard are per
      // account, so the same draft from another account could go out a second time.
      const sender = cur?.unconfirmed ? undefined : accountId;
      if (accountId !== undefined && sender === undefined && Object.keys(fields).length === 0) return;
      patchCompose((c) => ({
        ...c,
        accountId: sender ?? c.accountId,
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

  /** An upload whose window is not the open one any more. It is never attached to another window. */
  const orphanUpload = useCallback(
    (uid: string, accountId: string, name: string, staged: MailStagedAttachment | null, code: string | null) => {
      const d = detached.current.get(uid);
      if (d) {
        // The user left Mail meanwhile. The draft on the server may have been edited since (back in Mail,
        // another tab), and there is no version check: writing the old snapshot plus the file could replace
        // newer text. So nothing is written to the server here.
        d.chain = d.chain.then(() => {
          const kept = findLeft(uid);
          if (staged && kept && kept.kind === "unsaved") {
            // The text exists only in this tab anyway (its save failed): the file joins that record.
            const st = kept.state;
            recordLeft({
              ...kept,
              state: {
                ...st,
                attachments: [...st.attachments, staged],
                draft: { ...st.draft, attachments: [...st.draft.attachments, staged.id] },
              },
            });
            return;
          }
          if (staged) void removeMailAttachment(accountId, staged.id).catch(() => {});
          // Say plainly that the file is not in the draft (no text is kept in this record).
          recordLeft({
            uid: `${uid}:${uuid()}`,
            kind: "attachment",
            subject: d.state.draft.subject,
            code,
            name,
            state: { ...d.state, draft: { ...d.state.draft, text: "" }, attachments: [] },
          });
        });
        return;
      }
      if (!staged) return; // nothing was staged, nothing is lost
      void removeMailAttachment(accountId, staged.id).catch(() => {});
      // Discarded: the user threw that message away. Otherwise say plainly that the file was not added.
      if (!discarded.current.has(uid) && alive.current)
        notify({ tone: "warning", text: t("mail.compose.attachmentDropped", { name }) });
    },
    [notify, t]
  );

  const attach = useCallback(
    (files: File[]) => {
      const c = composeRef.current;
      if (!c || c.sending) return;
      const { accountId, uid } = c;
      // Every answer goes to the window that started the upload (by uid), never to "the open window".
      const mine = () => alive.current && composeRef.current?.uid === uid;
      for (const file of files) {
        const have = composeRef.current?.attachments.reduce((n, a) => n + a.size, 0) ?? 0;
        if (file.size > MAIL_ATTACHMENT_MAX_BYTES || have + file.size > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
          patchCompose((x) => ({ ...x, error: "attachment_too_large", errorName: file.name }));
          continue;
        }
        patchCompose((x) => ({ ...x, uploading: [...x.uploading, file.name], error: null, errorName: null }));
        void uploadMailAttachment(accountId, file)
          .then((staged) => {
            if (!mine()) return orphanUpload(uid, accountId, file.name, staged, null);
            patchCompose((x) => {
              const uploading = dropOne(x.uploading, file.name);
              return {
                ...x,
                uploading,
                attachments: [...x.attachments, staged],
                draft: { ...x.draft, attachments: [...x.draft.attachments, staged.id] },
                touched: true,
                // "Still uploading" is answered once the last one is in.
                error: x.error === "uploading" && uploading.length === 0 ? null : x.error,
              };
            });
            scheduleSave();
          })
          .catch((e) => {
            if (!mine()) return orphanUpload(uid, accountId, file.name, null, mailErrorCode(e));
            patchCompose((x) => ({
              ...x,
              uploading: dropOne(x.uploading, file.name),
              error: mailErrorCode(e),
              errorName: file.name,
            }));
          });
      }
    },
    [orphanUpload, patchCompose, scheduleSave]
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
    if (c.uploading.length > 0) {
      // Closing now would drop the file or (worse) let it land elsewhere: say so and stay.
      patchCompose((x) => ({ ...x, error: "uploading", errorName: null }));
      return false;
    }
    const s = saver.current;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (c.sent) {
      // Already sent: there is nothing to save, so closing is free. Edits made since are kept in the tab
      // (not only in a notice), so leaving Mail or reloading does not lose them either.
      if (alive.current) setCompose(null);
      if (c.touched && c.draft !== c.savedDraft)
        recordLeft({ uid: c.uid, kind: "sentEdits", subject: c.draft.subject, code: null, state: c });
      return true;
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
    if (!last || last.uid !== c.uid || last.sending || last.uploading.length > 0 || isUnsaved(last))
      return false;
    if (alive.current) setCompose(null);
    if (c.savedOn) propsRef.current.onChanged();
    return true;
  }, [patchCompose, runSave, setCompose]);

  closeCurrentRef.current = closeCurrent;

  /** Returns the failure code (the dialog shows it and stays open) or null when the draft is gone. */
  const discard = useCallback(async (): Promise<string | null> => {
    const first = composeRef.current;
    if (!first) return null;
    const s = saver.current;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    // From here on the user is throwing this window away: leaving Mail meanwhile must not save it back.
    discarding.current.add(first.uid);
    let c: ComposeState | null;
    try {
      // A save on its way may be about to create the server copy: wait for it, then decide.
      while (s.inflight) await sleep(50);
      c = composeRef.current;
      if (!c || c.uid !== first.uid) return null;
      // Where a copy may be: the confirmed one, or one a save may have made although its answer was lost.
      const on = c.savedOn ?? (c.save === "failed" && c.saveCode === "unreachable" ? c.accountId : null);
      if (on) {
        try {
          await discardMailDraft(on, c.draft);
        } catch (e) {
          return mailErrorCode(e);
        }
        propsRef.current.onChanged();
      }
    } finally {
      discarding.current.delete(first.uid);
    }
    if (!c.savedOn && !(c.save === "failed" && c.saveCode === "unreachable")) {
      for (const a of c.attachments) void removeMailAttachment(c.accountId, a.id).catch(() => {});
    }
    // An upload still running for this window is removed when it finishes.
    discarded.current.add(c.uid);
    if (composeRef.current?.uid === c.uid) setCompose(null);
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
        unconfirmed: null,
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

  /** Sends already reported: the countdown, an undo answer and a status check may all end the same one. */
  const settled = useRef(new Set<string>());
  const settle = useCallback(
    (p: Pending, st: MailSendStatus) => {
      if (settled.current.has(p.sendId)) return;
      settled.current.add(p.sendId);
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
      } else if (st.state === "failed" && st.code !== "outcome_unknown") {
        // Definitely not sent: the text comes back. A failure whose outcome cannot be known is reported below.
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
        // unknown, or failed with outcome_unknown: it may or may not have gone out. Never "not sent".
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

  /** The server no longer knows the send, or it could not be learned in time how it ended. */
  const lost = useCallback(
    (p: Pending) => {
      setPendings((list) => list.filter((x) => x.sendId !== p.sendId));
      notify({
        tone: "warning",
        text: t("mail.compose.statusLost", { subject: p.subject || t("mail.noSubject") }),
        action: { label: t("mail.compose.openDrafts"), run: () => propsRef.current.onOpenDrafts(p.accountId) },
      });
    },
    [notify, setPendings, t]
  );

  /**
   * The tracker's views become the countdown bars; a send that ended is reported here (what to say and whether the
   * text comes back stays this page's business) and is no longer followed.
   */
  const onSends = useCallback(
    (views: SendView[]) => {
      const shown: Pending[] = [];
      const ended: Array<{ p: Pending; status: MailSendStatus | null }> = [];
      for (const v of views) {
        const m = sendMeta.current.get(v.sendId);
        const p: Pending = {
          accountId: v.accountId,
          sendId: v.sendId,
          subject: m?.subject ?? v.status?.subject ?? "",
          endsAt: v.endsAt ?? 0,
          phase: v.phase === "window" ? "window" : "sending",
          unreachable: v.unreachable,
          snapshot: m?.snapshot ?? null,
        };
        if (v.phase === "window" || v.phase === "sending") shown.push(p);
        else ended.push({ p, status: v.phase === "settled" ? v.status : null });
      }
      setPendings(() => shown);
      for (const { p, status } of ended) {
        tracker.current?.untrack(p.sendId);
        sendMeta.current.delete(p.sendId);
        if (status) settle(p, status);
        else lost(p);
      }
    },
    [lost, setPendings, settle]
  );
  const onSendsRef = useRef(onSends);
  onSendsRef.current = onSends;
  useEffect(() => {
    const tr = createSendTracker(browserSendTrackerDeps, MAIL_PAGE_SEND_POLICY);
    tracker.current = tr;
    const off = tr.subscribe((views) => onSendsRef.current(views));
    return () => {
      off();
      tr.dispose();
      if (tracker.current === tr) tracker.current = null;
      sendMeta.current.clear();
    };
  }, []);

  /** The server accepted a send of this window: it closes into a countdown (or the "sending" bar). */
  const accepted = useCallback(
    (c: ComposeState, st: MailSendStatus) => {
      // The snapshot is this composer's (by uid); a different window is never closed or rewritten here.
      const mine = composeRef.current?.uid === c.uid ? composeRef.current : null;
      const snapshot: ComposeState = { ...(mine ?? c), sending: false, unconfirmed: null, error: null, errorName: null };
      if (mine) setCompose(null);
      sendMeta.current.set(st.sendId, { subject: st.subject || c.draft.subject, snapshot });
      setNow(Date.now());
      tracker.current?.track(st.accountId || c.accountId, st.sendId, st);
    },
    [setCompose]
  );

  /**
   * The user left Mail while this window's send was on its way, and the send did not open a window.
   * Its text must not vanish: save it to Drafts if possible, and keep it in the tab either way.
   */
  const leftAfterSend = useCallback(
    async (c: ComposeState, code: string, unconfirmed: ComposeState["unconfirmed"]) => {
      const base: ComposeState = { ...c, sending: false, uploading: [], error: code, errorName: null, unconfirmed };
      // Without an answer it may still be under way: never claim "not sent" then.
      const unknown = code === "unreachable";
      try {
        await saveMailDraft(c.accountId, c.draft);
        recordLeft({
          uid: c.uid,
          kind: unknown ? "unknown" : "notSentSaved",
          subject: c.draft.subject,
          code,
          state: { ...base, save: "saved", savedAt: null, savedOn: c.accountId, savedDraft: c.draft },
        });
      } catch (e) {
        // A draft the server refuses to save because a send of it is running (or went out) is not "not sent".
        const held = ["already_pending", "already_sent"].includes(mailErrorCode(e));
        recordLeft({
          uid: c.uid,
          kind: unknown || held ? "unknown" : "notSent",
          subject: c.draft.subject,
          code,
          state: base,
        });
      }
    },
    []
  );

  const send = useCallback(async () => {
    const c = composeRef.current;
    if (!c || c.sending || c.sent) return;
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
    const mineOnly = (f: (x: ComposeState) => ComposeState) => {
      if (composeRef.current?.uid === c.uid) patchCompose(f);
    };
    const sig = `${c.accountId}\u0000${JSON.stringify(c.draft)}`;
    let unconfirmed = c.unconfirmed;
    if (unconfirmed) {
      // An earlier send of this window never got an answer. Ask what became of it before sending again:
      // it may be in its window right now, and a second send id would send the message twice.
      let earlier: MailSendStatus | null = null;
      try {
        earlier = await fetchMailSendStatus(unconfirmed.accountId, unconfirmed.sendId);
      } catch (e) {
        const notThere = e instanceof MailApiError && e.status === 404;
        if (!notThere) {
          if (!alive.current) return void leftAfterSend(c, "unreachable", unconfirmed);
          // Still unknown: do not send. The window keeps its text and the reason.
          mineOnly((x) => ({ ...x, sending: false, error: mailErrorCode(e), errorName: null }));
          return;
        }
      }
      if (!alive.current) return void leftAfterSend(c, "unreachable", unconfirmed);
      if (earlier) {
        const subject = earlier.subject || c.draft.subject || t("mail.noSubject");
        if (earlier.state === "pending" || earlier.state === "sending") {
          // It did arrive: this click joins it. Edits made since then are not in it (undo brings them back).
          if (unconfirmed.sig !== sig) notify({ tone: "warning", text: t("mail.compose.earlierAccepted", { subject }) });
          accepted(c, earlier);
          return;
        }
        if (earlier.state === "sent" || earlier.state === "unknown") {
          settle(
            { accountId: earlier.accountId, sendId: earlier.sendId, subject, endsAt: 0, phase: "sending", unreachable: false, snapshot: null },
            earlier
          );
          mineOnly((x) => ({
            ...x,
            sending: false,
            unconfirmed: null,
            ...(earlier.state === "sent"
              ? { sent: { sentCopy: earlier.sentCopy }, error: null }
              : { error: "outcome_unknown" }),
            errorName: null,
          }));
          return;
        }
        // Failed, undone or interrupted: it did not go out, so this click may send.
        void dismissMailSend(earlier.accountId, earlier.sendId).catch(() => {});
        unconfirmed = null;
      }
      // 404: the server has no such send (yet). If the old request is still being prepared it holds the
      // draft's claim, so a new send id is refused rather than sent; the binding stays until resolved.
    }
    // The same content retried is the same send id (the server joins it), never a second send.
    const sendId =
      unconfirmed && unconfirmed.sig === sig && unconfirmed.accountId === c.accountId ? unconfirmed.sendId : uuid();
    try {
      const st = await startMailSend(c.accountId, sendId, c.draft);
      // Gone from Mail meanwhile: the server holds the send and reports it when Mail opens again.
      if (!alive.current) return;
      accepted(c, { ...st, sendId: st.sendId || sendId });
    } catch (e) {
      const code = mailErrorCode(e);
      // No answer at all: the request may have reached the server. Bind its id to this window.
      const next =
        code === "unreachable"
          ? { accountId: c.accountId, sendId, sig }
          : unconfirmed && unconfirmed.sendId !== sendId
            ? unconfirmed
            : null;
      if (!alive.current) return void leftAfterSend(c, code, next);
      if (composeRef.current?.uid === c.uid) {
        patchCompose((x) => ({
          ...x,
          sending: false,
          errorName: null,
          unconfirmed: next,
          // The server says this Message-ID went out: the window turns into its "already sent" state.
          ...(code === "already_sent" ? { sent: x.sent ?? { sentCopy: null }, error: null } : { error: code }),
        }));
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
            unconfirmed: next,
          },
          t("mail.compose.restoreFailed", {
            subject: c.draft.subject || t("mail.noSubject"),
            reason: errText(code),
          }),
          "danger"
        );
      }
    }
  }, [accepted, leftAfterSend, notify, patchCompose, present, errText, settle, t]);

  // One ticker for all countdowns (display only: the tracker ends each window and starts asking the server).
  const anyWindow = pendings.some((p) => p.phase === "window");
  useEffect(() => {
    if (!anyWindow) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [anyWindow]);

  const undoing = useRef(new Set<string>());
  const undo = useCallback(
    async (sendId: string) => {
      const p = pendingsRef.current.find((x) => x.sendId === sendId);
      const tr = tracker.current;
      if (!p || !tr || undoing.current.has(sendId)) return;
      undoing.current.add(sendId);
      try {
        // A send that ended (undone, or found to have ended otherwise) is reported through the tracker's views.
        const r = await tr.undo(sendId);
        if (!alive.current) return;
        if (r === "ownedElsewhere")
          // Another Mail window of the app holds this send; only it can undo.
          notify({ tone: "warning", text: t("mail.compose.ownedElsewhere"), autoCloseMs: 8000 });
        else if (r === "tooLate") notify({ tone: "warning", text: t("mail.compose.tooLate"), autoCloseMs: 6000 });
        else if (typeof r === "object") notify({ tone: "danger", text: errText(r.error), autoCloseMs: 8000 });
      } finally {
        undoing.current.delete(sendId);
      }
    },
    [errText, notify, t]
  );

  // On opening Mail: anything the server still holds from before (in its window, finished, or ended without a send).
  useEffect(() => {
    let cancelled = false;
    void fetchMailOutbox()
      .then(({ sends }) => {
        if (cancelled || !alive.current) return;
        for (const st of sends) {
          // A send the Copilot started has its own card and undo bar; it is not this page's to restore,
          // report or acknowledge (acknowledging deletes the record the Copilot reads its result from).
          if (st.origin === "copilot") continue;
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
            if (sendMeta.current.has(st.sendId)) continue;
            sendMeta.current.set(st.sendId, { subject: st.subject, snapshot: null });
            tracker.current?.track(st.accountId, st.sendId, st);
          } else settle(base, st);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Records kept in this tab after leaving Mail (a draft that could not be saved, a send that did not get
  // through, a late attachment): say what happened and offer the text back. Never opened over the page.
  const showLeft = useCallback(
    (e: LeftBehind) => {
      const subject = e.subject || t("mail.noSubject");
      const reason = e.code ? errText(e.code) : "";
      if (e.kind === "attachment") {
        // No text is kept: the draft text is on the server; only the file has to be added again.
        notify({
          tone: "warning",
          text: e.code
            ? t("mail.compose.leftAttachmentFailed", { subject, name: e.name ?? "", reason })
            : t("mail.compose.leftAttachment", { subject, name: e.name ?? "" }),
          left: { uid: e.uid, rev: e.rev, holdsText: false },
          action: {
            label: t("mail.compose.openDrafts"),
            run: () => propsRef.current.onOpenDrafts(e.state.accountId),
          },
        });
        return;
      }
      if (e.kind === "sentEdits") {
        const address = propsRef.current.accounts.find((a) => a.id === e.state.accountId)?.address;
        offer(copyAsNew(e.state, address), t("mail.compose.leftSentEdits", { subject }), "warning", {
          uid: e.uid,
          rev: e.rev,
          holdsText: true,
        });
        return;
      }
      const text =
        e.kind === "notSentSaved"
          ? t("mail.compose.leftNotSentSaved", { subject, reason })
          : e.kind === "notSent"
            ? t("mail.compose.leftNotSent", { subject, reason })
            : e.kind === "unknown"
              ? t("mail.compose.leftUnknown", { subject })
              : t("mail.compose.leftUnsaved", { subject });
      const saved = e.kind === "notSentSaved";
      const state: ComposeState = {
        ...e.state,
        uid: uuid(),
        sending: false,
        uploading: [],
        minimized: false,
        touched: true,
        save: saved ? "saved" : "idle",
        savedDraft: saved ? e.state.draft : null,
      };
      offer(state, text, e.kind === "unsaved" || e.kind === "unknown" ? "warning" : "danger", {
        uid: e.uid,
        rev: e.rev,
        holdsText: true,
      });
    },
    [errText, notify, offer, t]
  );
  useEffect(() => {
    const me = {
      show: (e: LeftBehind) => showLeft(e),
      retract: (uid: string, rev?: string) =>
        setNotices((list) =>
          list.filter((x) => !(x.left?.uid === uid && (rev === undefined || x.left.rev === rev)))
        ),
    };
    live = me;
    // Shown, not taken: the records stay until opened or explicitly dropped.
    for (const e of readLeft()) showLeft(e);
    return () => {
      if (live === me) live = null;
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
        copyNew: () => {
          const c = composeRef.current;
          if (!c?.sent) return;
          const address = propsRef.current.accounts.find((a) => a.id === c.accountId)?.address;
          open(copyAsNew(c, address));
        },
        cancelDrop: () => setConfirmDrop(null),
        // Confirmed: every version of that record goes, whichever notice now shows it.
        dropLeft: (uid: string) => {
          setConfirmDrop(null);
          clearLeft(uid);
        },
      },
      confirmDrop,
    }),
    [compose, pendings, now, notices, sendable, change, patchCompose, attach, removeAttachment, send, closeCurrent, discard, undo, closeNotice, open, confirmDrop]
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
  const keepRef = useRef<HTMLButtonElement>(null);
  if (!layer) return null;
  const { compose, pendings, now, notices, actions, accounts, confirmDrop } = layer;
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
          onCopyNew={actions.copyNew}
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
              <ActionButton
                unstyled
                mode="icon"
                iconName="xmark"
                className="btn icon ghost"
                data-ui="mail-notice-close"
                label={t("mail.compose.dismiss")}
                tooltip={t("mail.compose.dismiss")}
                onClick={() => actions.closeNotice(n.id)}
              />
            </div>
          ))}
        </div>
      )}
      {confirmDrop !== null && (
        <Dialog
          title={t("mail.compose.leftDropTitle")}
          uiId="mail-left-drop-dialog"
          closeLabel={t("mail.compose.close")}
          onClose={actions.cancelDrop}
          initialFocusRef={keepRef as React.RefObject<HTMLElement>}
          footer={
            <>
              <Button ref={keepRef} onClick={actions.cancelDrop}>
                {t("mail.compose.cancel")}
              </Button>
              <Button
                appearance="primary"
                tone="danger"
                data-ui="mail-left-drop-confirm"
                onClick={() => actions.dropLeft(confirmDrop)}
              >
                {t("mail.compose.leftDropConfirm")}
              </Button>
            </>
          }
        >
          <p>{t("mail.compose.leftDropBody")}</p>
        </Dialog>
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
    <ActionButton
      unstyled
      mode="icon"
      iconName="square-pen"
      className="btn icon ghost"
      data-ui="mail-compose-compact"
      disabled={!api.canCompose}
      label={t("mail.compose.write")}
      tooltip={t("mail.compose.write")}
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
        <ActionButton
          unstyled
          mode="icon"
          iconName="mail-pencil"
          className="btn icon ghost"
          data-ui="mail-edit-draft"
          disabled={disabled}
          label={t("mail.compose.editDraft")}
          tooltip={t("mail.compose.editDraft")}
          onClick={() => api.editDraft(message)}
        />
      ) : (
        <>
          <ActionButton unstyled mode="icon" iconName="reply" className="btn icon ghost" data-ui="mail-reply" disabled={disabled} label={t("mail.compose.reply")} tooltip={t("mail.compose.reply")} onClick={() => api.startFrom("reply", message)} />
          <IconButton unstyled className="btn icon ghost" data-ui="mail-reply-all" disabled={disabled} icon={<Icon name="reply-all" cls="ico-sm" />} label={t("mail.compose.replyAll")} onClick={() => api.startFrom("replyAll", message)} />
          <ActionButton unstyled mode="icon" iconName="forward" className="btn icon ghost" data-ui="mail-forward" disabled={disabled} label={t("mail.compose.forward")} tooltip={t("mail.compose.forward")} onClick={() => api.startFrom("forward", message)} />
        </>
      )}
    </div>
  );
}
