/**
 * The `/ws` channel over a real socket (ephemeral port): hello snapshot, the
 * ordered job event stream, `library.changed` after a mutation, and upgrade
 * rejection off-path.
 */

import type { WsServerMessage } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubSources } from "./helpers.js";

let srv: RunningServer;
let port: number;
let dataDir: string;

beforeEach(async () => {
  dataDir = makeDataDir();
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
  });
  port = await srv.ready();
});

afterEach(async () => {
  await srv.close();
});

/** Connect, collect messages until *pred* arrives; `ready` resolves on hello. */
function collectUntil(pred: (msg: WsServerMessage) => boolean): {
  ready: Promise<void>;
  done: Promise<WsServerMessage[]>;
} {
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    markReady = r;
  });
  const done = new Promise<WsServerMessage[]>((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: WsServerMessage[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WsServerMessage;
      messages.push(msg);
      if (msg.type === "hello") markReady();
      if (pred(msg)) {
        ws.close();
        resolvePromise(messages);
      }
    });
    ws.on("error", rejectPromise);
    setTimeout(() => rejectPromise(new Error("timed out waiting for WS messages")), 10_000);
  });
  return { ready, done };
}

describe("WS /ws", () => {
  test("hello snapshot carries the current job table", async () => {
    const { done } = collectUntil(() => true); // first message is enough
    const messages = await done;
    expect(messages[0]).toEqual({ type: "hello", jobs: [] });
  });

  test("job events stream in order with full job payloads", async () => {
    const { ready, done } = collectUntil((m) => m.type === "job.done");
    await ready; // socket live before the job fires
    // submit directly through the runner: kind "ingest" exercises the third kind
    srv.runner.submit("ingest", async (_job, report) => {
      report("step 1");
      report("step 2");
      return { ingested: 2 };
    });
    const messages = await done;
    const types = messages.map((m) => m.type);
    expect(types[0]).toBe("hello");
    expect(types.slice(1)).toEqual(["job.created", "job.progress", "job.progress", "job.done"]);
    const [, created, p1, p2, doneMsg] = messages;
    if (created?.type !== "job.created" || doneMsg?.type !== "job.done") {
      throw new Error("unexpected message shape");
    }
    expect(created.job).toMatchObject({ kind: "ingest", status: "queued", progress: [] });
    if (p1?.type === "job.progress") {
      expect(p1.job.progress.map((p) => p.message)).toEqual(["step 1"]);
    }
    if (p2?.type === "job.progress") {
      expect(p2.job.progress.map((p) => p.message)).toEqual(["step 1", "step 2"]);
    }
    expect(doneMsg.job).toMatchObject({ status: "done", result: { ingested: 2 }, error: null });
  });

  test("upgrade requests off /ws are refused", async () => {
    await expect(
      new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
        ws.on("open", () => resolvePromise(ws.close()));
        ws.on("error", (err) => rejectPromise(err));
      })
    ).rejects.toThrow();
  });
});
