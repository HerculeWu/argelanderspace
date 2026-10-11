/**
 * The Mail page's writing session (Mail ticket 07, Copilot ticket 41): the composer, its draft autosave, sending
 * with the 8 second undo, the reports of how each send ended, and the composer text kept in the tab after leaving
 * Mail. It is not React: `MailComposeProvider` creates one per mounted Mail page, starts it, subscribes and disposes
 * it on unmount. Time, ids, the tab storage, the server and the page are all reached through `deps`.
 *
 * The server owns every window (it sends at the deadline unless undone); the session only follows them (through the
 * send tracker), calls undo, and reports what the server says happened. Nothing here ever replaces text the user is
 * typing: a composer that has to come back while another one is open is offered in a notice instead.
 *
 * Notices are events (`kind` + `params`), worded by the page in the current language.
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
import { MailApiError, mailErrorCode } from "../api/mail";
import type * as composeApi from "../api/mail-compose";
import type { ComposeState } from "./ComposeWindow";
import type { SendTracker, SendView } from "./send-tracker";

export const SAVE_DELAY_MS = 1200;
/**
 * Composer text that could not reach the server after the user left Mail (a draft that could not be saved, a send
 * that failed or lost its answer meanwhile). It is kept in this tab's sessionStorage and offered ("Open") the next
 * time Mail opens, instead of being lost. Only this browser tab sees it.
 */
export const LEFT_KEY = "argelander.mail.leftBehind";

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

/** The session of this tab that shows kept records now (the mounted Mail page). */
export interface LeftViewer {
  show(e: LeftBehind): void;
  retract(uid: string, rev?: string): void;
}

/**
 * The tab's kept records. A record stays until the user has it back in a composer ("Open") or explicitly drops it;
 * showing it is not enough (the user may leave again, or reload). The store is tab-wide like the storage behind it:
 * a record made or let go by any session, one already disposed included (a save or send that ended after the user
 * left Mail), reaches the session that is showing records now through `viewer`.
 */
export interface LeftStore {
  get(): LeftBehind[];
  set(list: LeftBehind[]): void;
  viewer: LeftViewer | null;
}

export interface ComposeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Wall-clock time of day for "Saved · HH:MM". */
  hhmm(): string;
}

/** The compose API the session uses (undo goes through the tracker). */
export type ComposeApi = Pick<
  typeof composeApi,
  | "initMailCompose"
  | "saveMailDraft"
  | "discardMailDraft"
  | "uploadMailAttachment"
  | "removeMailAttachment"
  | "startMailSend"
  | "fetchMailSendStatus"
  | "dismissMailSend"
  | "fetchMailOutbox"
>;

/** What the session needs from the page around it. */
export interface ComposeHost {
  /** Something changed on the server (a send finished, a draft changed): refresh the lists. */
  onChanged(): void;
  /** Show the Drafts folder of this account. */
  onOpenDrafts(accountId: string): void;
  accounts(): MailAccount[];
  /** Accounts that can currently send (logged in). */
  sendable(): MailAccount[];
  /** Language of the initial reply / forward text. */
  locale(): "en" | "zh-CN";
}

export interface ComposeSessionDeps {
  api: ComposeApi;
  /** Follows each send from its window to its end; owned (and disposed) by whoever created the session. */
  tracker: SendTracker;
  clock: ComposeClock;
  uuid(): string;
  storage: LeftStore;
  host: ComposeHost;
}

export interface Pending {
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

/** What a notice says; the page words it (`mail.compose.<kind>` for most). */
export type NoticeKind =
  | "initReady"
  | "initFailed"
  | "attachmentDropped"
  | "error"
  | "undone"
  | "restoreFailed"
  | "restoreUndone"
  | "sentNamed"
  | "sentWarnings"
  | "interrupted"
  | "unknown"
  | "statusLost"
  | "earlierAccepted"
  | "ownedElsewhere"
  | "tooLate"
  | "leftAttachment"
  | "leftAttachmentFailed"
  | "leftSentEdits"
  | "leftNotSentSaved"
  | "leftNotSent"
  | "leftUnknown"
  | "leftUnsaved";

export interface NoticeParams {
  /** The message's subject as is (empty: the page says "no subject"). */
  subject?: string;
  /** Machine failure code, worded by the page. */
  code?: string | null;
  /** A file name. */
  name?: string;
  /** sentWarnings: no Sent copy / a Drafts copy left behind / refused recipients. */
  noCopy?: boolean;
  draftKept?: boolean;
  rejected?: number;
}

export interface NoticeEvent {
  id: number;
  tone: "info" | "warning" | "danger";
  kind: NoticeKind;
  params: NoticeParams;
  action?: { label: "openIt" | "openDrafts"; run: (id: number) => void };
  /** Server marker to forget when the user closes this notice. */
  forget?: { accountId: string; sendId: string };
  /** The tab-kept record this notice offers. */
  left?: { uid: string; rev?: string; holdsText: boolean };
  autoCloseMs?: number;
}

export interface ComposeSessionState {
  compose: ComposeState | null;
  pendings: Pending[];
  notices: NoticeEvent[];
  busy: boolean;
  /** The kept record (by uid) whose drop waits for the user's confirmation. */
  confirmDrop: string | null;
  /** The clock for the countdowns; ticks while a send is in its window. */
  now: number;
}

export interface ComposeSession {
  /** The page mounted: follow sends, report what the server still holds, offer the records kept in the tab. */
  start(): Promise<void>;
  startNew(): void;
  startFrom(mode: "reply" | "replyAll" | "forward", message: MailMessage): Promise<void>;
  editDraft(message: MailMessage): Promise<void>;
  edit(patch: Partial<MailComposeDraft> & { accountId?: string }): void;
  showCc(): void;
  minimize(v: boolean): void;
  attach(files: File[]): void;
  removeAttachment(id: string): void;
  send(): Promise<void>;
  undo(sendId: string): Promise<void>;
  /** Close the open composer after making sure the server has its text. False: it stays open. */
  close(): Promise<boolean>;
  /** The failure code (the dialog shows it and stays open) or null when the draft is gone. */
  discard(): Promise<string | null>;
  copyAsNew(): void;
  dropLeft(uid: string): void;
  cancelDrop(): void;
  closeNotice(id: number, confirmed?: boolean): void;
  getState(): ComposeSessionState;
  subscribe(fn: () => void): () => void;
  /** The page unmounted: save what the server does not have, keep in the tab what cannot be saved. */
  dispose(): void;
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

/** The browser's clock. */
export const browserComposeClock: ComposeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  hhmm: () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },
};

/** This tab's sessionStorage (one store per tab, like the storage itself). Reads and writes never throw. */
export const sessionLeftStore: LeftStore = {
  get() {
    try {
      const raw = sessionStorage.getItem(LEFT_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list as LeftBehind[]) : [];
    } catch {
      return [];
    }
  },
  set(list) {
    try {
      if (list.length === 0) sessionStorage.removeItem(LEFT_KEY);
      else sessionStorage.setItem(LEFT_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable or full: nothing more can be kept */
    }
  },
  viewer: null,
};

/** Edits the server does not have: anything but the draft object it last confirmed, or a changed sender. */
export const isUnsaved = (c: ComposeState) =>
  c.touched && (c.draft !== c.savedDraft || c.savedOn !== c.accountId);
/** Remove one occurrence (two uploads may share a file name). */
const dropOne = (list: string[], name: string) => {
  const i = list.indexOf(name);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
};

export function createComposeSession(deps: ComposeSessionDeps): ComposeSession {
  const { api, tracker, clock, storage, host } = deps;
  const newId = () => deps.uuid();

  // ---- state and its listeners ------------------------------------------------------------
  let state: ComposeSessionState = {
    compose: null,
    pendings: [],
    notices: [],
    busy: false,
    confirmDrop: null,
    now: clock.now(),
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ComposeSessionState>) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };

  /** The page is mounted (false after dispose: answers that arrive later are handled as "the user left Mail"). */
  let alive = false;
  let noticeSeq = 1;
  const saver = {
    timer: null as unknown,
    /** The save on its way (and any save chained after it); waiting for it replaces polling. */
    inflight: null as Promise<void> | null,
    dirty: false,
  };
  /** What this page knows about each followed send that the server does not: its subject and the composer text. */
  const sendMeta = new Map<string, { subject: string; snapshot: ComposeState | null }>();
  /**
   * Windows that were open when the user left Mail with text the server did not have, or with an upload still
   * running: the text is saved now and an upload that finishes later is decided after that save.
   * What cannot be saved is kept in the tab (see LEFT_KEY) and offered on the next visit.
   */
  const detached = new Map<string, { state: ComposeState; chain: Promise<void> }>();
  /** Windows the user discarded: an upload of theirs that finishes later is removed again. */
  const discarded = new Set<string>();
  /** Windows whose discard request is running: leaving Mail meanwhile must not save them back. */
  const discarding = new Set<string>();
  /** Sends already reported: the countdown, an undo answer and a status check may all end the same one. */
  const settled = new Set<string>();
  const undoing = new Set<string>();
  let ticker: unknown = null;
  /** Auto-close timers of notices; cleared on dispose. */
  const closers = new Set<unknown>();
  let offTracker: (() => void) | null = null;
  let outboxCancelled = false;

  const setCompose = (c: ComposeState | null) => set({ compose: c });
  const patchCompose = (f: (c: ComposeState) => ComposeState) => {
    const cur = state.compose;
    if (!cur) return;
    set({ compose: f(cur) });
  };
  const setPendings = (f: (list: Pending[]) => Pending[]) => {
    set({ pendings: f(state.pendings) });
    // One ticker for all countdowns (display only: the tracker ends each window and starts asking the server).
    const anyWindow = state.pendings.some((p) => p.phase === "window");
    if (anyWindow && ticker === null) ticker = clock.setInterval(() => set({ now: clock.now() }), 200);
    else if (!anyWindow && ticker !== null) {
      clock.clearInterval(ticker);
      ticker = null;
    }
  };
  const clearSaveTimer = () => {
    if (saver.timer !== null) {
      clock.clearTimeout(saver.timer);
      saver.timer = null;
    }
  };

  // ---- notices -----------------------------------------------------------------------------
  const notify = (n: Omit<NoticeEvent, "id">): number => {
    const id = noticeSeq++;
    set({
      notices: [
        ...state.notices.filter(
          (x) =>
            !(n.forget && x.forget?.sendId === n.forget.sendId) && !(n.left && x.left?.uid === n.left.uid)
        ),
        { ...n, id },
      ],
    });
    if (n.autoCloseMs) {
      const h = clock.setTimeout(() => {
        closers.delete(h);
        if (alive) set({ notices: state.notices.filter((x) => x.id !== id) });
      }, n.autoCloseMs);
      closers.add(h);
    }
    return id;
  };
  /** Remove a notice without any side effect (its action was taken). */
  const dropNotice = (id: number) => set({ notices: state.notices.filter((x) => x.id !== id) });
  const openDrafts = (accountId: string): NoticeEvent["action"] => ({
    label: "openDrafts",
    run: () => host.onOpenDrafts(accountId),
  });

  // ---- records kept in the tab -------------------------------------------------------------
  const recordLeft = (entry: LeftBehind) => {
    const e = { ...entry, rev: newId() };
    storage.set([...storage.get().filter((x) => x.uid !== e.uid), e]);
    storage.viewer?.show(e);
  };
  const findLeft = (uid: string) => storage.get().find((x) => x.uid === uid) ?? null;
  /**
   * The record is no longer needed: back in a composer, dropped by the user, or made obsolete. With `rev`, only
   * that version goes; a newer one (say, a late attachment joined it meanwhile) stays and is offered.
   */
  const clearLeft = (uid: string, rev?: string) => {
    const list = storage.get();
    const gone = (x: LeftBehind) => x.uid === uid && (rev === undefined || x.rev === rev);
    if (list.some(gone)) storage.set(list.filter((x) => !gone(x)));
    storage.viewer?.retract(uid, rev);
  };

  const newMessageId = (address: string | undefined) =>
    `<${newId()}@${(address?.split("@")[1] ?? "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost"}>`;
  const addressOf = (accountId: string) => host.accounts().find((a) => a.id === accountId)?.address;

  /**
   * The text of a message that already went out, as a new message (new Message-ID): the only way to send or keep
   * edits made after it was sent. Attachments come along only when they were staged afresh from the Drafts copy
   * (`restaged`); after a send the server deleted the staged files, so they are left out and the window says they
   * have to be added again.
   */
  const copyOf = (c: ComposeState, address: string | undefined): ComposeState => {
    const keep = c.sent?.restaged === true;
    const dropped = keep ? [] : c.attachments.map((a) => a.filename);
    return {
      ...c,
      uid: newId(),
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
  };

  const emptyDraft = (account: MailAccount): MailComposeDraft => ({
    messageId: newMessageId(account.address),
    inReplyTo: null,
    references: [],
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    attachments: [],
  });

  const baseState = (mode: ComposeState["mode"], accountId: string, draft: MailComposeDraft): ComposeState => ({
    uid: newId(),
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

  // ---- saving the draft to the server ------------------------------------------------------
  const saveOnce = async (c: ComposeState) => {
    // The answer belongs to this window only: by then another one may be open.
    const patchMine = (f: (x: ComposeState) => ComposeState) => {
      if (alive && state.compose?.uid === c.uid) patchCompose(f);
    };
    patchMine((x) => ({ ...x, save: "saving" }));
    try {
      const staleOn = c.savedOn && c.savedOn !== c.accountId ? c.savedOn : null;
      if (staleOn) {
        // The sender changed: the copy in the old account's Drafts has to go. Without the attachments:
        // they are staged independent of the account and move with the draft.
        await api.discardMailDraft(staleOn, { ...c.draft, attachments: [] }).catch(() => {});
      }
      await api.saveMailDraft(c.accountId, c.draft);
      patchMine((x) => ({
        ...x,
        save: "saved",
        saveCode: null,
        savedAt: clock.hhmm(),
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
    }
  };

  /** Saves run one at a time; a request while one is on its way runs once more after it. */
  const runSave = (): Promise<void> => {
    if (saver.inflight) {
      saver.dirty = true;
      return Promise.resolve();
    }
    const c = state.compose;
    // A message that already went out is never saved again (the server refuses it as well).
    if (!c || !c.touched || c.sending || c.sent) return Promise.resolve();
    let mine: Promise<void> | null = null;
    mine = saveOnce(c).finally(() => {
      if (saver.inflight === mine) saver.inflight = null;
      if (saver.dirty) {
        saver.dirty = false;
        void runSave();
      }
    });
    saver.inflight = mine;
    return mine;
  };
  /** Wait until no save is on its way (one chained after the current one included). */
  const saveSettled = async () => {
    while (saver.inflight) await saver.inflight;
  };

  const scheduleSave = () => {
    if (saver.timer !== null) clock.clearTimeout(saver.timer);
    saver.timer = clock.setTimeout(() => {
      saver.timer = null;
      void runSave();
    }, SAVE_DELAY_MS);
  };

  const saveDetached = (uid: string) => {
    const d = detached.get(uid);
    if (!d) return;
    const st = d.state;
    // Chained, so that a late upload of this window (see orphanUpload) is decided after this save.
    d.chain = d.chain.then(async () => {
      try {
        await api.saveMailDraft(st.accountId, st.draft);
      } catch (e) {
        recordLeft({ uid, kind: "unsaved", subject: st.draft.subject, code: mailErrorCode(e), state: st });
      }
    });
  };

  // ---- opening the composer ------------------------------------------------------------------
  const open = (next: ComposeState) => {
    if (saver.timer !== null) clock.clearTimeout(saver.timer);
    setCompose(next);
    // Text the server does not have (kept in the tab, a copy as new message) goes to Drafts soon.
    if (isUnsaved(next) && !next.sent) scheduleSave();
  };

  /** Offer a composer in a notice ("Open"); opening it first saves (and closes) the window that is open. */
  const offer = (
    next: ComposeState,
    kind: NoticeKind,
    params: NoticeParams,
    tone: NoticeEvent["tone"],
    left?: NoticeEvent["left"]
  ) => {
    notify({
      tone,
      kind,
      params,
      ...(left ? { left } : {}),
      action: {
        label: "openIt",
        run: (id) => {
          // The open composer is saved to the server first; if that fails (or it is sending) it stays.
          void closeCurrent().then((closed) => {
            if (!closed) return;
            open(next);
            dropNotice(id);
            // Only now, with the text in a composer again, is the tab-kept copy let go.
            if (left) clearLeft(left.uid, left.rev);
          });
        },
      },
    });
  };
  /** Show a composer, but never over a window that is open: then it is offered in a notice (with "Open"). */
  const present = (next: ComposeState, kind: NoticeKind, params: NoticeParams, tone: NoticeEvent["tone"]) => {
    if (!state.compose) open(next);
    else offer(next, kind, params, tone);
  };

  const startNew = () => {
    const a = host.sendable()[0];
    if (!a) return;
    open(baseState("new", a.id, emptyDraft(a)));
  };

  const startFromServer = async (mode: "reply" | "replyAll" | "forward" | "draft", message: MailMessage) => {
    const account = host.accounts().find((a) => a.id === message.accountId);
    if (!account) return;
    set({ busy: true });
    try {
      const r = await api.initMailCompose(account.id, {
        mode,
        folder: message.folder,
        uid: message.uid,
        uidValidity: message.uidValidity,
        locale: host.locale(),
      });
      if (!alive) return;
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
      present(st, "initReady", { subject: r.draft.subject }, "info");
    } catch (e) {
      if (alive) notify({ tone: "danger", kind: "initFailed", params: { code: mailErrorCode(e) }, autoCloseMs: 8000 });
    } finally {
      if (alive) set({ busy: false });
    }
  };

  // ---- editing -------------------------------------------------------------------------------
  const edit = (patch: Partial<MailComposeDraft> & { accountId?: string }) => {
    const { accountId, ...fields } = patch;
    const cur = state.compose;
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
  };

  /** An upload whose window is not the open one any more. It is never attached to another window. */
  const orphanUpload = (
    uid: string,
    accountId: string,
    name: string,
    staged: MailStagedAttachment | null,
    code: string | null
  ) => {
    const d = detached.get(uid);
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
        if (staged) void api.removeMailAttachment(accountId, staged.id).catch(() => {});
        // Say plainly that the file is not in the draft (no text is kept in this record).
        recordLeft({
          uid: `${uid}:${newId()}`,
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
    void api.removeMailAttachment(accountId, staged.id).catch(() => {});
    // Discarded: the user threw that message away. Otherwise say plainly that the file was not added.
    if (!discarded.has(uid) && alive) notify({ tone: "warning", kind: "attachmentDropped", params: { name } });
  };

  const attach = (files: File[]) => {
    const c = state.compose;
    if (!c || c.sending) return;
    const { accountId, uid } = c;
    // Every answer goes to the window that started the upload (by uid), never to "the open window".
    const mine = () => alive && state.compose?.uid === uid;
    for (const file of files) {
      const have = state.compose?.attachments.reduce((n, a) => n + a.size, 0) ?? 0;
      if (file.size > MAIL_ATTACHMENT_MAX_BYTES || have + file.size > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
        patchCompose((x) => ({ ...x, error: "attachment_too_large", errorName: file.name }));
        continue;
      }
      patchCompose((x) => ({ ...x, uploading: [...x.uploading, file.name], error: null, errorName: null }));
      void api
        .uploadMailAttachment(accountId, file)
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
  };

  const removeAttachment = (id: string) => {
    const c = state.compose;
    if (!c || c.sending) return;
    void api.removeMailAttachment(c.accountId, id).catch(() => {});
    patchCompose((x) => ({
      ...x,
      attachments: x.attachments.filter((a) => a.id !== id),
      draft: { ...x.draft, attachments: x.draft.attachments.filter((a) => a !== id) },
      touched: true,
    }));
    scheduleSave();
  };

  // ---- closing and discarding ----------------------------------------------------------------
  /** Close the open composer after making sure the server has its text. False: it stays open (save failed). */
  const closeCurrent = async (): Promise<boolean> => {
    const c = state.compose;
    if (!c) return true;
    if (c.sending) return false; // a send in flight cannot be walked away from
    if (c.uploading.length > 0) {
      // Closing now would drop the file or (worse) let it land elsewhere: say so and stay.
      patchCompose((x) => ({ ...x, error: "uploading", errorName: null }));
      return false;
    }
    clearSaveTimer();
    if (c.sent) {
      // Already sent: there is nothing to save, so closing is free. Edits made since are kept in the tab
      // (not only in a notice), so leaving Mail or reloading does not lose them either.
      if (alive) setCompose(null);
      if (c.touched && c.draft !== c.savedDraft)
        recordLeft({ uid: c.uid, kind: "sentEdits", subject: c.draft.subject, code: null, state: c });
      return true;
    }
    // Never lose text: whatever the server does not have yet (edits after the last save included, also
    // the ones whose delayed save we just cancelled) is written first; the window stays if that fails.
    for (let attempt = 0; attempt < 4; attempt++) {
      await saveSettled();
      const cur = state.compose;
      if (!cur || cur.uid !== c.uid) return false;
      if (!isUnsaved(cur)) break;
      await runSave();
      await saveSettled();
      if (state.compose?.save === "failed") return false;
    }
    const last = state.compose;
    if (!last || last.uid !== c.uid || last.sending || last.uploading.length > 0 || isUnsaved(last)) return false;
    if (alive) setCompose(null);
    if (c.savedOn) host.onChanged();
    return true;
  };

  const discard = async (): Promise<string | null> => {
    const first = state.compose;
    if (!first) return null;
    clearSaveTimer();
    // From here on the user is throwing this window away: leaving Mail meanwhile must not save it back.
    discarding.add(first.uid);
    let c: ComposeState | null;
    try {
      // A save on its way may be about to create the server copy: wait for it, then decide.
      await saveSettled();
      c = state.compose;
      if (!c || c.uid !== first.uid) return null;
      // Where a copy may be: the confirmed one, or one a save may have made although its answer was lost.
      const on = c.savedOn ?? (c.save === "failed" && c.saveCode === "unreachable" ? c.accountId : null);
      if (on) {
        try {
          await api.discardMailDraft(on, c.draft);
        } catch (e) {
          return mailErrorCode(e);
        }
        host.onChanged();
      }
    } finally {
      discarding.delete(first.uid);
    }
    if (!c.savedOn && !(c.save === "failed" && c.saveCode === "unreachable")) {
      for (const a of c.attachments) void api.removeMailAttachment(c.accountId, a.id).catch(() => {});
    }
    // An upload still running for this window is removed when it finishes.
    discarded.add(c.uid);
    if (state.compose?.uid === c.uid) setCompose(null);
    return null;
  };

  // ---- sending, the windows and what happened --------------------------------------------------
  /** Put a restored composer in front of the user, but never over text they are typing now. */
  const restoreCompose = (p: Pending, code: string | null) => {
    const snap = p.snapshot;
    if (!snap) {
      notify({
        tone: code ? "danger" : "info",
        kind: code ? "error" : "undone",
        params: code ? { code } : {},
        action: openDrafts(p.accountId),
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
      code ? "restoreFailed" : "restoreUndone",
      code ? { subject: p.subject, code } : { subject: p.subject },
      code ? "danger" : "info"
    );
  };

  const settle = (p: Pending, st: MailSendStatus) => {
    if (settled.has(p.sendId)) return;
    settled.add(p.sendId);
    setPendings((list) => list.filter((x) => x.sendId !== p.sendId));
    const forget = { accountId: p.accountId, sendId: p.sendId };
    const subject = p.subject;
    if (st.state === "sent") {
      notify({ tone: "info", kind: "sentNamed", params: { subject }, autoCloseMs: 4000 });
      // Anything the user must know (no Sent copy, refused recipients, a draft copy left behind) stays
      // on screen, and the server keeps the result until it is closed.
      const noCopy = st.sentCopy === "failed";
      const draftKept = !noCopy && st.draftKept;
      if (noCopy || draftKept || st.rejected > 0)
        notify({
          tone: "warning",
          kind: "sentWarnings",
          params: { noCopy, draftKept, rejected: st.rejected },
          action: openDrafts(p.accountId),
          forget,
        });
      else void api.dismissMailSend(p.accountId, p.sendId).catch(() => {});
      host.onChanged();
    } else if (st.state === "failed" && st.code !== "outcome_unknown") {
      // Definitely not sent: the text comes back. A failure whose outcome cannot be known is reported below.
      void api.dismissMailSend(p.accountId, p.sendId).catch(() => {});
      restoreCompose(p, st.code ?? "unknown");
      host.onChanged();
    } else if (st.state === "cancelled") {
      void api.dismissMailSend(p.accountId, p.sendId).catch(() => {});
      restoreCompose(p, null);
    } else if (st.state === "interrupted") {
      notify({ tone: "warning", kind: "interrupted", params: { subject }, action: openDrafts(p.accountId), forget });
      host.onChanged();
    } else {
      // unknown, or failed with outcome_unknown: it may or may not have gone out. Never "not sent".
      notify({ tone: "warning", kind: "unknown", params: { subject }, action: openDrafts(p.accountId), forget });
      host.onChanged();
    }
  };

  /** The server no longer knows the send, or it could not be learned in time how it ended. */
  const lost = (p: Pending) => {
    setPendings((list) => list.filter((x) => x.sendId !== p.sendId));
    notify({
      tone: "warning",
      kind: "statusLost",
      params: { subject: p.subject },
      action: openDrafts(p.accountId),
    });
  };

  /**
   * The tracker's views become the countdown bars; a send that ended is reported here (what to say and whether the
   * text comes back stays this page's business) and is no longer followed.
   */
  const onSends = (views: SendView[]) => {
    const shown: Pending[] = [];
    const ended: Array<{ p: Pending; status: MailSendStatus | null }> = [];
    for (const v of views) {
      const m = sendMeta.get(v.sendId);
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
      tracker.untrack(p.sendId);
      sendMeta.delete(p.sendId);
      if (status) settle(p, status);
      else lost(p);
    }
  };

  /** The server accepted a send of this window: it closes into a countdown (or the "sending" bar). */
  const accepted = (c: ComposeState, st: MailSendStatus) => {
    // The snapshot is this composer's (by uid); a different window is never closed or rewritten here.
    const mine = state.compose?.uid === c.uid ? state.compose : null;
    const snapshot: ComposeState = { ...(mine ?? c), sending: false, unconfirmed: null, error: null, errorName: null };
    if (mine) setCompose(null);
    sendMeta.set(st.sendId, { subject: st.subject || c.draft.subject, snapshot });
    set({ now: clock.now() });
    tracker.track(st.accountId || c.accountId, st.sendId, st);
  };

  /**
   * The user left Mail while this window's send was on its way, and the send did not open a window.
   * Its text must not vanish: save it to Drafts if possible, and keep it in the tab either way.
   */
  const leftAfterSend = async (c: ComposeState, code: string, unconfirmed: ComposeState["unconfirmed"]) => {
    const base: ComposeState = { ...c, sending: false, uploading: [], error: code, errorName: null, unconfirmed };
    // Without an answer it may still be under way: never claim "not sent" then.
    const unknown = code === "unreachable";
    try {
      await api.saveMailDraft(c.accountId, c.draft);
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
  };

  const send = async () => {
    const c = state.compose;
    if (!c || c.sending || c.sent) return;
    if (`${c.draft.to}${c.draft.cc}${c.draft.bcc}`.trim() === "") {
      patchCompose((x) => ({ ...x, error: "no_recipients" }));
      return;
    }
    if (c.uploading.length > 0) return;
    clearSaveTimer();
    patchCompose((x) => ({ ...x, sending: true, error: null, errorName: null }));
    const mineOnly = (f: (x: ComposeState) => ComposeState) => {
      if (state.compose?.uid === c.uid) patchCompose(f);
    };
    const sig = `${c.accountId}\u0000${JSON.stringify(c.draft)}`;
    let unconfirmed = c.unconfirmed;
    if (unconfirmed) {
      // An earlier send of this window never got an answer. Ask what became of it before sending again:
      // it may be in its window right now, and a second send id would send the message twice.
      let earlier: MailSendStatus | null = null;
      try {
        earlier = await api.fetchMailSendStatus(unconfirmed.accountId, unconfirmed.sendId);
      } catch (e) {
        const notThere = e instanceof MailApiError && e.status === 404;
        if (!notThere) {
          if (!alive) return void leftAfterSend(c, "unreachable", unconfirmed);
          // Still unknown: do not send. The window keeps its text and the reason.
          mineOnly((x) => ({ ...x, sending: false, error: mailErrorCode(e), errorName: null }));
          return;
        }
      }
      if (!alive) return void leftAfterSend(c, "unreachable", unconfirmed);
      if (earlier) {
        const subject = earlier.subject || c.draft.subject;
        if (earlier.state === "pending" || earlier.state === "sending") {
          // It did arrive: this click joins it. Edits made since then are not in it (undo brings them back).
          if (unconfirmed.sig !== sig) notify({ tone: "warning", kind: "earlierAccepted", params: { subject } });
          accepted(c, earlier);
          return;
        }
        // A failure whose SMTP outcome cannot be known may have gone out: it counts as unknown (ticket 43), never
        // as "did not go out". The server reports it as unknown already; this holds even if it said failed.
        const outcomeUnknown =
          earlier.state === "unknown" || (earlier.state === "failed" && earlier.code === "outcome_unknown");
        if (earlier.state === "sent" || outcomeUnknown) {
          settle(
            {
              accountId: earlier.accountId,
              sendId: earlier.sendId,
              subject,
              endsAt: 0,
              phase: "sending",
              unreachable: false,
              snapshot: null,
            },
            earlier
          );
          const sentCopy = earlier.state === "sent" ? earlier.sentCopy : null;
          mineOnly((x) => ({
            ...x,
            sending: false,
            unconfirmed: null,
            ...(earlier.state === "sent" ? { sent: { sentCopy }, error: null } : { error: "outcome_unknown" }),
            errorName: null,
          }));
          return;
        }
        // Failed, undone or interrupted: it did not go out, so this click may send.
        void api.dismissMailSend(earlier.accountId, earlier.sendId).catch(() => {});
        unconfirmed = null;
      }
      // 404: the server has no such send (yet). If the old request is still being prepared it holds the
      // draft's claim, so a new send id is refused rather than sent; the binding stays until resolved.
    }
    // The same content retried is the same send id (the server joins it), never a second send.
    const sendId =
      unconfirmed && unconfirmed.sig === sig && unconfirmed.accountId === c.accountId ? unconfirmed.sendId : newId();
    try {
      const st = await api.startMailSend(c.accountId, sendId, c.draft);
      // Gone from Mail meanwhile: the server holds the send and reports it when Mail opens again.
      if (!alive) return;
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
      if (!alive) return void leftAfterSend(c, code, next);
      if (state.compose?.uid === c.uid) {
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
          "restoreFailed",
          { subject: c.draft.subject, code },
          "danger"
        );
      }
    }
  };

  const undo = async (sendId: string) => {
    const p = state.pendings.find((x) => x.sendId === sendId);
    if (!p || offTracker === null || undoing.has(sendId)) return;
    undoing.add(sendId);
    try {
      // A send that ended (undone, or found to have ended otherwise) is reported through the tracker's views.
      const r = await tracker.undo(sendId);
      if (!alive) return;
      if (r === "ownedElsewhere")
        // Another Mail window of the app holds this send; only it can undo.
        notify({ tone: "warning", kind: "ownedElsewhere", params: {}, autoCloseMs: 8000 });
      else if (r === "tooLate") notify({ tone: "warning", kind: "tooLate", params: {}, autoCloseMs: 6000 });
      else if (typeof r === "object") notify({ tone: "danger", kind: "error", params: { code: r.error }, autoCloseMs: 8000 });
    } finally {
      undoing.delete(sendId);
    }
  };

  // ---- records kept in this tab ----------------------------------------------------------------
  // After leaving Mail (a draft that could not be saved, a send that did not get through, a late attachment): say
  // what happened and offer the text back. Never opened over the page.
  const showLeft = (e: LeftBehind) => {
    const subject = e.subject;
    if (e.kind === "attachment") {
      // No text is kept: the draft text is on the server; only the file has to be added again.
      notify({
        tone: "warning",
        kind: e.code ? "leftAttachmentFailed" : "leftAttachment",
        params: { subject, name: e.name ?? "", code: e.code },
        left: { uid: e.uid, rev: e.rev, holdsText: false },
        action: openDrafts(e.state.accountId),
      });
      return;
    }
    if (e.kind === "sentEdits") {
      offer(copyOf(e.state, addressOf(e.state.accountId)), "leftSentEdits", { subject }, "warning", {
        uid: e.uid,
        rev: e.rev,
        holdsText: true,
      });
      return;
    }
    const kind: NoticeKind =
      e.kind === "notSentSaved"
        ? "leftNotSentSaved"
        : e.kind === "notSent"
          ? "leftNotSent"
          : e.kind === "unknown"
            ? "leftUnknown"
            : "leftUnsaved";
    const saved = e.kind === "notSentSaved";
    const next: ComposeState = {
      ...e.state,
      uid: newId(),
      sending: false,
      uploading: [],
      minimized: false,
      touched: true,
      save: saved ? "saved" : "idle",
      savedDraft: saved ? e.state.draft : null,
    };
    offer(next, kind, { subject, code: e.code }, e.kind === "unsaved" || e.kind === "unknown" ? "warning" : "danger", {
      uid: e.uid,
      rev: e.rev,
      holdsText: true,
    });
  };
  const viewer: LeftViewer = {
    show: (e) => showLeft(e),
    retract: (uid, rev) =>
      set({ notices: state.notices.filter((x) => !(x.left?.uid === uid && (rev === undefined || x.left.rev === rev))) }),
  };

  return {
    async start() {
      alive = true;
      offTracker = tracker.subscribe(onSends);
      outboxCancelled = false;
      // Shown, not taken: the records stay until opened or explicitly dropped.
      storage.viewer = viewer;
      const outbox = api.fetchMailOutbox();
      for (const e of storage.get()) showLeft(e);
      // On opening Mail: anything the server still holds from before (in its window, finished, or ended without a send).
      try {
        const { sends } = await outbox;
        if (outboxCancelled || !alive) return;
        for (const st of sends) {
          // A send the Copilot started has its own card and undo bar; it is not this page's to restore,
          // report or acknowledge (acknowledging deletes the record the Copilot reads its result from).
          if (st.origin === "copilot") continue;
          if (st.state === "pending" || st.state === "sending") {
            if (sendMeta.has(st.sendId)) continue;
            sendMeta.set(st.sendId, { subject: st.subject, snapshot: null });
            tracker.track(st.accountId, st.sendId, st);
          } else
            settle(
              {
                accountId: st.accountId,
                sendId: st.sendId,
                subject: st.subject,
                endsAt: clock.now() + (st.remainingMs ?? 0),
                phase: "sending",
                unreachable: false,
                snapshot: null,
              },
              st
            );
        }
      } catch {
        /* nothing to report: the outbox will be asked again on the next visit */
      }
    },
    startNew,
    startFrom: (mode, message) => startFromServer(mode, message),
    editDraft: (message) => startFromServer("draft", message),
    edit,
    showCc: () => patchCompose((c) => ({ ...c, showCc: true })),
    minimize: (v) => patchCompose((c) => ({ ...c, minimized: v })),
    attach,
    removeAttachment,
    send,
    undo,
    close: closeCurrent,
    discard,
    copyAsNew() {
      const c = state.compose;
      if (!c?.sent) return;
      open(copyOf(c, addressOf(c.accountId)));
    },
    // Confirmed: every version of that record goes, whichever notice now shows it.
    dropLeft(uid) {
      set({ confirmDrop: null });
      clearLeft(uid);
    },
    cancelDrop: () => set({ confirmDrop: null }),
    /** A notice holding kept text asks before it goes: closing it drops the text for good. */
    closeNotice(id, confirmed = false) {
      const gone = state.notices.find((x) => x.id === id);
      if (!gone) return;
      if (gone.left?.holdsText && !confirmed) {
        set({ confirmDrop: gone.left.uid });
        return;
      }
      if (gone.forget) void api.dismissMailSend(gone.forget.accountId, gone.forget.sendId).catch(() => {});
      if (gone.left) clearLeft(gone.left.uid);
      set({ confirmDrop: null, notices: state.notices.filter((x) => x.id !== id) });
    },
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      alive = false;
      if (saver.timer !== null) clock.clearTimeout(saver.timer);
      const c = state.compose;
      // A window that is sending is taken care of by its send, which learns how it ended (see `send`);
      // one being discarded is going away on purpose.
      if (c && !c.sending && !discarding.has(c.uid)) {
        if (c.sent) {
          // It went out already: nothing can be saved. Edits made since are kept once, as a copy to offer.
          if (c.touched && c.draft !== c.savedDraft)
            recordLeft({ uid: c.uid, kind: "sentEdits", subject: c.draft.subject, code: null, state: c });
          if (c.uploading.length > 0) detached.set(c.uid, { state: c, chain: Promise.resolve() });
        } else if (isUnsaved(c) || c.uploading.length > 0) {
          detached.set(c.uid, { state: c, chain: Promise.resolve() });
          if (isUnsaved(c)) saveDetached(c.uid);
        }
      }
      offTracker?.();
      offTracker = null;
      sendMeta.clear();
      outboxCancelled = true;
      if (ticker !== null) {
        clock.clearInterval(ticker);
        ticker = null;
      }
      for (const h of closers) clock.clearTimeout(h);
      closers.clear();
      if (storage.viewer === viewer) storage.viewer = null;
    },
  };
}
