/**
 * ComposeSession (Copilot ticket 41) at its own seam: a scripted compose API, a fake send tracker, a fake clock,
 * sequential ids and an in-memory tab store. No DOM, no React. Each test drives the session the way the Mail page
 * does and reads its state, the requests it made and the notice events it raised.
 */
import type { MailAccount, MailComposeDraft, MailMessage, MailSendStatus, MailStagedAttachment } from "@argelanderspace/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { MailApiError } from "../src/api/mail";
import {
  type ComposeApi,
  type ComposeSession,
  createComposeSession,
  LEFT_KEY,
  type LeftBehind,
  type LeftStore,
  SAVE_DELAY_MS,
  sessionLeftStore,
} from "../src/mail/compose-session";
import {
  createSendTracker,
  MAIL_PAGE_SEND_POLICY,
  type SendTracker,
  type SendView,
  type UndoResult,
} from "../src/mail/send-tracker";

const A1 = "acc-aaaaaaaaaaaa";
const A2 = "acc-bbbbbbbbbbbb";
const account = (id: string, address: string): MailAccount => ({
  id: id as MailAccount["id"],
  displayName: id,
  address,
  preset: "custom",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: "u",
  smtpUser: "u",
  credentialRef: id as MailAccount["credentialRef"],
  credentialProtection: "keychain",
});
const status = (over: Partial<MailSendStatus> = {}): MailSendStatus => ({
  sendId: "s-1",
  accountId: A1 as MailSendStatus["accountId"],
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
const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  accountId: A1 as MailMessage["accountId"],
  folder: "INBOX",
  uid: 3,
  uidValidity: 7,
  messageId: "m@example.test",
  subject: "Subject 3",
  date: "2026-10-05T10:00:00.000Z",
  from: { name: "Ada", address: "ada@example.test" },
  to: [],
  cc: [],
  replyTo: [],
  text: "Plain body",
  html: null,
  attachments: [],
  ...over,
});
const staged = (id: string, filename = `${id}.pdf`, size = 10): MailStagedAttachment => ({
  id,
  filename,
  contentType: "application/pdf",
  size,
});
const down = () => new MailApiError("unreachable", 0);
const refused = (code: string, status = 409) => new MailApiError(code, status);

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Timers and intervals run only when the test advances the clock. With `step`, every reading of the clock is that
 * many ms later than the one before (a real clock read twice does not give the same number twice).
 */
function fakeClock(step = 0) {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    clock: {
      now: () => {
        const read = t;
        t += step;
        return read;
      },
      setTimeout: (fn: () => void, ms: number) => {
        timers.set(++seq, { at: t + ms, fn, every: null });
        return seq;
      },
      clearTimeout: (h: unknown) => void timers.delete(h as number),
      setInterval: (fn: () => void, ms: number) => {
        timers.set(++seq, { at: t + ms, fn, every: ms });
        return seq;
      },
      clearInterval: (h: unknown) => void timers.delete(h as number),
      hhmm: () => "10:42",
    },
    intervals: () => [...timers.values()].filter((x) => x.every !== null).length,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        const next = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, x] = next;
        if (x.every === null) timers.delete(id);
        else x.at += x.every;
        t = x.at - (x.every ?? 0);
        x.fn();
      }
      t = end;
      await flush();
    },
  };
}

/** A tracker the test drives: it records what the session asks and emits the views the test gives it. */
function fakeTracker() {
  const listeners = new Set<(v: SendView[]) => void>();
  let views: SendView[] = [];
  const tracked: Array<{ accountId: string; sendId: string; initial?: MailSendStatus }> = [];
  const untracked: string[] = [];
  let undoResult: () => Promise<UndoResult> = async () => "settled";
  const undoCalls: string[] = [];
  const tracker: SendTracker = {
    track(accountId, sendId, initial) {
      tracked.push({ accountId, sendId, ...(initial ? { initial } : {}) });
      views = [
        ...views.filter((v) => v.sendId !== sendId),
        {
          accountId,
          sendId,
          phase: initial?.state === "pending" ? "window" : "sending",
          endsAt: initial?.state === "pending" ? 1_000_000 + (initial.remainingMs ?? 0) : null,
          unreachable: false,
          status: initial ?? null,
        },
      ];
      for (const fn of [...listeners]) fn(views);
    },
    untrack(sendId) {
      untracked.push(sendId);
      views = views.filter((v) => v.sendId !== sendId);
      for (const fn of [...listeners]) fn(views);
    },
    undo(sendId) {
      undoCalls.push(sendId);
      return undoResult();
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(views);
      return () => void listeners.delete(fn);
    },
    dispose() {},
  };
  return {
    tracker,
    tracked,
    untracked,
    undoCalls,
    listeners: () => listeners.size,
    setUndo(f: () => Promise<UndoResult>) {
      undoResult = f;
    },
    /** The tracker reports a send's view (e.g. its end). */
    emit(sendId: string, patch: Partial<SendView>) {
      views = views.map((v) => (v.sendId === sendId ? { ...v, ...patch } : v));
      for (const fn of [...listeners]) fn(views);
    },
  };
}

function memoryStore(initial: LeftBehind[] = []): LeftStore & { list: LeftBehind[] } {
  const store = {
    list: initial,
    viewer: null as LeftStore["viewer"],
    get: () => store.list,
    set: (l: LeftBehind[]) => {
      store.list = l;
    },
  };
  return store;
}

function fakeApi() {
  const api = {
    initMailCompose: vi.fn(async () => ({
      draft: {
        messageId: "<reply-1@example.test>",
        inReplyTo: "<m@example.test>",
        references: ["<m@example.test>"],
        to: "Ada <ada@example.test>",
        cc: "",
        bcc: "",
        subject: "Re: Subject 3",
        text: "\n\n> Plain body\n",
        attachments: [],
      } as MailComposeDraft,
      attachments: [] as MailStagedAttachment[],
      sent: null as null | { sentCopy: "saved" | "by_server" | "failed" | null },
    })),
    saveMailDraft: vi.fn(async (_a: string, d: MailComposeDraft) => ({
      messageId: d.messageId,
      savedAt: "x",
      folder: "Drafts",
      uid: 1,
    })),
    discardMailDraft: vi.fn(async (_a: string, _d: MailComposeDraft) => ({ ok: true as const })),
    uploadMailAttachment: vi.fn(async (_a: string, f: File) => staged("up-1", f.name)),
    removeMailAttachment: vi.fn(async (_a: string, _id: string) => ({ ok: true as const })),
    startMailSend: vi.fn(async (_a: string, sendId: string, d: MailComposeDraft) =>
      status({ sendId, subject: d.subject })
    ),
    fetchMailSendStatus: vi.fn(async (_a: string, _id: string): Promise<MailSendStatus> => {
      throw refused("not_found", 404);
    }),
    dismissMailSend: vi.fn(async (_a: string, _id: string) => ({ ok: true as const })),
    fetchMailOutbox: vi.fn(async () => ({ sends: [] as MailSendStatus[] })),
  };
  return api;
}

let sessions: ComposeSession[] = [];
afterEach(() => {
  for (const s of sessions) s.dispose();
  sessions = [];
});

function rig(
  o: {
    store?: ReturnType<typeof memoryStore>;
    accounts?: MailAccount[];
    /** The real send tracker on the session's clock, which moves on by this many ms at every reading. */
    realTracker?: { step: number };
  } = {}
) {
  const api = fakeApi();
  const tr = fakeTracker();
  const clk = fakeClock(o.realTracker?.step ?? 0);
  const tracker = o.realTracker
    ? createSendTracker(
        { api: { status: api.fetchMailSendStatus, undo: async () => status({ state: "cancelled" }) }, clock: clk.clock },
        MAIL_PAGE_SEND_POLICY
      )
    : tr.tracker;
  const store = o.store ?? memoryStore();
  let n = 0;
  const host = {
    accounts: o.accounts ?? [account(A1, "work@example.test"), account(A2, "home@other.test")],
    changed: 0,
    drafts: [] as string[],
  };
  const s = createComposeSession({
    api: api as unknown as ComposeApi,
    tracker,
    clock: clk.clock,
    uuid: () => `id-${++n}`,
    storage: store,
    host: {
      onChanged: () => void host.changed++,
      onOpenDrafts: (id) => void host.drafts.push(id),
      accounts: () => host.accounts,
      sendable: () => host.accounts,
      locale: () => "en",
    },
  });
  sessions.push(s);
  const st = () => s.getState();
  const c = () => s.getState().compose;
  const notices = () => s.getState().notices;
  const kinds = () => notices().map((x) => x.kind);
  /** A started session with a new composer holding a recipient and some text. */
  const writing = async (subject = "Hello", text = "Dear Ada") => {
    await s.start();
    s.startNew();
    s.edit({ to: "ada@example.test", subject, text });
  };
  /**
   * What the undo bar shows each time the session publishes a state with a send in its window: the page computes
   * the seconds from exactly these two numbers (`endsAt` of the send and `now`).
   */
  const shownSeconds: number[] = [];
  s.subscribe(() => {
    const p = st().pendings.find((x) => x.phase === "window");
    if (p) shownSeconds.push(Math.max(0, Math.ceil((p.endsAt - st().now) / 1000)));
  });
  return { s, api, tr, clk, store, host, st, c, notices, kinds, writing, shownSeconds };
}

// ---- saving -----------------------------------------------------------------------------------

test("typing is saved after a 1200 ms pause, not before; the saved copy is exactly the draft object that was sent", async () => {
  const r = await (async () => {
    const x = rig();
    await x.writing();
    return x;
  })();
  expect(SAVE_DELAY_MS).toBe(1200);
  await r.clk.advance(1199);
  expect(r.api.saveMailDraft).not.toHaveBeenCalled();
  await r.clk.advance(1);
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  const sent = r.api.saveMailDraft.mock.calls[0]![1];
  expect(r.c()!.save).toBe("saved");
  expect(r.c()!.savedAt).toBe("10:42");
  expect(r.c()!.savedOn).toBe(A1);
  expect(r.c()!.savedDraft).toBe(sent);
  expect(r.c()!.draft).toBe(sent);
});

test("saves run one at a time: an edit during a save runs exactly one more save after it, and stays unsaved until then", async () => {
  const r = rig();
  await r.writing();
  const first = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await first.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.c()!.save).toBe("saving");
  r.s.edit({ text: "Dear Ada, again" });
  await r.clk.advance(SAVE_DELAY_MS); // the second request finds the first in flight: marked dirty only
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  first.resolve();
  await flush();
  // The first answer marks only what it sent as saved: the later edit is still unsaved...
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2);
  expect(r.api.saveMailDraft.mock.calls[1]![1].text).toBe("Dear Ada, again");
  await flush();
  expect(r.c()!.savedDraft).toBe(r.c()!.draft);
});

test("an edit made while a save is on its way is not counted as saved by that save's answer (reference comparison)", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await hold.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  const inFlight = r.api.saveMailDraft.mock.calls[0]![1];
  r.s.edit({ text: "later" }); // its own delayed save is not due yet
  hold.resolve();
  await flush();
  expect(r.c()!.save).toBe("saved");
  expect(r.c()!.savedDraft).toBe(inFlight);
  expect(r.c()!.savedDraft).not.toBe(r.c()!.draft);
  // Closing therefore saves once more before it lets the window go.
  expect(await r.s.close()).toBe(true);
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2);
  expect(r.api.saveMailDraft.mock.calls[1]![1].text).toBe("later");
});

test("isUnsaved compares the draft object, not its content: text typed away and back after a save is saved again", async () => {
  const r = rig();
  await r.writing();
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.c()!.savedDraft).toBe(r.c()!.draft);
  r.s.edit({ text: "Dear Ada!" });
  r.s.edit({ text: "Dear Ada" }); // same content as saved, but a new draft object
  expect(r.c()!.draft).toEqual(r.c()!.savedDraft);
  expect(await r.s.close()).toBe(true);
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2);
});

test("changing the sender removes the copy in the old account's Drafts (without attachments) before saving in the new one", async () => {
  const r = rig();
  await r.writing();
  await r.clk.advance(SAVE_DELAY_MS);
  r.s.edit({ accountId: A2 });
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.api.discardMailDraft).toHaveBeenCalledTimes(1);
  expect(r.api.discardMailDraft.mock.calls[0]![0]).toBe(A1);
  expect(r.api.discardMailDraft.mock.calls[0]![1].attachments).toEqual([]);
  const order = [
    r.api.discardMailDraft.mock.invocationCallOrder[0]!,
    r.api.saveMailDraft.mock.invocationCallOrder[1]!,
  ];
  expect(order[0]).toBeLessThan(order[1]!);
  expect(r.api.saveMailDraft.mock.calls[1]![0]).toBe(A2);
  expect(r.c()!.savedOn).toBe(A2);
});

test("staleOn: a sender changed while the first save is on its way is moved by the next save (old copy removed, new one saved)", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await hold.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  r.s.edit({ accountId: A2 });
  hold.resolve();
  await flush();
  // The first save landed in A1; the window now says A2, so it is unsaved.
  expect(r.c()!.savedOn).toBe(A1);
  expect(r.c()!.accountId).toBe(A2);
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.api.discardMailDraft.mock.calls.map((x) => x[0])).toEqual([A1]);
  expect(r.api.saveMailDraft.mock.calls.map((x) => x[0])).toEqual([A1, A2]);
  expect(r.c()!.savedOn).toBe(A2);
});

test("a save refused as already_sent turns the window into its sent state, not a failure to retry", async () => {
  const r = rig();
  await r.writing();
  r.api.saveMailDraft.mockRejectedValueOnce(refused("already_sent"));
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.c()!.sent).toEqual({ sentCopy: null });
  expect(r.c()!.save).toBe("idle");
  r.s.edit({ text: "after" });
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1); // never saved again
});

test("a save answer for a window that is no longer open does not touch the open one", async () => {
  const r = rig();
  await r.writing("First");
  const hold = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await hold.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  await r.s.send(); // closes into the countdown
  r.s.startNew();
  r.s.edit({ subject: "Second" });
  hold.resolve();
  await flush();
  expect(r.c()!.draft.subject).toBe("Second");
  expect(r.c()!.save).toBe("idle");
  expect(r.c()!.savedOn).toBeNull();
});

// ---- closing ----------------------------------------------------------------------------------

test("close waits for a save on its way, saves what is still unsaved, and lets go only when the server has it", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await hold.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  r.s.edit({ text: "typed during the save" });
  let closed: boolean | null = null;
  void r.s.close().then((v) => {
    closed = v;
  });
  await flush();
  expect(closed).toBeNull(); // still waiting for the save on its way
  expect(r.c()).not.toBeNull();
  hold.resolve();
  await flush();
  expect(closed).toBe(true);
  expect(r.c()).toBeNull();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2);
});

test("close keeps the window when its save fails", async () => {
  const r = rig();
  await r.writing();
  r.api.saveMailDraft.mockRejectedValue(refused("auth_failed", 502));
  expect(await r.s.close()).toBe(false);
  expect(r.c()!.save).toBe("failed");
  expect(r.c()!.saveCode).toBe("auth_failed");
});

test("close tries at most four rounds: text that keeps changing during each save keeps the window open", async () => {
  const r = rig();
  await r.writing();
  let round = 0;
  r.api.saveMailDraft.mockImplementation(async (_a, d) => {
    r.s.edit({ text: `edit ${++round}` });
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  expect(await r.s.close()).toBe(false);
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(4);
  expect(r.c()).not.toBeNull();
});

test("close of an untouched window needs no save and does not refresh the lists", async () => {
  const r = rig();
  await r.s.start();
  r.s.startNew();
  expect(await r.s.close()).toBe(true);
  expect(r.api.saveMailDraft).not.toHaveBeenCalled();
  expect(r.host.changed).toBe(0);
});

test("while a send request is in flight: edits and files are ignored, closing is refused, a second send does nothing", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<MailSendStatus>();
  r.api.startMailSend.mockImplementationOnce(() => hold.promise);
  const first = r.s.send();
  await flush();
  expect(r.c()!.sending).toBe(true);
  r.s.edit({ text: "changed" });
  r.s.attach([new File(["x"], "f.pdf")]);
  r.s.removeAttachment("anything");
  void r.s.send();
  expect(await r.s.close()).toBe(false);
  expect(r.c()!.draft.text).toBe("Dear Ada");
  expect(r.api.uploadMailAttachment).not.toHaveBeenCalled();
  expect(r.api.removeMailAttachment).not.toHaveBeenCalled();
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  hold.resolve(status({ sendId: "id-3" }));
  await first;
});

test("close while a file uploads keeps the window and says it is still uploading", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => hold.promise);
  r.s.attach([new File(["x"], "big.pdf")]);
  expect(await r.s.close()).toBe(false);
  expect(r.c()!.error).toBe("uploading");
  hold.resolve(staged("a1", "big.pdf"));
  await flush();
  expect(r.c()!.error).toBeNull();
  expect(r.c()!.attachments.map((a) => a.id)).toEqual(["a1"]);
  // A send while uploading is silently ignored.
  const h2 = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => h2.promise);
  r.s.attach([new File(["y"], "two.pdf")]);
  await r.s.send();
  expect(r.api.startMailSend).not.toHaveBeenCalled();
  expect(r.c()!.sending).toBe(false);
  h2.resolve(staged("a2", "two.pdf"));
  await flush();
});

test("a file over the per-file or per-message cap is refused in the window without uploading", async () => {
  const r = rig();
  await r.writing();
  const big = new File(["x"], "huge.bin");
  Object.defineProperty(big, "size", { value: 41 * 1024 * 1024 });
  r.s.attach([big]);
  expect(r.c()!.error).toBe("attachment_too_large");
  expect(r.c()!.errorName).toBe("huge.bin");
  expect(r.api.uploadMailAttachment).not.toHaveBeenCalled();
});

// ---- discarding -------------------------------------------------------------------------------

test("discard waits for the first save on its way and then deletes the copy it made", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<void>();
  r.api.saveMailDraft.mockImplementationOnce(async (_a, d) => {
    await hold.promise;
    return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
  });
  await r.clk.advance(SAVE_DELAY_MS);
  const result = r.s.discard();
  await flush();
  expect(r.api.discardMailDraft).not.toHaveBeenCalled();
  hold.resolve();
  expect(await result).toBeNull();
  expect(r.api.discardMailDraft).toHaveBeenCalledTimes(1);
  expect(r.api.discardMailDraft.mock.calls[0]![0]).toBe(A1);
  expect(r.c()).toBeNull();
  expect(r.host.changed).toBe(1);
});

test("discard and close wait for a save chained after the one on its way (dirty), not only for the first", async () => {
  for (const act of ["discard", "close"] as const) {
    const r = rig();
    await r.writing();
    const a = deferred<void>();
    const b = deferred<void>();
    r.api.saveMailDraft
      .mockImplementationOnce(async (_x, d) => {
        await a.promise;
        return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 1 };
      })
      .mockImplementationOnce(async (_x, d) => {
        await b.promise;
        return { messageId: d.messageId, savedAt: "x", folder: "Drafts", uid: 2 };
      });
    await r.clk.advance(SAVE_DELAY_MS); // save A starts
    r.s.edit({ text: "typed during A" });
    await r.clk.advance(SAVE_DELAY_MS); // A still on its way: marked dirty, B follows A
    let done = false;
    const p = (act === "discard" ? r.s.discard() : r.s.close()).then(() => {
      done = true;
    });
    a.resolve();
    await flush();
    expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2); // B is on its way now
    expect(done, act).toBe(false);
    expect(r.api.discardMailDraft).not.toHaveBeenCalled();
    expect(r.c(), act).not.toBeNull();
    b.resolve();
    await p;
    expect(r.c(), act).toBeNull();
    if (act === "discard") expect(r.api.discardMailDraft).toHaveBeenCalledTimes(1);
    else expect(r.api.saveMailDraft).toHaveBeenCalledTimes(2);
  }
});

test("discard after a save whose answer was lost (unreachable) still asks the server to delete a possible copy", async () => {
  const r = rig();
  await r.writing();
  r.api.saveMailDraft.mockRejectedValueOnce(down());
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.c()!.saveCode).toBe("unreachable");
  expect(await r.s.discard()).toBeNull();
  expect(r.api.discardMailDraft.mock.calls.map((x) => x[0])).toEqual([A1]);
  expect(r.api.removeMailAttachment).not.toHaveBeenCalled(); // the server copy may still use them
});

test("discard of a window the server never had removes its staged files and makes no server request", async () => {
  const r = rig();
  await r.writing();
  r.s.attach([new File(["x"], "a.pdf")]);
  await flush();
  r.api.saveMailDraft.mockRejectedValueOnce(refused("auth_failed", 502));
  await r.clk.advance(SAVE_DELAY_MS);
  expect(await r.s.discard()).toBeNull();
  expect(r.api.discardMailDraft).not.toHaveBeenCalled();
  expect(r.api.removeMailAttachment.mock.calls).toEqual([[A1, "up-1"]]);
});

test("a failed discard returns its code and keeps the window", async () => {
  const r = rig();
  await r.writing();
  await r.clk.advance(SAVE_DELAY_MS);
  r.api.discardMailDraft.mockRejectedValueOnce(refused("auth_failed", 502));
  expect(await r.s.discard()).toBe("auth_failed");
  expect(r.c()).not.toBeNull();
});

test("leaving Mail while a discard request runs does not save the discarded window back", async () => {
  const r = rig();
  await r.writing();
  await r.clk.advance(SAVE_DELAY_MS);
  r.s.edit({ text: "unsaved" });
  const hold = deferred<{ ok: true }>();
  r.api.discardMailDraft.mockImplementationOnce(() => hold.promise);
  const result = r.s.discard();
  await flush();
  r.s.dispose();
  hold.resolve({ ok: true });
  await result;
  await flush();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  expect(r.store.list).toEqual([]);
});

test("an upload that finishes after its window was discarded is removed again, without a notice", async () => {
  const r = rig();
  await r.writing();
  const hold = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => hold.promise);
  r.s.attach([new File(["x"], "late.pdf")]);
  await r.s.discard();
  r.s.startNew();
  hold.resolve(staged("late", "late.pdf"));
  await flush();
  expect(r.api.removeMailAttachment.mock.calls).toEqual([[A1, "late"]]);
  expect(r.c()!.attachments).toEqual([]);
  expect(r.notices()).toEqual([]);
});

test("an upload that finishes after its window was replaced otherwise is removed and reported as not added", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(refused("already_sent"));
  await r.s.send(); // the window is now a sent message's
  const hold = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => hold.promise);
  r.s.attach([new File(["x"], "late.pdf")]);
  r.s.copyAsNew(); // a new window (new uid) takes its place
  hold.resolve(staged("late", "late.pdf"));
  await flush();
  expect(r.api.removeMailAttachment.mock.calls).toEqual([[A1, "late"]]);
  expect(r.c()!.attachments).toEqual([]);
  expect(r.kinds()).toEqual(["attachmentDropped"]);
  expect(r.notices()[0]!.params.name).toBe("late.pdf");
});

// ---- sending ------------------------------------------------------------------------------------

test("sending without a recipient is refused in the window", async () => {
  const r = rig();
  await r.s.start();
  r.s.startNew();
  r.s.edit({ subject: "No one" });
  await r.s.send();
  expect(r.c()!.error).toBe("no_recipients");
  expect(r.api.startMailSend).not.toHaveBeenCalled();
});

test("an accepted send closes the window into a countdown followed by the tracker; the ticker runs only during windows", async () => {
  const r = rig();
  await r.writing();
  await r.clk.advance(500); // the pending delayed save is cancelled by the send
  await r.s.send();
  expect(r.api.saveMailDraft).not.toHaveBeenCalled();
  expect(r.c()).toBeNull();
  expect(r.tr.tracked).toHaveLength(1);
  expect(r.tr.tracked[0]!.sendId).toBe("id-3");
  expect(r.st().pendings).toMatchObject([{ sendId: "id-3", phase: "window", subject: "Hello" }]);
  expect(r.clk.intervals()).toBe(1);
  const before = r.st().now;
  await r.clk.advance(200);
  expect(r.st().now).toBe(before + 200);
  r.tr.emit("id-3", { phase: "sending" });
  expect(r.clk.intervals()).toBe(0);
});

// The seconds on the bar are `endsAt - now`, two readings of the clock: `now` must not be the older one.
test.each([0, 1, 7, 150])(
  "web-test-flake 02: a send accepted with 8 s left never shows more than 8 s (clock moving %i ms per reading)",
  async (step) => {
    const r = rig({ realTracker: { step } });
    await r.writing();
    await r.s.send();
    expect(r.st().pendings).toMatchObject([{ phase: "window", subject: "Hello" }]);
    expect(r.shownSeconds.length).toBeGreaterThan(0);
    expect(Math.max(...r.shownSeconds)).toBeLessThanOrEqual(8);
    expect(r.shownSeconds[0]).toBe(8);
  }
);

test.each([
  [0, 700],
  [1, 700],
  [0, 1500],
  [7, 300],
])(
  "web-test-flake 02: a window found in the outbox with 5 s left shows 5 s however long the outbox took (clock step %i ms, outbox %i ms)",
  async (step, loadMs) => {
    const r = rig({ realTracker: { step } });
    const outbox = deferred<{ sends: MailSendStatus[] }>();
    r.api.fetchMailOutbox.mockReturnValueOnce(outbox.promise);
    const started = r.s.start();
    await r.clk.advance(loadMs);
    outbox.resolve({ sends: [status({ sendId: "o-1", remainingMs: 5000, subject: "Counting" })] });
    await started;
    expect(r.st().pendings).toMatchObject([{ sendId: "o-1", phase: "window", subject: "Counting" }]);
    expect(r.shownSeconds[0]).toBe(5);
    expect(Math.max(...r.shownSeconds)).toBe(5);
  }
);

test("leaving Mail during a countdown stops the ticker", async () => {
  const r = rig();
  await r.writing();
  await r.s.send();
  expect(r.st().pendings.map((p) => p.phase)).toEqual(["window"]);
  expect(r.clk.intervals()).toBe(1);
  r.s.dispose();
  expect(r.clk.intervals()).toBe(0);
});

test("a definite send failure keeps the text in the window with the reason and no binding", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(refused("invalid_recipient", 422));
  await r.s.send();
  expect(r.c()!.sending).toBe(false);
  expect(r.c()!.error).toBe("invalid_recipient");
  expect(r.c()!.unconfirmed).toBeNull();
});

test("a send without an answer binds its id, account and content to the window and fixes the sender", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(down());
  await r.s.send();
  const c = r.c()!;
  expect(c.error).toBe("unreachable");
  expect(c.unconfirmed).toEqual({ accountId: A1, sendId: "id-3", sig: `${A1}\u0000${JSON.stringify(c.draft)}` });
  r.s.edit({ accountId: A2 });
  expect(r.c()!.accountId).toBe(A1);
  r.s.edit({ accountId: A2, text: "x" });
  expect(r.c()!.accountId).toBe(A1);
  expect(r.c()!.draft.text).toBe("x");
});

test("a send refused as already_sent turns the window into its sent state", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(refused("already_sent"));
  await r.s.send();
  expect(r.c()!.sent).toEqual({ sentCopy: null });
  expect(r.c()!.error).toBeNull();
});

test("a send failure for a window that is gone comes back as an offered composer, never over the open one", async () => {
  const r = rig();
  await r.writing("Gone");
  const hold = deferred<MailSendStatus>();
  r.api.startMailSend.mockImplementationOnce(() => hold.promise);
  const p = r.s.send();
  await flush();
  await r.s.discard(); // the window goes away while its send request is on its way
  r.s.startNew();
  r.s.edit({ subject: "Other" });
  hold.reject(refused("invalid_recipient", 422));
  await p;
  expect(r.c()!.draft.subject).toBe("Other");
  expect(r.kinds()).toEqual(["restoreFailed"]);
  expect(r.notices()[0]!.params).toEqual({ subject: "Gone", code: "invalid_recipient" });
  expect(r.notices()[0]!.tone).toBe("danger");
  expect(r.notices()[0]!.action!.label).toBe("openIt");
});

// ---- a send whose answer was lost: what the retry does (unconfirmed) ------------------------------

/** A window whose first send got no answer; then the text is changed (or not) and Send pressed again. */
async function lostThenRetry(r: ReturnType<typeof rig>, earlier: () => Promise<MailSendStatus>, change = true) {
  await r.writing("Twice", "Body");
  r.api.startMailSend.mockRejectedValueOnce(down());
  await r.s.send();
  const first = r.c()!.unconfirmed!.sendId;
  if (change) r.s.edit({ text: "Body (typo fixed)" });
  r.api.fetchMailSendStatus.mockImplementationOnce(earlier);
  await r.s.send();
  return first;
}

test("unconfirmed, earlier pending: the click joins it (no second send) and says later edits are not in it", async () => {
  const r = rig();
  const first = await lostThenRetry(r, async () => status({ sendId: "id-3", subject: "Twice", remainingMs: 6000 }));
  expect(first).toBe("id-3");
  expect(r.api.fetchMailSendStatus.mock.calls).toEqual([[A1, "id-3"]]);
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.kinds()).toEqual(["earlierAccepted"]);
  expect(r.c()).toBeNull();
  expect(r.tr.tracked.map((x) => x.sendId)).toEqual(["id-3"]);
});

test("unconfirmed, earlier sending with the same text: joined silently", async () => {
  const r = rig();
  await lostThenRetry(r, async () => status({ sendId: "id-3", state: "sending", remainingMs: null }), false);
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.kinds()).toEqual([]);
  expect(r.st().pendings.map((p) => p.phase)).toEqual(["sending"]);
});

test("unconfirmed, earlier sent: not sent again; the window turns into its sent state and the send is reported", async () => {
  const r = rig();
  await lostThenRetry(r, async () => status({ sendId: "id-3", state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false }));
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.c()!.sent).toEqual({ sentCopy: "saved" });
  expect(r.c()!.sending).toBe(false);
  expect(r.c()!.unconfirmed).toBeNull();
  expect(r.kinds()).toEqual(["sentNamed"]);
  expect(r.api.dismissMailSend.mock.calls).toEqual([[A1, "id-3"]]);
});

test("unconfirmed, earlier unknown: not sent again; the window says the outcome is unknown, the report stays", async () => {
  const r = rig();
  await lostThenRetry(r, async () => status({ sendId: "id-3", state: "unknown", remainingMs: null, code: "outcome_unknown" }));
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.c()!.error).toBe("outcome_unknown");
  expect(r.c()!.sent).toBeNull();
  expect(r.kinds()).toEqual(["unknown"]);
  expect(r.notices()[0]!.forget).toEqual({ accountId: A1, sendId: "id-3" });
  expect(r.api.dismissMailSend).not.toHaveBeenCalled();
});

test("ticket 43: unconfirmed, earlier failed with outcome_unknown counts as unknown: no dismiss, no second send", async () => {
  const r = rig();
  await lostThenRetry(r, async () => status({ sendId: "id-3", state: "failed", remainingMs: null, code: "outcome_unknown" }));
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.api.dismissMailSend).not.toHaveBeenCalled();
  expect(r.c()!.error).toBe("outcome_unknown");
  expect(r.c()!.sending).toBe(false);
  expect(r.c()!.unconfirmed).toBeNull();
  expect(r.kinds()).toEqual(["unknown"]);
  expect(r.notices()[0]!.forget).toEqual({ accountId: A1, sendId: "id-3" });
});

for (const ended of [
  status({ sendId: "id-3", state: "failed", remainingMs: null, code: "recipient_rejected" }),
  status({ sendId: "id-3", state: "cancelled", remainingMs: null }),
  status({ sendId: "id-3", state: "interrupted", remainingMs: null }),
]) {
  test(`unconfirmed, earlier ${ended.state} (${ended.code ?? "-"}): it did not go out, so it is dismissed and this click sends`, async () => {
    const r = rig();
    await lostThenRetry(r, async () => ended, false);
    expect(r.api.dismissMailSend.mock.calls).toEqual([[A1, "id-3"]]);
    expect(r.api.startMailSend).toHaveBeenCalledTimes(2);
    // The binding was let go: a fresh send id, even for the same text.
    expect(r.api.startMailSend.mock.calls[1]![1]).not.toBe("id-3");
    const order = [r.api.dismissMailSend.mock.invocationCallOrder[0]!, r.api.startMailSend.mock.invocationCallOrder[1]!];
    expect(order[0]).toBeLessThan(order[1]!);
  });
}

test("unconfirmed, the server has no such send (404): the same text reuses the send id, changed text gets a new one", async () => {
  const same = rig();
  await lostThenRetry(same, async () => Promise.reject(refused("not_found", 404)), false);
  expect(same.api.startMailSend.mock.calls.map((x) => x[1])).toEqual(["id-3", "id-3"]);
  expect(same.api.dismissMailSend).not.toHaveBeenCalled();
  const changed = rig();
  await lostThenRetry(changed, async () => Promise.reject(refused("not_found", 404)), true);
  const ids = changed.api.startMailSend.mock.calls.map((x) => x[1]);
  expect(ids[0]).toBe("id-3");
  expect(ids[1]).not.toBe("id-3");
});

test("unconfirmed, a retry that is refused keeps the earlier binding when it used a new id", async () => {
  const r = rig();
  r.api.startMailSend.mockRejectedValueOnce(down()); // the first send: no answer
  await r.writing("Twice", "Body");
  await r.s.send();
  r.s.edit({ text: "changed" });
  r.api.fetchMailSendStatus.mockRejectedValueOnce(refused("not_found", 404));
  r.api.startMailSend.mockRejectedValueOnce(refused("already_pending"));
  await r.s.send();
  expect(r.c()!.error).toBe("already_pending");
  expect(r.c()!.unconfirmed?.sendId).toBe("id-3");
});

test("unconfirmed, the status still cannot be learned: nothing is sent and the window keeps the reason", async () => {
  const r = rig();
  await lostThenRetry(r, async () => Promise.reject(down()));
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
  expect(r.c()!.sending).toBe(false);
  expect(r.c()!.error).toBe("unreachable");
  expect(r.c()!.unconfirmed?.sendId).toBe("id-3");
});

// ---- how a followed send ended ---------------------------------------------------------------------

async function accepted(r: ReturnType<typeof rig>, subject = "Hello") {
  await r.writing(subject, "Body text");
  await r.s.send();
  return r.tr.tracked[r.tr.tracked.length - 1]!.sendId;
}

test("sent without news: a short info notice, the server record is forgotten, the lists refresh", async () => {
  const r = rig();
  const id = await accepted(r);
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false }) });
  expect(r.tr.untracked).toEqual([id]);
  expect(r.st().pendings).toEqual([]);
  expect(r.kinds()).toEqual(["sentNamed"]);
  expect(r.notices()[0]!.autoCloseMs).toBe(4000);
  expect(r.api.dismissMailSend.mock.calls).toEqual([[A1, id]]);
  expect(r.host.changed).toBe(1);
});

for (const [name, over, params] of [
  ["no Sent copy", { sentCopy: "failed", draftKept: true }, { noCopy: true, draftKept: false, rejected: 0 }],
  ["a Drafts copy left", { sentCopy: "saved", draftKept: true }, { noCopy: false, draftKept: true, rejected: 0 }],
  ["refused recipients", { sentCopy: "saved", draftKept: false, rejected: 2 }, { noCopy: false, draftKept: false, rejected: 2 }],
] as const) {
  test(`sent with news (${name}): the warning stays with the server record until closed`, async () => {
    const r = rig();
    const id = await accepted(r);
    r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "sent", remainingMs: null, ...over }) });
    expect(r.kinds()).toEqual(["sentNamed", "sentWarnings"]);
    const w = r.notices()[1]!;
    expect(w.params).toEqual(params);
    expect(w.forget).toEqual({ accountId: A1, sendId: id });
    expect(r.api.dismissMailSend).not.toHaveBeenCalled();
    r.s.closeNotice(w.id);
    expect(r.api.dismissMailSend.mock.calls).toEqual([[A1, id]]);
  });
}

test("a definite failure brings the text back into a composer with the reason; nothing is saved as confirmed", async () => {
  const r = rig();
  const id = await accepted(r);
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "failed", remainingMs: null, code: "recipient_rejected" }) });
  const c = r.c()!;
  expect(c.draft.text).toBe("Body text");
  expect(c.error).toBe("recipient_rejected");
  expect(c.savedDraft).toBeNull();
  expect(c.savedOn).toBe(A1);
  expect(c.save).toBe("idle");
  expect(c.sending).toBe(false);
  expect(r.api.dismissMailSend.mock.calls).toEqual([[A1, id]]);
  expect(r.kinds()).toEqual([]);
});

test("a failure with outcome_unknown is reported as unknown, never as text to send again", async () => {
  const r = rig();
  const id = await accepted(r);
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "failed", remainingMs: null, code: "outcome_unknown" }) });
  expect(r.c()).toBeNull();
  expect(r.kinds()).toEqual(["unknown"]);
  expect(r.api.dismissMailSend).not.toHaveBeenCalled();
});

test("undone: the text comes back; interrupted: a warning with Open Drafts that keeps the record", async () => {
  const r = rig();
  const id = await accepted(r, "Undone");
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "cancelled", remainingMs: null }) });
  expect(r.c()!.draft.subject).toBe("Undone");
  expect(r.c()!.error).toBeNull();
  expect(r.host.changed).toBe(0);
  const r2 = rig();
  const id2 = await accepted(r2, "Stopped");
  r2.tr.emit(id2, { phase: "settled", status: status({ sendId: id2, state: "interrupted", remainingMs: null }) });
  expect(r2.kinds()).toEqual(["interrupted"]);
  expect(r2.notices()[0]!.forget).toEqual({ accountId: A1, sendId: id2 });
  r2.notices()[0]!.action!.run(r2.notices()[0]!.id);
  expect(r2.host.drafts).toEqual([A1]);
});

test("lost (the server forgot the send, or no end in time): a warning that the result is not confirmed", async () => {
  const r = rig();
  const id = await accepted(r);
  r.tr.emit(id, { phase: "lost" });
  expect(r.kinds()).toEqual(["statusLost"]);
  expect(r.notices()[0]!.params.subject).toBe("Hello");
});

test("a send is settled once, whichever report comes first", async () => {
  const r = rig();
  const id = await accepted(r);
  const end = status({ sendId: id, state: "sent", remainingMs: null, sentCopy: "saved", draftKept: false });
  r.tr.emit(id, { phase: "settled", status: end });
  r.tr.tracker.track(A1, id, end);
  r.tr.emit(id, { phase: "settled", status: end });
  expect(r.kinds()).toEqual(["sentNamed"]);
});

test("restore never replaces a composer the user is typing in: it is offered, and Open saves the open one first", async () => {
  const r = rig();
  const id = await accepted(r, "Back");
  r.s.startNew();
  r.s.edit({ subject: "Now typing" });
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "cancelled", remainingMs: null }) });
  expect(r.c()!.draft.subject).toBe("Now typing");
  expect(r.kinds()).toEqual(["restoreUndone"]);
  const n = r.notices()[0]!;
  n.action!.run(n.id);
  await flush();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  expect(r.c()!.draft.subject).toBe("Back");
  expect(r.notices()).toEqual([]);
});

test("Open of an offered composer keeps the open window (and the offer) when that window cannot be saved", async () => {
  const r = rig();
  const id = await accepted(r, "Back");
  r.s.startNew();
  r.s.edit({ subject: "Unsaveable" });
  r.api.saveMailDraft.mockRejectedValue(refused("auth_failed", 502));
  r.tr.emit(id, { phase: "settled", status: status({ sendId: id, state: "cancelled", remainingMs: null }) });
  const n = r.notices()[0]!;
  n.action!.run(n.id);
  await flush();
  expect(r.c()!.draft.subject).toBe("Unsaveable");
  expect(r.notices().map((x) => x.id)).toEqual([n.id]);
});

test("after a reload (no composer snapshot) a definite failure or an undo is a notice only", async () => {
  const r = rig();
  r.api.fetchMailOutbox.mockResolvedValueOnce({
    sends: [
      status({ sendId: "o-1", state: "failed", code: "recipient_rejected", remainingMs: null, subject: "Old" }),
      status({ sendId: "o-2", state: "cancelled", remainingMs: null, subject: "Older" }),
    ],
  });
  await r.s.start();
  expect(r.c()).toBeNull();
  expect(r.notices().map((n) => [n.kind, n.tone, n.params])).toEqual([
    ["error", "danger", { code: "recipient_rejected" }],
    ["undone", "info", {}],
  ]);
  expect(r.notices()[0]!.autoCloseMs).toBe(10000);
});

test("opening Mail: sends still running are followed again; ended ones are reported; the Copilot's are left alone", async () => {
  const r = rig();
  r.api.fetchMailOutbox.mockResolvedValueOnce({
    sends: [
      status({ sendId: "o-1", state: "pending", remainingMs: 5000, subject: "Counting" }),
      status({ sendId: "o-2", state: "unknown", code: "outcome_unknown", remainingMs: null, subject: "Maybe" }),
      status({ sendId: "o-3", state: "interrupted", remainingMs: null, origin: "copilot" }),
      status({ sendId: "o-4", state: "pending", remainingMs: 5000, origin: "copilot" }),
    ],
  });
  await r.s.start();
  expect(r.tr.tracked.map((x) => x.sendId)).toEqual(["o-1"]);
  expect(r.st().pendings).toMatchObject([{ sendId: "o-1", subject: "Counting", snapshot: null }]);
  expect(r.kinds()).toEqual(["unknown"]);
  expect(r.api.dismissMailSend).not.toHaveBeenCalled();
});

// ---- undo ------------------------------------------------------------------------------------------

test("undo goes through the tracker once per click burst and reports what it could not do", async () => {
  const r = rig();
  const id = await accepted(r);
  const hold = deferred<UndoResult>();
  r.tr.setUndo(() => hold.promise);
  const a = r.s.undo(id);
  const b = r.s.undo(id);
  hold.resolve("ownedElsewhere");
  await Promise.all([a, b]);
  expect(r.tr.undoCalls).toEqual([id]);
  expect(r.kinds()).toEqual(["ownedElsewhere"]);
  r.tr.setUndo(async () => "tooLate");
  await r.s.undo(id);
  r.tr.setUndo(async () => ({ error: "unreachable" }));
  await r.s.undo(id);
  expect(r.notices().map((n) => [n.kind, n.autoCloseMs])).toEqual([
    ["ownedElsewhere", 8000],
    ["tooLate", 6000],
    ["error", 8000],
  ]);
  await r.clk.advance(6000);
  expect(r.kinds()).toEqual(["ownedElsewhere", "error"]);
});

// ---- opening ------------------------------------------------------------------------------------------

test("reply asks the server for the threaded draft in the page language; a draft opened for editing counts as saved", async () => {
  const r = rig();
  await r.s.start();
  await r.s.startFrom("reply", message());
  expect(r.api.initMailCompose.mock.calls[0]).toEqual([A1, { mode: "reply", folder: "INBOX", uid: 3, uidValidity: 7, locale: "en" }]);
  expect(r.c()!.mode).toBe("reply");
  expect(r.c()!.touched).toBe(false);
  expect(r.st().busy).toBe(false);
  await r.s.close();
  await r.s.editDraft(message({ folder: "Drafts" }));
  expect(r.c()!.save).toBe("saved");
  expect(r.c()!.savedOn).toBe(A1);
  expect(r.c()!.savedDraft).toBe(r.c()!.draft);
});

test("initFailed: a composer that cannot be prepared says so for 8 s", async () => {
  const r = rig();
  await r.s.start();
  r.api.initMailCompose.mockRejectedValueOnce(refused("message_not_found", 404));
  await r.s.startFrom("forward", message());
  expect(r.c()).toBeNull();
  expect(r.notices().map((n) => [n.kind, n.tone, n.params.code, n.autoCloseMs])).toEqual([
    ["initFailed", "danger", "message_not_found", 8000],
  ]);
  expect(r.st().busy).toBe(false);
});

test("a reply that arrives while another composer is open is offered, not swapped in", async () => {
  const r = rig();
  await r.writing("Mine");
  await r.s.startFrom("reply", message());
  expect(r.c()!.draft.subject).toBe("Mine");
  expect(r.notices().map((n) => [n.kind, n.params.subject])).toEqual([["initReady", "Re: Subject 3"]]);
});

test("copy as new: a sent message's text under a new Message-ID; staged files come along only when restaged", async () => {
  const r = rig();
  await r.s.start();
  r.api.initMailCompose.mockResolvedValueOnce({
    draft: { ...(await fakeApi().initMailCompose()).draft, attachments: ["r1"] },
    attachments: [staged("r1")],
    sent: { sentCopy: "failed" },
  });
  await r.s.editDraft(message({ folder: "Drafts" }));
  expect(r.c()!.sent).toEqual({ sentCopy: "failed", restaged: true });
  const before = r.c()!;
  r.s.copyAsNew();
  const c = r.c()!;
  expect(c.sent).toBeNull();
  expect(c.uid).not.toBe(before.uid);
  expect(c.draft.messageId).toMatch(/^<id-\d+@example\.test>$/);
  expect(c.attachments.map((a) => a.id)).toEqual(["r1"]);
  expect(c.error).toBeNull();
  expect(c.savedOn).toBeNull();
  expect(c.touched).toBe(true);

  const r2 = rig();
  await r2.writing();
  r2.s.attach([new File(["x"], "gone.pdf")]);
  await flush();
  r2.api.startMailSend.mockRejectedValueOnce(refused("already_sent"));
  await r2.s.send();
  r2.s.copyAsNew();
  expect(r2.c()!.attachments).toEqual([]);
  expect(r2.c()!.draft.attachments).toEqual([]);
  expect(r2.c()!.error).toBe("attachments_readd");
  expect(r2.c()!.errorName).toBe("gone.pdf");
});

// ---- leaving Mail and the records kept in the tab -------------------------------------------------

test("leaving Mail saves what the server does not have; what cannot be saved is kept in the tab", async () => {
  const r = rig();
  await r.writing("Kept here", "words that must survive");
  r.api.saveMailDraft.mockRejectedValueOnce(down());
  r.s.dispose();
  await flush();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  expect(r.store.list).toMatchObject([{ kind: "unsaved", subject: "Kept here", code: "unreachable" }]);
  expect(r.store.list[0]!.state.draft.text).toBe("words that must survive");
  expect(r.store.list[0]!.rev).toBeTruthy();
  expect(r.tr.listeners()).toBe(0);
});

test("a kept record is offered on the next visit; Open lets go only of the version it took over", async () => {
  const store = memoryStore();
  const r = rig({ store });
  await r.writing("Kept", "text");
  r.api.saveMailDraft.mockRejectedValueOnce(down());
  r.s.dispose();
  await flush();
  const r2 = rig({ store });
  await r2.s.start();
  expect(r2.kinds()).toEqual(["leftUnsaved"]);
  const n = r2.notices()[0]!;
  expect(n.left).toMatchObject({ uid: store.list[0]!.uid, holdsText: true });
  // A newer version of the same record arrives before Open completes: it stays.
  const newer = { ...store.list[0]!, rev: "newer" };
  n.action!.run(n.id);
  store.list = [newer];
  await flush();
  expect(r2.c()!.draft.text).toBe("text");
  expect(r2.c()!.touched).toBe(true);
  expect(store.list).toEqual([newer]);
});

test("closing a notice that holds kept text asks first; only a confirmed drop deletes every version", async () => {
  const store = memoryStore();
  const r = rig({ store });
  await r.writing("Drop", "me");
  r.api.saveMailDraft.mockRejectedValueOnce(down());
  r.s.dispose();
  await flush();
  const r2 = rig({ store });
  await r2.s.start();
  const n = r2.notices()[0]!;
  r2.s.closeNotice(n.id);
  expect(r2.st().confirmDrop).toBe(n.left!.uid);
  expect(r2.notices()).toHaveLength(1);
  r2.s.cancelDrop();
  expect(r2.st().confirmDrop).toBeNull();
  expect(store.list).toHaveLength(1);
  r2.s.closeNotice(n.id);
  r2.s.dropLeft(n.left!.uid);
  expect(store.list).toEqual([]);
  expect(r2.notices()).toEqual([]);
});

test("a record made by a session that was already disposed reaches the session showing records now", async () => {
  const store = memoryStore();
  const r = rig({ store });
  await r.writing("Arrives late");
  const hold = deferred<MailSendStatus>();
  r.api.startMailSend.mockImplementationOnce(() => hold.promise);
  const p = r.s.send();
  await flush();
  r.s.dispose();
  const r2 = rig({ store });
  await r2.s.start();
  expect(r2.notices()).toEqual([]);
  r.api.saveMailDraft.mockRejectedValueOnce(refused("auth_failed", 502));
  hold.reject(refused("invalid_recipient", 422));
  await p;
  await flush();
  expect(r2.kinds()).toEqual(["leftNotSent"]);
  expect(store.list).toHaveLength(1);
  r2.s.dispose();
  expect(store.viewer).toBeNull();
});

for (const [name, sendError, saveError, kind] of [
  ["no answer, draft saved", down(), null, "unknown"],
  ["no answer, draft not saved", down(), refused("auth_failed", 502), "unknown"],
  ["refused, draft saved", refused("invalid_recipient", 422), null, "notSentSaved"],
  ["refused, saving refused as already pending", refused("invalid_recipient", 422), refused("already_pending"), "unknown"],
  ["refused, saving refused as already sent", refused("invalid_recipient", 422), refused("already_sent"), "unknown"],
  ["refused, draft not saved", refused("invalid_recipient", 422), refused("auth_failed", 502), "notSent"],
] as const) {
  test(`leaving Mail while a send is under way (${name}) keeps the text as ${kind}`, async () => {
    const r = rig();
    await r.writing("Left behind", "Body");
    const hold = deferred<MailSendStatus>();
    r.api.startMailSend.mockImplementationOnce(() => hold.promise);
    const p = r.s.send();
    await flush();
    r.s.dispose();
    if (saveError) r.api.saveMailDraft.mockRejectedValueOnce(saveError);
    hold.reject(sendError);
    await p;
    await flush();
    expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
    expect(r.store.list).toHaveLength(1);
    expect(r.store.list[0]!.kind).toBe(kind);
    expect(r.store.list[0]!.state.draft.text).toBe("Body");
    expect(r.store.list[0]!.state.sending).toBe(false);
    if (sendError.code === "unreachable") expect(r.store.list[0]!.state.unconfirmed?.sendId).toBe("id-3");
  });
}

test("leaving Mail with an unconfirmed send whose status cannot be learned keeps the text as unknown", async () => {
  const r = rig();
  await r.writing("Twice", "Body");
  r.api.startMailSend.mockRejectedValueOnce(down());
  await r.s.send();
  const hold = deferred<MailSendStatus>();
  r.api.fetchMailSendStatus.mockImplementationOnce(() => hold.promise);
  const p = r.s.send();
  await flush();
  r.s.dispose();
  hold.reject(down());
  await p;
  await flush();
  expect(r.store.list.map((x) => x.kind)).toEqual(["unknown"]);
  expect(r.api.startMailSend).toHaveBeenCalledTimes(1);
});

test("a late upload whose window's text exists only in the tab joins that record, after its save was decided", async () => {
  const r = rig();
  await r.writing("Only here", "words");
  const hold = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => hold.promise);
  r.s.attach([new File(["x"], "joins.pdf")]);
  r.api.saveMailDraft.mockRejectedValueOnce(down());
  r.s.dispose();
  hold.resolve(staged("e", "joins.pdf"));
  await flush();
  expect(r.store.list).toHaveLength(1);
  expect(r.store.list[0]!.state.attachments.map((a) => a.id)).toEqual(["e"]);
  expect(r.store.list[0]!.state.draft.attachments).toEqual(["e"]);
  expect(r.api.removeMailAttachment).not.toHaveBeenCalled();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1); // nothing written to the server for the file
});

test("a late upload whose window's text reached the server is removed and recorded as not added (never written to the server)", async () => {
  const r = rig();
  await r.writing("Saved", "words");
  const hold = deferred<MailStagedAttachment>();
  r.api.uploadMailAttachment.mockImplementationOnce(() => hold.promise);
  r.s.attach([new File(["x"], "late.pdf")]);
  r.s.dispose();
  hold.resolve(staged("c", "late.pdf"));
  await flush();
  expect(r.api.saveMailDraft).toHaveBeenCalledTimes(1);
  expect(r.api.saveMailDraft.mock.calls[0]![1].attachments).toEqual([]);
  expect(r.api.removeMailAttachment.mock.calls).toEqual([[A1, "c"]]);
  expect(r.store.list).toMatchObject([{ kind: "attachment", name: "late.pdf", subject: "Saved", code: null }]);
  expect(r.store.list[0]!.uid).toMatch(/^id-\d+:id-\d+$/);
  expect(r.store.list[0]!.state.draft.text).toBe("");
});

test("edits to a sent message are never saved; closing keeps them in the tab and offers them as a new message", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(refused("already_sent"));
  await r.s.send();
  r.s.edit({ text: "after sending" });
  await r.clk.advance(SAVE_DELAY_MS);
  expect(r.api.saveMailDraft).not.toHaveBeenCalled();
  expect(await r.s.close()).toBe(true);
  expect(r.store.list.map((x) => x.kind)).toEqual(["sentEdits"]);
  expect(r.kinds()).toEqual(["leftSentEdits"]);
  const n = r.notices()[0]!;
  n.action!.run(n.id);
  await flush();
  expect(r.c()!.draft.text).toBe("after sending");
  expect(r.c()!.sent).toBeNull();
  expect(r.store.list).toEqual([]);
});

test("leaving Mail with edits to a sent message keeps them once, without trying to save", async () => {
  const r = rig();
  await r.writing();
  r.api.startMailSend.mockRejectedValueOnce(refused("already_sent"));
  await r.s.send();
  r.s.edit({ text: "after sending" });
  r.s.dispose();
  await flush();
  expect(r.api.saveMailDraft).not.toHaveBeenCalled();
  expect(r.store.list.map((x) => x.kind)).toEqual(["sentEdits"]);
});

test("sessionLeftStore uses the tab's sessionStorage key and never throws", () => {
  sessionStorage.clear();
  const e = { uid: "u", kind: "unsaved", subject: "s", code: null, rev: "r" } as unknown as LeftBehind;
  sessionLeftStore.set([e]);
  expect(JSON.parse(sessionStorage.getItem(LEFT_KEY)!)).toEqual([e]);
  expect(LEFT_KEY).toBe("argelander.mail.leftBehind");
  sessionLeftStore.set([]);
  expect(sessionStorage.getItem(LEFT_KEY)).toBeNull();
  sessionStorage.setItem(LEFT_KEY, "{not json");
  expect(sessionLeftStore.get()).toEqual([]);
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    expect(() => sessionLeftStore.set([e])).not.toThrow();
  } finally {
    spy.mockRestore();
    sessionStorage.clear();
  }
});
