/**
 * Stage 10 M1 — the /ws dispatcher's explicit `writer.changed` branch: the
 * message must reach onWriterChanged listeners and must NOT fall through to
 * the job branch (the Stage-4/8 lesson: a bare else once fed non-job events
 * to job listeners). No existing ws test file — this is a new one.
 */

import { beforeAll, expect, it, vi } from "vitest";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
  send() {}
}

beforeAll(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

it("dispatches writer.changed to writer listeners, never to job listeners", async () => {
  const { onWriterChanged, onJobEvent } = await import("../src/api/ws");
  const writer = vi.fn();
  const job = vi.fn();
  onWriterChanged(writer);
  onJobEvent(job);
  const sock = FakeWebSocket.last!;
  expect(sock).toBeTruthy();

  const msg = { type: "writer.changed", cause: "put", id: "m_0123abcd", at: "2026-09-15T10:00:00.000Z" };
  sock.onmessage?.({ data: JSON.stringify(msg) });

  expect(writer).toHaveBeenCalledTimes(1);
  expect(writer.mock.calls[0]![0]).toMatchObject({ type: "writer.changed", id: "m_0123abcd" });
  expect(job).not.toHaveBeenCalled();

  // a template-dir change omits the id and still dispatches
  sock.onmessage?.({ data: JSON.stringify({ type: "writer.changed", cause: "template", at: "2026-09-15T10:01:00.000Z" }) });
  expect(writer).toHaveBeenCalledTimes(2);
  expect(job).not.toHaveBeenCalled();

  // sanity: a genuine job event still routes to job listeners only
  const fakeJob = {
    id: "j1",
    kind: "refresh",
    status: "done",
    createdAt: "x",
    startedAt: "x",
    finishedAt: "x",
    progress: [],
    result: null,
    error: null,
  };
  sock.onmessage?.({ data: JSON.stringify({ type: "job.done", job: fakeJob }) });
  expect(job).toHaveBeenCalledTimes(1);
  expect(writer).toHaveBeenCalledTimes(2);
});
