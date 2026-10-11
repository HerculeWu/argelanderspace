import type { Job, WsServerMessage } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBus, createWsBus } from "../src/api/ws-bus";

// A hand-driven stand-in for the browser WebSocket: the test opens, feeds and
// closes it; `send` records the frames the bus wrote.
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  frame(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  const bus = createWsBus(factory);
  const last = () => {
    const s = sockets[sockets.length - 1];
    if (!s) throw new Error("no socket yet");
    return s;
  };
  return { bus, factory, sockets, last };
}

const job = (id: string): Job => ({ id }) as unknown as Job;

// One representative frame per WsServerMessage type (the table is exhaustive,
// so this list is too: a missing key is a compile error in the bus, not here).
const FRAMES: Record<WsServerMessage["type"], WsServerMessage> = {
  "copilot.event": { type: "copilot.event", conversationId: "c1" } as unknown as WsServerMessage,
  "copilot.subscribed": { type: "copilot.subscribed", conversationId: "c1", viewId: "v1" } as unknown as WsServerMessage,
  "copilot.view-action": { type: "copilot.view-action", viewId: "v1" } as unknown as WsServerMessage,
  hello: { type: "hello", jobs: [] },
  "job.created": { type: "job.created", job: job("j1") },
  "job.progress": { type: "job.progress", job: job("j1") },
  "job.done": { type: "job.done", job: job("j1") },
  "job.failed": { type: "job.failed", job: job("j1") },
  "library.changed": { type: "library.changed", cause: "patch", at: "2026-10-11T00:00:00Z" },
  "plan.changed": { type: "plan.changed" } as unknown as WsServerMessage,
  "annotation.changed": { type: "annotation.changed", doc_id: "d1" } as unknown as WsServerMessage,
  "writer.changed": { type: "writer.changed" } as unknown as WsServerMessage,
  "pdf-reading-position.changed": { type: "pdf-reading-position.changed", doc_id: "d1" } as unknown as WsServerMessage,
  "text-source.changed": { type: "text-source.changed", doc_id: "d1" } as unknown as WsServerMessage,
  "text-doc.published": { type: "text-doc.published", doc_id: "d1" } as unknown as WsServerMessage,
  "mail.changed": { type: "mail.changed" } as unknown as WsServerMessage,
};
const TYPES = Object.keys(FRAMES) as WsServerMessage["type"][];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createWsBus: table dispatch", () => {
  it("delivers each type only to its own `on` listeners", () => {
    const { bus, last } = harness();
    const seen: string[] = [];
    for (const type of TYPES) bus.on(type, (msg) => seen.push(`${type}<-${msg.type}`));
    last().open();
    for (const type of TYPES) {
      seen.length = 0;
      last().frame(FRAMES[type]);
      expect(seen).toEqual([`${type}<-${type}`]);
    }
  });

  it("maps the four job.* types to the job channel with their event name, and nothing else", () => {
    const { bus, last } = harness();
    const events: [string, string][] = [];
    bus.onJob((j, event) => events.push([(j as unknown as { id: string }).id, event]));
    last().open();
    for (const type of TYPES) if (type !== "hello") last().frame(FRAMES[type]);
    expect(events).toEqual([
      ["j1", "job.created"],
      ["j1", "job.progress"],
      ["j1", "job.done"],
      ["j1", "job.failed"],
    ]);
  });

  it("never lets an unknown type fall into the job channel", () => {
    const { bus, last } = harness();
    const jobCb = vi.fn();
    bus.onJob(jobCb);
    last().open();
    last().frame({ type: "something.new", job: job("x") });
    last().frame({ type: "toString" });
    last().frame({ type: "__proto__" });
    last().frame({ job: job("y") });
    last().frame(5);
    expect(jobCb).not.toHaveBeenCalled();
  });

  it("swallows malformed frames and keeps the channel alive", () => {
    const { bus, last } = harness();
    const lib = vi.fn();
    bus.on("library.changed", lib);
    last().open();
    last().frame("{not json");
    last().frame("null");
    last().frame({ type: "hello" }); // a known type with a broken body
    last().frame(FRAMES["library.changed"]);
    expect(lib).toHaveBeenCalledTimes(1);
  });

  it("hello: resync listeners first, then the job snapshot replayed per job under the event name `hello`", () => {
    const { bus, last } = harness();
    const order: string[] = [];
    // Job listeners subscribe before the resync one: the order must still be resync first.
    bus.onJob((j, event) => order.push(`A:${(j as unknown as { id: string }).id}:${event}`));
    bus.onJob((j, event) => order.push(`B:${(j as unknown as { id: string }).id}:${event}`));
    bus.onResync(() => order.push("resync"));
    last().open();
    last().frame({ type: "hello", jobs: [job("j1"), job("j2")] });
    expect(order).toEqual(["resync", "A:j1:hello", "B:j1:hello", "A:j2:hello", "B:j2:hello"]);
  });

  it("off unsubscribes every channel", () => {
    const { bus, last } = harness();
    const lib = vi.fn();
    const jobCb = vi.fn();
    const resync = vi.fn();
    const offs = [bus.on("library.changed", lib), bus.onJob(jobCb), bus.onResync(resync)];
    last().open();
    for (const off of offs) off();
    last().frame(FRAMES["library.changed"]);
    last().frame(FRAMES["job.done"]);
    last().frame({ type: "hello", jobs: [job("j1")] });
    expect(lib).not.toHaveBeenCalled();
    expect(jobCb).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it("the same handler registered twice is delivered once (set semantics) and one off removes it", () => {
    const { bus, last } = harness();
    const lib = vi.fn();
    const off = bus.on("library.changed", lib);
    bus.on("library.changed", lib);
    last().open();
    last().frame(FRAMES["library.changed"]);
    expect(lib).toHaveBeenCalledTimes(1);
    off();
    last().frame(FRAMES["library.changed"]);
    expect(lib).toHaveBeenCalledTimes(1);
  });
});

describe("createWsBus: connection", () => {
  it("opens lazily, exactly once", () => {
    const { bus, factory } = harness();
    expect(factory).not.toHaveBeenCalled();
    bus.on("library.changed", () => {});
    bus.onJob(() => {});
    bus.start();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reconnects with exponential backoff 1s -> 15s, reset by a successful open", () => {
    const { bus, factory, last } = harness();
    bus.start();
    expect(factory).toHaveBeenCalledTimes(1);
    const delays = [1000, 2000, 4000, 8000, 15000, 15000];
    for (const [i, delay] of delays.entries()) {
      last().close();
      vi.advanceTimersByTime(delay - 1);
      expect(factory).toHaveBeenCalledTimes(i + 1);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(i + 2);
    }
    last().open();
    last().close();
    vi.advanceTimersByTime(1000);
    expect(factory).toHaveBeenCalledTimes(delays.length + 2);
  });

  it("a throwing factory schedules a retry", () => {
    let fail = true;
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => {
      if (fail) throw new Error("boom");
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    });
    const bus = createWsBus(factory);
    bus.start();
    fail = false;
    vi.advanceTimersByTime(1000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
  });

  it("onerror closes the socket, which reconnects", () => {
    const { bus, factory, last } = harness();
    bus.start();
    last().onerror?.();
    vi.advanceTimersByTime(1000);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("createWsBus: copilot subscriptions", () => {
  function sub(conversationId: string, viewId: string, withViewAction = true) {
    return {
      conversationId,
      viewId,
      event: vi.fn(),
      viewAction: withViewAction ? vi.fn() : undefined,
      ready: vi.fn(),
      connection: vi.fn(),
    };
  }

  it("sends subscribe when open, re-sends on every reopen, and unsubscribes on off", () => {
    const { bus, last } = harness();
    const s = sub("c1", "v1");
    const off = bus.subscribeCopilot(s);
    expect(last().sent).toEqual([]); // not open yet: nothing sent
    last().open();
    expect(last().sent).toEqual([{ type: "copilot.subscribe", conversationId: "c1", viewId: "v1" }]);
    last().close();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().sent).toEqual([{ type: "copilot.subscribe", conversationId: "c1", viewId: "v1" }]);
    off();
    expect(last().sent[last().sent.length - 1]).toEqual({ type: "copilot.unsubscribe", conversationId: "c1", viewId: "v1" });
  });

  it("subscribing on an already open socket sends immediately", () => {
    const { bus, last } = harness();
    bus.start();
    last().open();
    bus.subscribeCopilot(sub("c2", "v2"));
    expect(last().sent).toEqual([{ type: "copilot.subscribe", conversationId: "c2", viewId: "v2" }]);
  });

  it("connection(false) on close only; open never reports connection(true) (readiness comes from copilot.subscribed)", () => {
    const { bus, last } = harness();
    const s = sub("c1", "v1");
    bus.subscribeCopilot(s);
    last().open();
    expect(s.connection).not.toHaveBeenCalled();
    last().close();
    expect(s.connection).toHaveBeenCalledTimes(1);
    expect(s.connection).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1000);
    last().open();
    expect(s.connection).toHaveBeenCalledTimes(1);
  });

  it("copilot.event filters by conversationId; copilot.subscribed by conversation and view", () => {
    const { bus, last } = harness();
    const a = sub("c1", "v1");
    const b = sub("c2", "v2");
    bus.subscribeCopilot(a);
    bus.subscribeCopilot(b);
    last().open();
    last().frame({ type: "copilot.event", conversationId: "c1" });
    expect(a.event).toHaveBeenCalledTimes(1);
    expect(b.event).not.toHaveBeenCalled();
    last().frame({ type: "copilot.subscribed", conversationId: "c2", viewId: "v1" });
    expect(a.ready).not.toHaveBeenCalled();
    expect(b.ready).not.toHaveBeenCalled();
    last().frame({ type: "copilot.subscribed", conversationId: "c2", viewId: "v2" });
    expect(b.ready).toHaveBeenCalledTimes(1);
  });

  it("copilot.view-action goes to exactly one subscription of that view that can execute it", () => {
    const { bus, last } = harness();
    const noHandler = sub("c1", "v1", false);
    const first = sub("c2", "v1");
    const second = sub("c3", "v1");
    const other = sub("c1", "v9");
    for (const s of [noHandler, first, second, other]) bus.subscribeCopilot(s);
    last().open();
    last().frame({ type: "copilot.view-action", viewId: "v1" });
    expect(first.viewAction).toHaveBeenCalledTimes(1);
    expect(second.viewAction).not.toHaveBeenCalled();
    expect(other.viewAction).not.toHaveBeenCalled();
  });
});

describe("createFakeBus", () => {
  it("emit runs the same table without a socket", () => {
    const bus = createFakeBus();
    const order: string[] = [];
    bus.onResync(() => order.push("resync"));
    bus.onJob((_j, event) => order.push(event));
    bus.on("annotation.changed", (msg) => order.push(msg.doc_id));
    bus.emit("hello", { jobs: [job("j1")] });
    bus.emit("job.done", { job: job("j1") });
    bus.emit("annotation.changed", { doc_id: "d7" } as never);
    expect(order).toEqual(["resync", "hello", "job.done", "d7"]);
  });
});

describe("ws.ts forwarders over the default bus", () => {
  it("keeps every exported subscription's shape", async () => {
    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        function FakeWebSocket(this: unknown, url: string) {
          const s = new FakeSocket();
          (s as unknown as { url: string }).url = url;
          sockets.push(s);
          return s;
        },
        { OPEN: 1 },
      ),
    );
    vi.resetModules();
    const ws = await import("../src/api/ws");
    const got: unknown[] = [];
    const offs = [
      ws.onJobEvent((j, event) => got.push(["job", (j as unknown as { id: string }).id, event])),
      ws.onLibraryChanged((...args: unknown[]) => got.push(["library", args.length])),
      ws.onPlanChanged((...args: unknown[]) => got.push(["plan", args.length])),
      ws.onAnnotationChanged((docId) => got.push(["annotation", docId])),
      ws.onWriterChanged((msg) => got.push(["writer", msg.type])),
      ws.onTextSourceChanged((msg) => got.push(["text-source", msg.type])),
      ws.onTextDocPublished((msg) => got.push(["text-published", msg.type])),
      ws.onMailChanged(
        (msg) => got.push(["mail", msg.type]),
        () => got.push(["resync"]),
      ),
    ];
    expect(sockets).toHaveLength(1);
    expect((sockets[0] as unknown as { url: string }).url).toMatch(/^ws:\/\/.+\/ws$/);
    const s = sockets[0] as FakeSocket;
    s.open();
    s.frame({ type: "hello", jobs: [job("j0")] });
    for (const type of TYPES) if (type !== "hello") s.frame(FRAMES[type]);
    expect(got).toEqual([
      ["resync"],
      ["job", "j0", "hello"],
      ["job", "j1", "job.created"],
      ["job", "j1", "job.progress"],
      ["job", "j1", "job.done"],
      ["job", "j1", "job.failed"],
      ["library", 0],
      ["plan", 0],
      ["annotation", "d1"],
      ["writer", "writer.changed"],
      ["text-source", "text-source.changed"],
      ["text-published", "text-doc.published"],
      ["mail", "mail.changed"],
    ]);
    // A type outside the contracts union reaches nobody (formerly it fell into the job branch).
    got.length = 0;
    s.frame({ type: "something.new", job: job("x") });
    expect(got).toEqual([]);
    // One registration of the same listener stays one delivery; a single off removes it.
    const lib = vi.fn();
    const offA = ws.onLibraryChanged(lib);
    ws.onLibraryChanged(lib);
    s.frame(FRAMES["library.changed"]);
    expect(lib).toHaveBeenCalledTimes(1);
    offA();
    s.frame(FRAMES["library.changed"]);
    expect(lib).toHaveBeenCalledTimes(1);
    for (const off of offs) off();
    got.length = 0;
    for (const type of TYPES) s.frame(FRAMES[type]);
    expect(got).toEqual([]);
  });
});
