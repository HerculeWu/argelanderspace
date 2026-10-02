import { afterEach, expect, test, vi } from "vitest";
class Socket {
  static last: Socket;
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Socket.last = this; queueMicrotask(() => this.onopen?.()); }
  send(value: string) { this.sent.push(value); }
  close() {}
}
afterEach(() => vi.unstubAllGlobals());
test("Copilot acknowledgement/events use explicit dispatcher branches and preserve jobs", async () => {
  vi.stubGlobal("WebSocket", Socket);vi.resetModules();
  const { subscribeCopilot, onJobEvent } = await import("../src/api/ws");
  const event = vi.fn(), ready = vi.fn(), connection = vi.fn(), job = vi.fn();
  const unsubscribe = subscribeCopilot({ conversationId: "conversation", viewId: "view", event, ready, connection });const removeJob = onJobEvent(job);
  await Promise.resolve();const socket = Socket.last;
  expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "copilot.subscribe", conversationId: "conversation", viewId: "view" });
  socket.onmessage?.({ data: JSON.stringify({ type: "copilot.subscribed", conversationId: "conversation", viewId: "other" }) });expect(ready).not.toHaveBeenCalled();
  socket.onmessage?.({ data: JSON.stringify({ type: "copilot.subscribed", conversationId: "conversation", viewId: "view" }) });expect(ready).toHaveBeenCalledOnce();
  socket.onmessage?.({ data: JSON.stringify({ type: "copilot.event", conversationId: "conversation", kind: "stream", text: "chunk" }) });expect(event).toHaveBeenCalledOnce();expect(job).not.toHaveBeenCalled();
  socket.onmessage?.({ data: JSON.stringify({ type: "hello", jobs: [{ id: "job" }] }) });expect(job).toHaveBeenCalledOnce();expect(event).toHaveBeenCalledOnce();
  unsubscribe();removeJob();expect(JSON.parse(socket.sent[socket.sent.length-1]!)).toMatchObject({ type: "copilot.unsubscribe" });
});
