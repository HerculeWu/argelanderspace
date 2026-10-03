/** A view action is delivered to exactly the sockets registered for that view id (real sockets). */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { WsHub } from "../src/ws.js";

const open = (port: number) =>
  new Promise<{ ws: WebSocket; got: Record<string, unknown>[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got: Record<string, unknown>[] = [];
    ws.on("message", (data) => got.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, got }));
    ws.on("error", reject);
  });

test("sendToView targets one registered view, never other tabs, and stops after unsubscribe", async () => {
  const server = createServer();
  const hub = new WsHub(server, { heartbeatMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const [one, two] = await Promise.all([open(port), open(port)]);
    const conversation = randomUUID();
    const viewOne = randomUUID();
    const viewTwo = randomUUID();
    one.ws.send(
      JSON.stringify({ type: "copilot.subscribe", conversationId: conversation, viewId: viewOne })
    );
    two.ws.send(
      JSON.stringify({ type: "copilot.subscribe", conversationId: conversation, viewId: viewTwo })
    );
    await expect
      .poll(
        () =>
          one.got.some((m) => m.type === "copilot.subscribed") &&
          two.got.some((m) => m.type === "copilot.subscribed")
      )
      .toBe(true);
    const action = {
      type: "copilot.view-action" as const,
      viewId: viewOne,
      actionId: randomUUID(),
      action: { action: "close_task" as const },
    };
    expect(hub.sendToView(viewOne, action)).toBe(true);
    await expect
      .poll(() => one.got.filter((m) => m.type === "copilot.view-action"))
      .toHaveLength(1);
    expect(two.got.some((m) => m.type === "copilot.view-action")).toBe(false);
    expect(hub.sendToView(randomUUID(), action)).toBe(false);
    one.ws.send(
      JSON.stringify({ type: "copilot.unsubscribe", conversationId: conversation, viewId: viewOne })
    );
    await expect.poll(() => hub.sendToView(viewOne, action), { interval: 20 }).toBe(false);
    one.ws.close();
    two.ws.close();
  } finally {
    hub.close();
    server.close();
  }
});

test("the hub tells the host which view id a socket registered, including after a reconnect", async () => {
  const seen: string[] = [];
  const server = createServer();
  const hub = new WsHub(server, {
    heartbeatMs: 0,
    onViewSubscribed: (viewId) => seen.push(viewId),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const view = randomUUID();
    const conversation = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const tab = await open(port);
      tab.ws.send(
        JSON.stringify({ type: "copilot.subscribe", conversationId: conversation, viewId: view })
      );
      await expect.poll(() => seen.length).toBe(attempt + 1);
      tab.ws.close();
    }
    expect(seen).toEqual([view, view]);
  } finally {
    hub.close();
    server.close();
  }
});
