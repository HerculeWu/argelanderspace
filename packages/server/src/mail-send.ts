/**
 * Sending mail with the 8 second undo window (Mail ticket 07; ADR 0008; spec Q16).
 *
 * The sequence for one send, and why it cannot send twice or lose the mail:
 *
 *  1. Claim the draft's Message-ID (O_EXCL file in the global cache): a second send of the same draft,
 *     from another request or another server process, is refused with `already_pending`. Holding the
 *     claim, a Message-ID that already went out (the sent guard) is refused with `already_sent`.
 *  2. Put the FINAL message into the account's Drafts folder (APPEND, replacing older copies). From
 *     here on the mail is safe on the remote authority whatever happens to this process.
 *  3. Write the marker (state `pending`, owner pid, deadline) and arm an in-memory, unref'd timer.
 *     The window is entered only now; if steps 2 or 3 fail nothing is pending and nothing is sent.
 *  4. Undo before the timer fires cancels it; the user is back in the composer and the draft is intact.
 *  5. At the deadline the owner moves the marker to `sending` and makes ONE SMTP transaction. SMTP is
 *     never retried. Then it appends the Sent copy (unless the provider saves it itself) and removes
 *     the Drafts copy.
 *
 * A server that exits in the window never reaches step 5: the draft is already in Drafts, and nothing
 * reads a marker as an instruction to send. After a restart the marker of a dead owner is reported as
 * `interrupted` (not sent, back in Drafts). A process that dies after the window closed leaves
 * `sending`, reported as `unknown` (it may or may not have been sent), still without resending.
 * Only the owning process ever sends; other processes only observe.
 */

import { randomBytes } from "node:crypto";
import {
  MAIL_SERVER_SAVES_SENT,
  MAIL_UNDO_WINDOW_MS,
  type MailAccount,
  type MailComposeFailureCode,
  type MailOutboxMarker,
  type MailSendRequest,
  type MailSendStatus,
} from "@argelanderspace/contracts";
import type { MailOutgoing } from "@argelanderspace/infra";
import { MailComposeError, type MailComposeService } from "./mail-compose.js";
import type { MailOutbox, OutboxOwner } from "./mail-outbox.js";

const KEEP_FINISHED_MS = 60 * 60 * 1000;
/** How long a finished send stays in memory (status polls); afterwards the marker file answers. */
const LIVE_TTL_MS = 10 * 60 * 1000;

/** Default (production) services, so the server can stop them first thing when it shuts down. */
const shutdownRegistry = new Set<MailSendService>();
/** Called synchronously at the start of server shutdown: no undo window may end into a send from now on. */
export function disposeMailSendServices(): void {
  for (const s of shutdownRegistry) s.dispose();
}
const KEEP_PROBLEMS_MS = 30 * 24 * 3600 * 1000;

interface LiveSend {
  marker: MailOutboxMarker;
  timer: NodeJS.Timeout | null;
  raw: Buffer;
  wire: Buffer;
  envelope: { from: string; to: string[] };
  staged: string[];
  /** Resolves when the send reached a final state (tests await it). */
  done: Promise<void>;
  finish: () => void;
  /** The send, its Sent copy and the Drafts cleanup are all over; only then is `sent` reported to clients. */
  finished: boolean;
}

export interface MailSendDeps {
  compose: MailComposeService;
  outgoing: MailOutgoing;
  outbox: MailOutbox;
  /** Undo window length, default 8 s. */
  undoMs?: number;
  now?: () => number;
  pid?: number;
  /** Production wiring: register for `disposeMailSendServices()`. */
  registerForShutdown?: boolean;
}

export class MailSendService {
  private readonly live = new Map<string, LiveSend>();
  /** Starts in progress, so a repeated request with the same sendId joins instead of racing the claim. */
  private readonly starting = new Map<string, Promise<MailSendStatus>>();
  private readonly owner: OutboxOwner;
  private readonly undoMs: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly deps: MailSendDeps) {
    this.owner = { pid: deps.pid ?? process.pid, boot: randomBytes(8).toString("hex") };
    this.undoMs = deps.undoMs ?? MAIL_UNDO_WINDOW_MS;
    this.now = deps.now ?? Date.now;
    // Editing or discarding a draft that is in its window (or being sent) is refused; so is saving a
    // Message-ID that already went out back into Drafts (discarding a leftover copy of it stays possible).
    deps.compose.setSendGuard((accountId, messageId) => {
      if (deps.outbox.claimHeld(accountId, messageId, this.owner)) return "already_pending";
      if (deps.outbox.sentRecently(accountId, messageId)) return "already_sent";
      return null;
    });
    // Opening a draft whose Message-ID already went out says so (it can no longer be sent or saved).
    deps.compose.setSentLookup((accountId, messageId) =>
      deps.outbox.sentInfo(accountId, messageId)
    );
    if (deps.registerForShutdown) shutdownRegistry.add(this);
  }

  // ---- start ---------------------------------------------------------------------

  start(accountId: string, req: MailSendRequest): Promise<MailSendStatus> {
    const key = `${accountId}\u0000${req.sendId}`;
    const joined = this.starting.get(key);
    if (joined) return joined;
    const run = this.startOnce(accountId, req).finally(() => this.starting.delete(key));
    this.starting.set(key, run);
    return run;
  }

  private async startOnce(accountId: string, req: MailSendRequest): Promise<MailSendStatus> {
    const existing = this.live.get(req.sendId);
    // The same sendId again (double click, client retry) is the same send, never a second one. The disk
    // marker answers too, so this holds after the in-memory record has expired.
    if (existing && existing.marker.accountId === accountId) return this.statusOf(existing.marker);
    const stored = this.deps.outbox.read(accountId, req.sendId);
    if (stored) return this.statusOf(stored);
    if (this.disposed) throw new MailComposeError("storage"); // shutting down: no new window

    const compose = this.deps.compose;
    const a = compose.account(accountId);
    const draft = req.draft;
    const built = await compose.build(a, draft, true);

    if (!this.deps.outbox.claim(a.id, draft.messageId, req.sendId, this.owner)) {
      throw new MailComposeError("already_pending");
    }
    let armed = false;
    try {
      // Checked while holding the claim; `fire` records it before releasing the claim. So a request
      // that arrives after this Message-ID went out (a lost answer retried under a new send id, a late
      // first request, another tab) can never send it a second time.
      if (this.deps.outbox.sentRecently(a.id, draft.messageId))
        throw new MailComposeError("already_sent");
      // An account deleted while we were building must not get its cache directory (claim, marker) back.
      compose.account(a.id);
      // The final message goes to the server's Drafts BEFORE the window opens.
      const imap = await compose.imapTarget(a);
      const saved = await compose.withDraftLock(a.id, draft.messageId, () =>
        this.deps.outgoing.saveDraft(imap, { raw: built.raw, messageId: draft.messageId })
      );
      if (!saved.ok) throw new MailComposeError(saved.code);
      compose.account(a.id);

      const createdAt = this.now();
      if (this.disposed) {
        // Shutdown began while we were storing the draft: no window opens. The mail is in Drafts, which is
        // exactly what "interrupted" says; the claim is released below (nothing was armed).
        const gone: MailOutboxMarker = {
          version: 1,
          sendId: req.sendId,
          accountId: a.id,
          messageId: draft.messageId,
          subject: draft.subject.slice(0, 2000),
          state: "interrupted",
          createdAt,
          deadlineAt: createdAt,
          ownerPid: this.owner.pid,
          ownerBoot: this.owner.boot,
          code: null,
          ambiguous: false,
          sentCopy: null,
          draftKept: true,
          rejected: 0,
        };
        this.deps.outbox.write(gone);
        return this.statusOf(gone);
      }
      const marker: MailOutboxMarker = {
        version: 1,
        sendId: req.sendId,
        accountId: a.id,
        messageId: draft.messageId,
        subject: draft.subject.slice(0, 2000),
        state: "pending",
        createdAt,
        deadlineAt: createdAt + this.undoMs,
        ownerPid: this.owner.pid,
        ownerBoot: this.owner.boot,
        code: null,
        ambiguous: false,
        sentCopy: null,
        draftKept: true,
        rejected: 0,
      };
      try {
        this.deps.outbox.writeStrict(marker);
      } catch {
        // Without a marker a restart could not tell the user the mail was not sent: do not open the window.
        throw new MailComposeError("storage");
      }
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const rec: LiveSend = {
        marker,
        timer: null,
        raw: built.raw,
        wire: built.wire,
        envelope: built.envelope,
        staged: built.staged,
        done,
        finish,
        finished: false,
      };
      this.live.set(req.sendId, rec);
      rec.timer = setTimeout(() => void this.fire(rec), this.undoMs);
      // A process that is shutting down must not wait for (and then perform) a send nobody can undo.
      rec.timer.unref();
      armed = true;
      return this.statusOf(marker);
    } finally {
      if (!armed) this.deps.outbox.release(a.id, draft.messageId, req.sendId);
    }
  }

  // ---- undo -------------------------------------------------------------------------

  /** Cancel a send that is still inside its window. */
  cancel(accountId: string, sendId: string): MailSendStatus {
    const rec = this.live.get(sendId);
    if (!rec || rec.marker.accountId !== accountId) {
      const stored = this.deps.outbox.read(accountId, sendId);
      if (!stored) throw new MailComposeError("not_found");
      const st = this.statusOf(stored);
      throw new MailComposeError(st.ownedElsewhere ? "owned_elsewhere" : "not_pending");
    }
    if (rec.marker.state !== "pending" || rec.timer === null)
      throw new MailComposeError("not_pending");
    clearTimeout(rec.timer);
    rec.timer = null;
    rec.marker = { ...rec.marker, state: "cancelled" };
    this.deps.outbox.write(rec.marker);
    this.deps.outbox.release(rec.marker.accountId, rec.marker.messageId, sendId);
    this.conclude(rec);
    return this.statusOf(rec.marker);
  }

  // ---- the send itself -------------------------------------------------------------------

  private async fire(rec: LiveSend): Promise<void> {
    // A shut-down process never sends (dispose already marked these interrupted); neither does a send undone meanwhile.
    if (this.disposed || rec.marker.state !== "pending") return;
    rec.timer = null;
    const m = rec.marker;
    const set = (patch: Partial<MailOutboxMarker>) => {
      rec.marker = { ...rec.marker, ...patch };
      this.deps.outbox.write(rec.marker);
    };
    // The `sending` marker is what lets a restart say "outcome unknown": if it cannot be written, do not send.
    rec.marker = { ...rec.marker, state: "sending" };
    try {
      this.deps.outbox.writeStrict(rec.marker);
    } catch {
      set({ state: "failed", code: "storage" });
      this.deps.outbox.release(m.accountId, m.messageId, m.sendId);
      this.conclude(rec);
      return;
    }
    const compose = this.deps.compose;
    try {
      let account: MailAccount;
      let smtp: Awaited<ReturnType<MailComposeService["smtpTarget"]>>;
      try {
        account = compose.account(m.accountId);
        smtp = await compose.smtpTarget(account);
      } catch (error) {
        set({ state: "failed", code: error instanceof MailComposeError ? error.code : "storage" });
        return;
      }
      const sent = await this.deps.outgoing.sendSmtp(smtp, {
        from: rec.envelope.from,
        to: rec.envelope.to,
        raw: rec.wire,
      });
      if (!sent.ok) {
        set({
          state: "failed",
          code: sent.ambiguous ? "outcome_unknown" : sent.code,
          ambiguous: sent.ambiguous === true,
        });
        return;
      }
      // The SMTP server has the message. Record that before the cleanup, so a crash from here on is not
      // mistaken for "possibly unsent".
      set({ state: "sent", rejected: sent.value.rejected });
      this.deps.outbox.markSent(m.accountId, m.messageId, m.sendId);

      let sentCopy: "saved" | "by_server" | "failed";
      let imap: Awaited<ReturnType<MailComposeService["imapTarget"]>> | null = null;
      try {
        imap = await compose.imapTarget(account);
      } catch {
        imap = null;
      }
      if (MAIL_SERVER_SAVES_SENT[account.preset]) sentCopy = "by_server";
      else if (!imap) sentCopy = "failed";
      else {
        const appended = await this.deps.outgoing
          .appendSent(imap, { raw: rec.raw })
          .catch(() => null);
        sentCopy = appended?.ok ? "saved" : "failed";
      }
      // With no Sent copy at all, the Drafts copy is the only record of what was sent: keep it.
      let draftKept = true;
      if (sentCopy !== "failed" && imap) {
        const removed = await compose
          .withDraftLock(m.accountId, m.messageId, () =>
            this.deps.outgoing.deleteDraft(imap as NonNullable<typeof imap>, {
              messageId: m.messageId,
            })
          )
          .catch(() => null);
        draftKept = !removed?.ok;
      }
      set({ sentCopy, draftKept });
      this.deps.outbox.markSent(m.accountId, m.messageId, m.sendId, sentCopy);
      compose.deleteStaged(m.accountId, rec.staged);
    } catch {
      // Anything unexpected before SMTP confirmed: the outcome is unknown unless we already recorded sent.
      if ((rec.marker as MailOutboxMarker).state === "sending")
        set({ state: "failed", code: "unknown", ambiguous: true });
    } finally {
      this.deps.outbox.release(m.accountId, m.messageId, m.sendId);
      this.conclude(rec);
    }
  }

  /** A send reached a final state: free its message bytes and let the record expire from memory. */
  private conclude(rec: LiveSend): void {
    rec.finished = true;
    rec.raw = Buffer.alloc(0);
    rec.wire = Buffer.alloc(0);
    rec.finish();
    const id = rec.marker.sendId;
    setTimeout(() => {
      if (this.live.get(id) === rec) this.live.delete(id);
    }, LIVE_TTL_MS).unref();
  }

  // ---- status ---------------------------------------------------------------------

  private statusOf(marker: MailOutboxMarker): MailSendStatus {
    const liveRec = this.live.get(marker.sendId) ?? null;
    const mine = liveRec?.marker ?? null;
    const m = mine ?? marker;
    let state: MailSendStatus["state"];
    let ownedElsewhere = false;
    if (liveRec && !liveRec.finished && m.state === "sent")
      state = "sending"; // the cleanup is still running
    else if (m.state === "failed") state = m.ambiguous ? "unknown" : "failed";
    else if (m.state === "interrupted") state = "interrupted";
    else if (m.state === "pending" || m.state === "sending") {
      if (mine) state = m.state;
      else if (m.ownerBoot !== this.owner.boot && this.deps.outbox.ownerAlive(m, this.owner)) {
        state = m.state;
        ownedElsewhere = true;
      } else state = m.state === "pending" ? "interrupted" : "unknown";
    } else state = m.state;
    const unknownOutcome = state === "unknown";
    return {
      sendId: m.sendId,
      accountId: m.accountId,
      messageId: m.messageId,
      subject: m.subject,
      state,
      remainingMs: state === "pending" ? Math.max(0, m.deadlineAt - this.now()) : null,
      code:
        state === "failed" || unknownOutcome
          ? ((m.code ?? "outcome_unknown") as MailComposeFailureCode)
          : null,
      sentCopy: state === "sent" ? m.sentCopy : null,
      // Interrupted/failed/cancelled/unknown: the Drafts copy is still there. Sent: depends on cleanup.
      draftKept: state === "sent" ? m.draftKept : true,
      rejected: m.rejected,
      ownedElsewhere,
    };
  }

  status(accountId: string, sendId: string): MailSendStatus {
    const rec = this.live.get(sendId);
    if (rec && rec.marker.accountId === accountId) return this.statusOf(rec.marker);
    const stored = this.deps.outbox.read(accountId, sendId);
    if (!stored) throw new MailComposeError("not_found");
    return this.statusOf(stored);
  }

  /** Sends that still need the user's attention: in the window, in flight, or ended without a send. */
  list(): MailSendStatus[] {
    const out: MailSendStatus[] = [];
    for (const accountId of this.deps.outbox.accountIds()) {
      this.deps.outbox.sweep(accountId, KEEP_FINISHED_MS, KEEP_PROBLEMS_MS, this.owner);
      for (const stored of this.deps.outbox.list(accountId)) {
        const st = this.statusOf(stored);
        // A recently sent mail stays listed (until the page acknowledges it), so that a send which
        // completed while the user was away from Mail is still reported on return.
        if (st.state === "cancelled") continue;
        out.push(st);
      }
    }
    return out;
  }

  /** The user has seen the outcome: forget the marker (and the in-memory record of a finished send). */
  dismiss(accountId: string, sendId: string): void {
    const rec = this.live.get(sendId);
    if (rec && rec.marker.accountId === accountId) {
      if (!rec.finished) throw new MailComposeError("not_pending");
      this.live.delete(sendId);
    } else {
      const stored = this.deps.outbox.read(accountId, sendId);
      if (
        stored &&
        (stored.state === "pending" || stored.state === "sending") &&
        this.deps.outbox.ownerAlive(stored, this.owner)
      )
        throw new MailComposeError("owned_elsewhere");
    }
    this.deps.outbox.remove(accountId, sendId);
  }

  /** Test hook: resolves when the send has reached a final state in this process. */
  async settled(sendId: string): Promise<void> {
    await this.live.get(sendId)?.done;
  }

  /**
   * Graceful stop: from now on no undo window ends into a send. Every send still in its window is
   * marked interrupted (the message is in Drafts; it is never sent automatically), and its claim released.
   * A send already handed to SMTP is left to finish.
   */
  dispose(): void {
    this.disposed = true;
    shutdownRegistry.delete(this);
    for (const rec of this.live.values()) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      if (rec.marker.state === "pending") {
        rec.marker = { ...rec.marker, state: "interrupted" };
        this.deps.outbox.write(rec.marker);
        this.deps.outbox.release(rec.marker.accountId, rec.marker.messageId, rec.marker.sendId);
        rec.finished = true;
        rec.finish();
      }
    }
  }
}
