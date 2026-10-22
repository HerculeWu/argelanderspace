/**
 * SendTracker (Copilot ticket 40) at its own seam: a scripted status/undo API and a fake clock, no DOM. The two
 * consumers' policies are the ones exported next to the tracker, so the numbers pinned here are the ones they use.
 */
import type { MailSendStatus } from "@argelanderspace/contracts";
import { expect, test, vi } from "vitest";
import { MailApiError } from "../src/api/mail";
import {
  COPILOT_SEND_POLICY,
  createSendTracker,
  MAIL_PAGE_SEND_POLICY,
  type SendPolicy,
  type SendView,
} from "../src/mail/send-tracker";

const ACC = "acc-aaaaaaaaaaaa";
const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const status = (over: Partial<MailSendStatus> = {}): MailSendStatus => ({
  sendId: ID,
  accountId: ACC as MailSendStatus["accountId"],
  messageId: "<d@example.test>",
  subject: "Hello",
  state: "pending",
  remainingMs: 8000,
  code: null,
  sentCopy: null,
  draftKept: true,
  rejected: 0,
  ownedElsewhere: false,
  ...over,
});
const last = <T>(list: T[]): T | undefined => list[list.length - 1];
const down = () => new MailApiError("unreachable", 0);
const gone = () => new MailApiError("not_found", 404);

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A clock whose timers run only when the test advances it; every scheduled delay is recorded. */
function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const delays: number[] = [];
  return {
    clock: {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.set(id, { at: t + ms, fn });
        delays.push(ms);
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    delays,
    timers: () => timers.size,
    now: () => t,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        const next = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await flush();
    },
  };
}

/** Each status call takes the next scripted answer (the last one repeats); a function answer may throw. */
function setup(policy: SendPolicy, answers: Array<MailSendStatus | (() => MailSendStatus)> = []) {
  const c = fakeClock();
  const script = [...answers];
  const api = {
    status: vi.fn(async (_accountId: string, _sendId: string) => {
      const next = script.length > 1 ? script.shift() : script[0];
      if (!next) throw gone();
      return typeof next === "function" ? next() : next;
    }),
    undo: vi.fn(async (_accountId: string, sendId: string) => status({ sendId, state: "cancelled", remainingMs: null })),
  };
  const tracker = createSendTracker({ api, clock: c.clock }, policy);
  let views: SendView[] = [];
  const emits: SendView[][] = [];
  tracker.subscribe((v) => {
    views = v;
    emits.push(v);
  });
  const view = (id = ID) => views.find((v) => v.sendId === id);
  return { c, api, tracker, view, emits, script };
}

test("the two consumers keep their own numbers", () => {
  expect(MAIL_PAGE_SEND_POLICY).toEqual({
    pollMs: 600,
    backoff: 1.6,
    maxPollMs: 4000,
    giveUpMs: 10 * 60 * 1000,
    on404: "lost",
    showUnreachable: true,
    pollInWindow: false,
  });
  expect(COPILOT_SEND_POLICY).toEqual({
    pollMs: 600,
    backoff: null,
    maxPollMs: 1500,
    giveUpMs: null,
    on404: "gone",
    showUnreachable: false,
    pollInWindow: true,
  });
});

test("window -> sending -> settled: the window is counted down without asking, then the server is asked until it ends", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    status({ state: "sending", remainingMs: null }),
    status({ state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false }),
  ]);
  tracker.track(ACC, ID, status({ remainingMs: 1000 }));
  expect(view()).toMatchObject({ accountId: ACC, sendId: ID, phase: "window", endsAt: c.now() + 1000, unreachable: false });
  await c.advance(999);
  expect(api.status).not.toHaveBeenCalled();
  expect(view()?.phase).toBe("window");
  await c.advance(1);
  expect(view()?.phase).toBe("sending");
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(api.status).toHaveBeenCalledWith(ACC, ID);
  await c.advance(600);
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(view()).toMatchObject({ phase: "settled", status: { state: "sent", sentCopy: "saved" } });
  await c.advance(60_000);
  expect(api.status).toHaveBeenCalledTimes(2); // a settled send is not asked about again
  expect(c.timers()).toBe(0);
});

test("a send that starts outside its window (state sending) is polled at once", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "failed", remainingMs: null, code: "recipient_rejected" })]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  expect(view()?.phase).toBe("sending");
  await flush();
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(view()).toMatchObject({ phase: "settled", status: { state: "failed", code: "recipient_rejected" } });
});

test("Mail page policy: failures back off 600 -> 960 -> ... up to 4000 and show 'unreachable'; an answer resets both", async () => {
  let fail = true;
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    () => {
      if (fail) throw down();
      return status({ state: "sending", remainingMs: null });
    },
  ]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await flush();
  expect(view()?.unreachable).toBe(true);
  c.delays.length = 0;
  await c.advance(60_000);
  const expected = [1536, 2457.6, 3932.16, 4000, 4000];
  for (const [i, d] of expected.entries()) expect(c.delays[i]).toBeCloseTo(d, 5);
  expect(view()?.phase).toBe("sending");
  expect(view()?.unreachable).toBe(true);
  // The first retry came after 960 ms (the delay scheduled by the first failure).
  const calls = api.status.mock.calls.length;
  fail = false;
  await c.advance(4000);
  expect(api.status.mock.calls.length).toBeGreaterThan(calls);
  expect(view()?.unreachable).toBe(false);
  c.delays.length = 0;
  await c.advance(600);
  expect(c.delays[0]).toBe(600); // back to the normal interval after an answer
});

test("Mail page policy: the first failure waits 960 ms", async () => {
  const { c, api, tracker } = setup(MAIL_PAGE_SEND_POLICY, [
    () => {
      throw down();
    },
  ]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await flush();
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(last(c.delays)).toBeCloseTo(960, 5);
  await c.advance(959);
  expect(api.status).toHaveBeenCalledTimes(1);
  await c.advance(1);
  expect(api.status).toHaveBeenCalledTimes(2);
});

test("Mail page policy: after 10 minutes of not knowing, the send is lost and no longer asked about", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    () => {
      throw down();
    },
  ]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await c.advance(10 * 60 * 1000 - 5000);
  expect(view()?.phase).toBe("sending");
  await c.advance(10_000);
  expect(view()?.phase).toBe("lost");
  const n = api.status.mock.calls.length;
  await c.advance(60_000);
  expect(api.status.mock.calls.length).toBe(n);
});

test("Mail page policy: a server that keeps saying 'sending' is also given up after 10 minutes", async () => {
  const { c, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "sending", remainingMs: null })]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await c.advance(10 * 60 * 1000 + 1200);
  expect(view()?.phase).toBe("lost");
});

test("404: lost on the Mail page, gone on the Copilot bar; neither asks again", async () => {
  for (const [policy, phase] of [
    [MAIL_PAGE_SEND_POLICY, "lost"],
    [COPILOT_SEND_POLICY, "gone"],
  ] as const) {
    const { c, api, tracker, view } = setup(policy, [
      () => {
        throw gone();
      },
    ]);
    tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
    await flush();
    expect(view()?.phase).toBe(phase);
    await c.advance(60_000);
    expect(api.status).toHaveBeenCalledTimes(1);
  }
});

test("Copilot policy: failures retry every 1500 ms without backoff and never show 'unreachable'; no give-up", async () => {
  const { c, api, tracker, view } = setup(COPILOT_SEND_POLICY, [
    () => {
      throw down();
    },
  ]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await flush();
  c.delays.length = 0;
  await c.advance(15 * 60 * 1000);
  expect(new Set(c.delays)).toEqual(new Set([1500]));
  expect(view()?.unreachable).toBe(false);
  expect(view()?.phase).toBe("sending");
  expect(api.status.mock.calls.length).toBeGreaterThan(500);
});

test("Copilot policy: with no known state it asks at once and shows nothing until the first answer; a pending answer opens the window", async () => {
  const { c, api, tracker, view } = setup(COPILOT_SEND_POLICY, [status({ remainingMs: 6000 })]);
  tracker.track(ACC, ID);
  expect(view()).toMatchObject({ phase: "sending", status: null });
  await flush();
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(view()).toMatchObject({ phase: "window", endsAt: c.now() + 6000 });
  // In the window the Copilot bar keeps asking every 600 ms (the Mail page does not).
  await c.advance(600);
  expect(api.status).toHaveBeenCalledTimes(2);
  await c.advance(600);
  expect(api.status).toHaveBeenCalledTimes(3);
});

test("Copilot policy: a first answer of another Mail window's pending send still opens the window", async () => {
  const { tracker, view } = setup(COPILOT_SEND_POLICY, [status({ remainingMs: 5000, ownedElsewhere: true })]);
  tracker.track(ACC, ID);
  await flush();
  expect(view()?.phase).toBe("window");
});

test("clock skew: a server still counting the window down sends the view back to 'window' (Mail page: not asked again until it ends)", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    status({ remainingMs: 500 }),
    status({ state: "sent", remainingMs: null }),
  ]);
  tracker.track(ACC, ID, status({ remainingMs: 1000 }));
  await c.advance(1000);
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(view()).toMatchObject({ phase: "window", endsAt: c.now() + 500, unreachable: false });
  await c.advance(499);
  expect(api.status).toHaveBeenCalledTimes(1);
  await c.advance(1);
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(view()?.phase).toBe("settled");
});

test("clock skew: the Copilot bar gets the same rollback", async () => {
  const { c, tracker, view } = setup(COPILOT_SEND_POLICY, [
    status({ remainingMs: 1000 }),
    status({ remainingMs: 0 }),
    status({ remainingMs: 700 }),
  ]);
  tracker.track(ACC, ID);
  await flush();
  expect(view()?.phase).toBe("window");
  // The server says 0 left: the local window ends, the bar shows "sending"; the next answer says 700 left.
  await c.advance(600);
  expect(view()?.phase).toBe("sending");
  await c.advance(600);
  expect(view()).toMatchObject({ phase: "window", endsAt: c.now() + 700 });
});

test("clock skew does not apply to a send another Mail window owns, nor to one with no time left", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    status({ remainingMs: 3000, ownedElsewhere: true }),
    status({ remainingMs: 0 }),
  ]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await flush();
  expect(view()?.phase).toBe("sending");
  await c.advance(600);
  expect(view()?.phase).toBe("sending");
  expect(api.status).toHaveBeenCalledTimes(2);
});

test("one loop per send id: tracking it again neither restarts nor doubles the polling", async () => {
  const { c, api, tracker, emits } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "sending", remainingMs: null })]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  tracker.track(ACC, ID);
  await flush();
  expect(api.status).toHaveBeenCalledTimes(1);
  await c.advance(600);
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(last(emits)).toHaveLength(1);
  // A second send has its own loop.
  tracker.track(ACC, ID2, status({ sendId: ID2, state: "sending", remainingMs: null }));
  await flush();
  expect(api.status).toHaveBeenCalledTimes(3);
  expect(last(emits)?.map((v) => v.sendId)).toEqual([ID, ID2]);
});

test("undo: accepted -> settled with the server's answer", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY);
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toBe("settled");
  expect(api.undo).toHaveBeenCalledWith(ACC, ID);
  expect(view()).toMatchObject({ phase: "settled", status: { state: "cancelled" } });
  expect(api.status).not.toHaveBeenCalled();
});

test("undo: not_pending with the send already going out -> tooLate, and the send is followed from there", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    status({ state: "sending", remainingMs: null }),
    status({ state: "sending", remainingMs: null }),
    status({ state: "sent", remainingMs: null }),
  ]);
  api.undo.mockRejectedValueOnce(new MailApiError("not_pending", 409));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toBe("tooLate");
  expect(view()?.phase).toBe("sending");
  await c.advance(1200);
  expect(view()).toMatchObject({ phase: "settled", status: { state: "sent" } });
});

test("undo: owned_elsewhere while another window still holds it -> ownedElsewhere, the window stays", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ remainingMs: 5000, ownedElsewhere: true })]);
  api.undo.mockRejectedValueOnce(new MailApiError("owned_elsewhere", 409));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toBe("ownedElsewhere");
  expect(view()?.phase).toBe("window");
});

test("undo: not_found after a restart asks what happened and reports that, not 'too late'", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "interrupted", remainingMs: null })]);
  api.undo.mockRejectedValueOnce(new MailApiError("not_found", 404));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toBe("settled");
  expect(view()).toMatchObject({ phase: "settled", status: { state: "interrupted" } });
});

test("undo: any other error is reported as is; the state is refreshed once (a failed refresh changes nothing)", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    () => {
      throw down();
    },
  ]);
  api.undo.mockRejectedValueOnce(new MailApiError("auth_failed", 502));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toEqual({ error: "auth_failed" });
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(view()?.phase).toBe("window");
  api.undo.mockRejectedValueOnce(new TypeError("network down"));
  await expect(tracker.undo(ID)).resolves.toEqual({ error: "unreachable" });
  expect(api.status).toHaveBeenCalledTimes(2);
});

test("undo: after an unreachable undo the refreshed state is shown (here: it was undone after all)", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "cancelled", remainingMs: null })]);
  api.undo.mockRejectedValueOnce(new TypeError("network down"));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toEqual({ error: "unreachable" });
  expect(view()).toMatchObject({ phase: "settled", status: { state: "cancelled" } });
});

test("undo: when the status check after a refusal fails, its error is reported", async () => {
  const { api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [
    () => {
      throw down();
    },
  ]);
  api.undo.mockRejectedValueOnce(new MailApiError("not_pending", 409));
  tracker.track(ACC, ID, status());
  await expect(tracker.undo(ID)).resolves.toEqual({ error: "unreachable" });
  expect(view()?.phase).toBe("window");
});

test("undo: double clicks make one request", async () => {
  const { api, tracker } = setup(MAIL_PAGE_SEND_POLICY);
  tracker.track(ACC, ID, status());
  const [a, b] = await Promise.all([tracker.undo(ID), tracker.undo(ID)]);
  expect([a, b]).toEqual(["settled", "settled"]);
  expect(api.undo).toHaveBeenCalledTimes(1);
});

test("undo: an answer that arrives after the send already ended changes nothing", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "failed", code: "recipient_rejected", remainingMs: null })]);
  let release: (s: MailSendStatus) => void = () => {};
  api.undo.mockImplementationOnce(() => new Promise((r) => (release = r)));
  tracker.track(ACC, ID, status({ remainingMs: 300 }));
  const answer = tracker.undo(ID);
  await c.advance(300);
  expect(view()).toMatchObject({ phase: "settled", status: { state: "failed" } });
  release(status({ state: "cancelled", remainingMs: null }));
  await expect(answer).resolves.toBe("settled");
  expect(view()?.status?.state).toBe("failed");
});

test("untrack stops one send's polling; dispose stops everything", async () => {
  const { c, api, tracker, emits } = setup(MAIL_PAGE_SEND_POLICY, [status({ state: "sending", remainingMs: null })]);
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  tracker.track(ACC, ID2, status({ sendId: ID2, remainingMs: 2000 }));
  await flush();
  tracker.untrack(ID);
  expect(last(emits)?.map((v) => v.sendId)).toEqual([ID2]);
  const n = api.status.mock.calls.length;
  await c.advance(1000);
  expect(api.status.mock.calls.length).toBe(n);
  tracker.dispose();
  await c.advance(60_000);
  expect(api.status.mock.calls.length).toBe(n);
  expect(c.timers()).toBe(0);
});

test("an answer that arrives after untrack is ignored", async () => {
  const { c, api, tracker, view } = setup(MAIL_PAGE_SEND_POLICY);
  let release: (s: MailSendStatus) => void = () => {};
  api.status.mockImplementationOnce(() => new Promise((r) => (release = r)));
  tracker.track(ACC, ID, status({ state: "sending", remainingMs: null }));
  await flush();
  tracker.untrack(ID);
  release(status({ state: "sent", remainingMs: null }));
  await c.advance(5000);
  expect(view()).toBeUndefined();
  expect(c.timers()).toBe(0);
});

// The server counts remainingMs when it builds the answer; the page learns it one answer delay later. The page's end of the window
// is the moment the request went out plus remainingMs, so it is never later than the server's (web-test-flake 05).
test("the window ends at the time of the request plus remainingMs, not at the time the answer arrived", async () => {
  const c = fakeClock();
  const api = {
    status: vi.fn(async () => {
      await c.advance(400); // a slow answer
      return status({ remainingMs: 8000 });
    }),
    undo: vi.fn(),
  };
  const tracker = createSendTracker({ api, clock: c.clock }, COPILOT_SEND_POLICY);
  let views: SendView[] = [];
  tracker.subscribe((v) => (views = v));
  const sentAt = c.now();
  tracker.track(ACC, ID);
  await flush();
  await c.advance(0);
  expect(views[0]?.phase).toBe("window");
  expect(views[0]?.endsAt).toBe(sentAt + 8000);
  tracker.dispose();
});

test("a send known from its start answer counts the window from the moment that request went out", async () => {
  const { c, tracker, view } = setup(MAIL_PAGE_SEND_POLICY, [status({ remainingMs: 1000 })]);
  const requestedAt = c.now();
  await c.advance(300);
  tracker.track(ACC, ID, status({ remainingMs: 1000 }), requestedAt);
  expect(view()?.endsAt).toBe(requestedAt + 1000);
});

test("a failed undo that refreshes the status also counts from the request time", async () => {
  const c = fakeClock();
  const api = {
    status: vi.fn(async () => {
      await c.advance(250);
      return status({ remainingMs: 700 });
    }),
    undo: vi.fn(async () => {
      throw new MailApiError("boom", 500);
    }),
  };
  const tracker = createSendTracker({ api, clock: c.clock }, MAIL_PAGE_SEND_POLICY);
  let views: SendView[] = [];
  tracker.subscribe((v) => (views = v));
  tracker.track(ACC, ID, status({ remainingMs: 8000 }));
  const before = c.now();
  await tracker.undo(ID);
  expect(views[0]?.endsAt).toBe(before + 700);
  tracker.dispose();
});
