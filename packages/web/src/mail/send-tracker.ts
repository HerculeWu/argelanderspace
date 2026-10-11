/**
 * Following a send (Mail ticket 07, Copilot ticket 40): from its undo window to the state the server finally reports.
 * One loop per send id asks the server for the send's status until it ends; the Mail page's countdowns and the
 * Copilot's undo bar both read it through this module, each with its own polling policy. It is not React: the
 * consumers subscribe and decide what to say about a result (this module never shows anything itself).
 *
 * Phases: `window` (counted down locally until `endsAt`; the server sends at its own deadline unless undone),
 * `sending` (the window is over, or the state is not known yet: the server is asked), and the ends `settled` (the
 * server reported a final state, in `status`), `lost` / `gone` (the server has no such send any more, or it could not
 * be learned in time; which of the two is the policy's choice). A server that is still counting the window down when
 * the local one ended (clock skew) sends the view back to `window`.
 */

import type { MailSendState, MailSendStatus } from "@argelanderspace/contracts";
import { MailApiError, mailErrorCode } from "../api/mail";
import { fetchMailSendStatus, undoMailSend } from "../api/mail-compose";

export interface SendTrackerDeps {
  api: {
    status(accountId: string, sendId: string): Promise<MailSendStatus>;
    undo(accountId: string, sendId: string): Promise<MailSendStatus>;
  };
  clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

export interface SendPolicy {
  /** Interval between status requests while the server answers. */
  pollMs: number;
  /** After a failed request: multiply the interval by this, up to `maxPollMs`; null waits `maxPollMs` every time. */
  backoff: number | null;
  maxPollMs: number;
  /** Give up (phase `lost`) when the server has not reported an end this long after polling started; null never. */
  giveUpMs: number | null;
  /** What the server not knowing the send (404) means for the view. */
  on404: "lost" | "gone";
  /** Set `unreachable` while requests fail. */
  showUnreachable: boolean;
  /** Keep asking during the window too (otherwise the window is only counted down). */
  pollInWindow: boolean;
}

export type SendPhase = "window" | "sending" | "settled" | "gone" | "lost";

export interface SendView {
  accountId: string;
  sendId: string;
  phase: SendPhase;
  /** End of the undo window on the local clock (window phase; kept afterwards). */
  endsAt: number | null;
  /** The last status request failed (only with `showUnreachable`). */
  unreachable: boolean;
  /** The server's last answer; null until there is one. */
  status: MailSendStatus | null;
}

export type UndoResult = "settled" | "tooLate" | "ownedElsewhere" | { error: string };

export interface SendTracker {
  /** Follow a send. `initial` is a state already known (a send just accepted, an outbox entry); without it the server is asked at once. One loop per send id: tracking it again does nothing. */
  track(accountId: string, sendId: string, initial?: MailSendStatus): void;
  untrack(sendId: string): void;
  undo(sendId: string): Promise<UndoResult>;
  subscribe(fn: (views: SendView[]) => void): () => void;
  dispose(): void;
}

/** The Mail page: back off while the server cannot be reached and say so; give up after 10 minutes. */
export const MAIL_PAGE_SEND_POLICY: Readonly<SendPolicy> = {
  pollMs: 600,
  backoff: 1.6,
  maxPollMs: 4000,
  giveUpMs: 10 * 60 * 1000,
  on404: "lost",
  showUnreachable: true,
  pollInWindow: false,
};

/** The Copilot's undo bar: asks during the window as well, retries quietly every 1.5 s, never gives up. */
export const COPILOT_SEND_POLICY: Readonly<SendPolicy> = {
  pollMs: 600,
  backoff: null,
  maxPollMs: 1500,
  giveUpMs: null,
  on404: "gone",
  showUnreachable: false,
  pollInWindow: true,
};

/** The real compose API and the browser clock. */
export const browserSendTrackerDeps: SendTrackerDeps = {
  api: { status: fetchMailSendStatus, undo: undoMailSend },
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

interface Entry {
  view: SendView;
  /** A status request is scheduled or running. */
  polling: boolean;
  pollTimer: unknown;
  windowTimer: unknown;
  loopStarted: number;
  delay: number;
  undoing: Promise<UndoResult> | null;
}

/** Which states end a send. Exhaustive: a state added to the contracts must be classified here (tsc fails otherwise). */
const ENDS = {
  pending: false,
  sending: false,
  sent: true,
  cancelled: true,
  failed: true,
  interrupted: true,
  unknown: true,
} satisfies Record<MailSendState, boolean>;
const TERMINAL: ReadonlySet<MailSendState> = new Set(
  (Object.keys(ENDS) as MailSendState[]).filter((state) => ENDS[state])
);

export function createSendTracker(deps: SendTrackerDeps, policy: SendPolicy): SendTracker {
  const { api, clock } = deps;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(views: SendView[]) => void>();
  let disposed = false;
  let emitting = false;
  let again = false;

  // Listeners may untrack from inside the callback: such changes are delivered after the current round.
  const emit = () => {
    if (emitting) {
      again = true;
      return;
    }
    emitting = true;
    try {
      do {
        again = false;
        const views = [...entries.values()].map((e) => e.view);
        for (const fn of [...listeners]) fn(views);
      } while (again);
    } finally {
      emitting = false;
    }
  };

  const live = (e: Entry) => !disposed && entries.get(e.view.sendId) === e;
  const open = (e: Entry) => live(e) && (e.view.phase === "window" || e.view.phase === "sending");
  const patch = (e: Entry, p: Partial<SendView>) => {
    e.view = { ...e.view, ...p };
  };

  const stopPolling = (e: Entry) => {
    if (e.pollTimer !== null) clock.clearTimeout(e.pollTimer);
    e.pollTimer = null;
    e.polling = false;
  };
  const stopWindow = (e: Entry) => {
    if (e.windowTimer !== null) clock.clearTimeout(e.windowTimer);
    e.windowTimer = null;
  };
  const end = (e: Entry, p: Partial<SendView>) => {
    stopPolling(e);
    stopWindow(e);
    patch(e, p);
  };

  /** The window ends on the local clock: from then on the server is asked how the send ended. */
  const armWindow = (e: Entry) => {
    stopWindow(e);
    const endsAt = e.view.endsAt ?? clock.now();
    e.windowTimer = clock.setTimeout(() => {
      e.windowTimer = null;
      if (!open(e) || e.view.phase !== "window") return;
      patch(e, { phase: "sending" });
      emit();
      startPolling(e);
    }, Math.max(0, endsAt - clock.now()));
  };
  const toWindow = (e: Entry, remainingMs: number) => {
    patch(e, { phase: "window", endsAt: clock.now() + remainingMs });
    armWindow(e);
  };

  const startPolling = (e: Entry) => {
    if (e.polling || !open(e)) return;
    e.polling = true;
    e.loopStarted = clock.now();
    e.delay = policy.pollMs;
    void poll(e);
  };
  const next = (e: Entry) => {
    if (policy.giveUpMs !== null && clock.now() - e.loopStarted > policy.giveUpMs) {
      end(e, { phase: "lost" });
      emit();
      return;
    }
    e.pollTimer = clock.setTimeout(() => {
      e.pollTimer = null;
      void poll(e);
    }, e.delay);
  };

  const poll = async (e: Entry) => {
    const { accountId, sendId } = e.view;
    let st: MailSendStatus;
    try {
      st = await api.status(accountId, sendId);
    } catch (error) {
      if (!open(e) || !e.polling) return;
      if (error instanceof MailApiError && error.status === 404) {
        end(e, { phase: policy.on404 });
        emit();
        return;
      }
      if (policy.showUnreachable && !e.view.unreachable) {
        patch(e, { unreachable: true });
        emit();
      }
      e.delay = policy.backoff === null ? policy.maxPollMs : Math.min(e.delay * policy.backoff, policy.maxPollMs);
      next(e);
      return;
    }
    if (!open(e) || !e.polling) return;
    const first = e.view.status === null;
    patch(e, { status: st, unreachable: false });
    e.delay = policy.pollMs;
    if (TERMINAL.has(st.state)) {
      end(e, { phase: "settled" });
      emit();
      return;
    }
    if (st.state === "pending") {
      if (first || e.view.phase === "window") {
        // The first answer about a send, or one asked during its window: the window as the server counts it.
        toWindow(e, st.remainingMs ?? 0);
      } else if (!st.ownedElsewhere && st.remainingMs !== null && st.remainingMs > 0) {
        // Clock skew: the server still counts the window down.
        toWindow(e, st.remainingMs);
      }
    } else if (e.view.phase === "window") {
      stopWindow(e);
      patch(e, { phase: "sending" });
    }
    emit();
    if (e.view.phase === "window" && !policy.pollInWindow) {
      stopPolling(e);
      return;
    }
    next(e);
  };

  const settleWith = (e: Entry, st: MailSendStatus) => {
    end(e, { phase: "settled", status: st, unreachable: false });
    emit();
  };

  /** One status request outside the loop (after a failed undo); a failure keeps the view as it is. */
  const refresh = async (e: Entry) => {
    let st: MailSendStatus;
    try {
      st = await api.status(e.view.accountId, e.view.sendId);
    } catch {
      return;
    }
    if (!open(e)) return;
    if (TERMINAL.has(st.state)) return settleWith(e, st);
    if (st.state === "pending") {
      if (st.remainingMs !== null && (e.view.phase === "window" || (!st.ownedElsewhere && st.remainingMs > 0)))
        toWindow(e, st.remainingMs);
      patch(e, { status: st });
      emit();
      return;
    }
    stopWindow(e);
    patch(e, { phase: "sending", status: st });
    emit();
    startPolling(e);
  };

  return {
    track(accountId, sendId, initial) {
      if (disposed || entries.has(sendId)) return;
      const e: Entry = {
        view: { accountId, sendId, phase: "sending", endsAt: null, unreachable: false, status: initial ?? null },
        polling: false,
        pollTimer: null,
        windowTimer: null,
        loopStarted: clock.now(),
        delay: policy.pollMs,
        undoing: null,
      };
      entries.set(sendId, e);
      if (initial?.state === "pending") {
        patch(e, { phase: "window", endsAt: clock.now() + (initial.remainingMs ?? 0) });
        armWindow(e);
        emit();
        if (policy.pollInWindow) startPolling(e);
        return;
      }
      // Any other known state is confirmed by asking (a final state included), as is a send not known yet.
      emit();
      startPolling(e);
    },

    untrack(sendId) {
      const e = entries.get(sendId);
      if (!e) return;
      stopPolling(e);
      stopWindow(e);
      entries.delete(sendId);
      emit();
    },

    undo(sendId) {
      const e = entries.get(sendId);
      if (!e || disposed) return Promise.resolve({ error: "not_found" });
      if (e.undoing) return e.undoing;
      const { accountId } = e.view;
      const run = async (): Promise<UndoResult> => {
        let st: MailSendStatus;
        try {
          st = await api.undo(accountId, sendId);
        } catch (error) {
          const code = mailErrorCode(error);
          if (code !== "not_pending" && code !== "owned_elsewhere" && code !== "not_found") {
            // Reported as is; the send's state is still refreshed once right away (what the bar shows stays real).
            await refresh(e);
            return { error: code };
          }
          // The server says it is not (or no longer) undoable. Ask what actually happened before saying anything:
          // after a restart the window is simply gone, which is not the same as "already being sent".
          let now: MailSendStatus;
          try {
            now = await api.status(accountId, sendId);
          } catch (error2) {
            return { error: mailErrorCode(error2) };
          }
          // Ended meanwhile (the countdown's own check got there first): that result stands.
          if (!open(e)) return "settled";
          if (now.ownedElsewhere && now.state === "pending") return "ownedElsewhere";
          if (now.state === "sending" || now.state === "pending") {
            stopWindow(e);
            patch(e, { phase: "sending", status: now });
            emit();
            startPolling(e);
            return "tooLate";
          }
          settleWith(e, now);
          return "settled";
        }
        if (open(e)) settleWith(e, st);
        return "settled";
      };
      const p = run().finally(() => {
        e.undoing = null;
      });
      e.undoing = p;
      return p;
    },

    subscribe(fn) {
      listeners.add(fn);
      fn([...entries.values()].map((e) => e.view));
      return () => {
        listeners.delete(fn);
      };
    },

    dispose() {
      disposed = true;
      for (const e of entries.values()) {
        stopPolling(e);
        stopWindow(e);
      }
      entries.clear();
      listeners.clear();
    },
  };
}
