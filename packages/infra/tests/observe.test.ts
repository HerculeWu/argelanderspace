/**
 * The observer of infra's external calls (lib/observe.ts): what it is told, and that being watched changes nothing
 * about a call — nor does a watcher that throws. Without an observer nothing is wrapped at all, which is why a CLI
 * command (it hands none in) behaves and prints exactly as before.
 */

import { expect, test } from "vitest";
import {
  type ExternalProgramCall,
  type ExternalServiceCall,
  observedFetch,
  runTexProcess,
} from "../src/index.js";

test("without an observer, the fetch that comes back is the one that went in", () => {
  const impl = (async () => new Response("x")) as typeof fetch;
  expect(observedFetch(impl, "ads", undefined)).toBe(impl);
  expect(observedFetch(impl, "ads", {})).toBe(impl);
});

test("an answered request: the very Response the implementation gave, reported by service, URL and status", async () => {
  const calls: ExternalServiceCall[] = [];
  const answer = new Response("the body", { status: 418 });
  let seenInit: RequestInit | undefined;
  const impl = (async (_input: unknown, init?: RequestInit) => {
    seenInit = init;
    return answer;
  }) as typeof fetch;
  const init = { headers: { Authorization: "Bearer secret" } };
  const watched = observedFetch(impl, "crossref", { service: (call) => calls.push(call) });
  const got = await watched("https://api.crossref.org/works/10.1/x?mailto=me@example.test", init);
  expect(got).toBe(answer);
  expect(got.bodyUsed).toBe(false);
  expect(seenInit).toBe(init);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ service: "crossref", status: 418 });
  expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["durationMs", "service", "status", "url"]);
});

test("a request without an answer: the same error is thrown on, and reported", async () => {
  const calls: ExternalServiceCall[] = [];
  const failure = new TypeError("fetch failed");
  const watched = observedFetch(
    (async () => {
      throw failure;
    }) as typeof fetch,
    "arxiv",
    { service: (call) => calls.push(call) }
  );
  await expect(watched("https://arxiv.org/e-print/2501.00001")).rejects.toBe(failure);
  expect(calls[0]).toMatchObject({ service: "arxiv", status: null, error: failure });
});

test("an observer that throws changes neither the answer nor the error", async () => {
  const boom = {
    service: () => {
      throw new Error("observer");
    },
    program: () => {
      throw new Error("observer");
    },
  };
  const answer = new Response("ok");
  expect(
    await observedFetch((async () => answer) as typeof fetch, "ads", boom)("https://x.test/")
  ).toBe(answer);
  const ran = await runTexProcess("sh", ["-c", "exit 0"], {
    timeoutMs: 5000,
    observe: { observer: boom, program: "gs" },
  });
  expect(ran.code).toBe(0);
});

test("a program run: its name, exit code and duration — and the same result as an unwatched run", async () => {
  const calls: ExternalProgramCall[] = [];
  const observer = { program: (call: ExternalProgramCall) => calls.push(call) };
  const args = ["-c", "echo out; echo err >&2; exit 3"];
  const plain = await runTexProcess("sh", args, { timeoutMs: 5000 });
  const watched = await runTexProcess("sh", args, {
    timeoutMs: 5000,
    observe: { observer, program: "latexmk", sandboxed: true },
  });
  expect(watched).toEqual(plain);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    program: "latexmk",
    sandboxed: true,
    exitCode: 3,
    signal: null,
    timedOut: false,
  });
  expect(Object.keys(calls[0] ?? {}).sort()).toEqual([
    "durationMs",
    "exitCode",
    "program",
    "sandboxed",
    "signal",
    "timedOut",
  ]);
});

test("a program that cannot be started: the rejection is the system's own, and it is reported", async () => {
  const calls: ExternalProgramCall[] = [];
  await expect(
    runTexProcess("/nonexistent/argelander-no-such-program", [], {
      timeoutMs: 5000,
      observe: { observer: { program: (call) => calls.push(call) }, program: "pdftocairo" },
    })
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(calls[0]).toMatchObject({ program: "pdftocairo", exitCode: null });
  expect(calls[0]?.error).toMatchObject({ code: "ENOENT" });
});

test("a run that times out is reported as timed out", async () => {
  const calls: ExternalProgramCall[] = [];
  const ran = await runTexProcess("sh", ["-c", "sleep 5"], {
    timeoutMs: 100,
    observe: { observer: { program: (call) => calls.push(call) }, program: "gs" },
  });
  expect(ran.timedOut).toBe(true);
  expect(calls[0]).toMatchObject({
    program: "gs",
    timedOut: true,
    exitCode: null,
    signal: "SIGKILL",
  });
});
