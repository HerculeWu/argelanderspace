// Test-only network guard. Installed as the *default* fetch / WebSocket /
// XMLHttpRequest of the happy-dom test environment. Tests that stub them
// (vi.stubGlobal, direct assignment) replace the guard for their duration and
// `vi.unstubAllGlobals` puts the guard back, so a request only reaches the guard
// when nothing mocked it.
//  - fetch / XMLHttpRequest: never connect. The attempt is recorded (URL, caller's
//    stack, and the test running at that moment) and the call fails with a message
//    naming the URL; tests/setup.ts then fails the test (or, for an attempt that
//    lands after a test's own afterEach, the file's afterAll).
//  - WebSocket: an inert socket that never connects. Each construction is recorded
//    and printed as a warning naming the URL and the test; it does not fail anything.
import { expect } from "vitest";

const attempts: string[] = [];
const sockets: string[] = [];

function callerStack(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  return lines
    .filter((l) => !l.includes("network-guard"))
    .slice(0, 6)
    .join("\n");
}

/** The test running when the call happens ("(between tests)" after one ended or before the first), so a late attempt is not blamed on the wrong one. */
function currentTest(): string {
  const { testPath, currentTestName } = expect.getState();
  const file = testPath?.split("/tests/").pop() ?? "unknown file";
  return currentTestName ? `${file} > ${currentTestName}` : `${file} (between tests)`;
}

function record(kind: string, url: string): Error {
  const message = `[network-guard] unmocked ${kind} ${url}`;
  attempts.push(`${message}\n  during: ${currentTest()}\n${callerStack()}`);
  return new Error(message);
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const maybe = input as { url?: unknown } | null;
  return typeof maybe?.url === "string" ? maybe.url : String(input);
}

function resolve(url: string): string {
  try {
    return new URL(url, globalThis.location?.href ?? "http://localhost/").href;
  } catch {
    return url;
  }
}

export function installNetworkGuard(): void {
  const guardedFetch = ((input: unknown) =>
    Promise.reject(record("fetch", resolve(urlOf(input))))) as unknown as typeof fetch;
  globalThis.fetch = guardedFetch;

  // The /ws channel is a live push channel, not request/response: with no
  // server, "nothing ever arrives" is the faithful default. This socket stays
  // CONNECTING forever and never touches the network (no ECONNREFUSED, no
  // reconnect-timer churn). Tests that need frames use createFakeBus or stub
  // WebSocket themselves.
  class InertWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    onopen: unknown = null;
    onmessage: unknown = null;
    onclose: unknown = null;
    onerror: unknown = null;
    constructor(readonly url: string | URL) {
      const where = currentTest();
      const target = resolve(String(url));
      sockets.push(`${target} (${where})`);
      console.warn(`[network-guard] WebSocket ${target} was opened with no WebSocket stub (inert, not connected); test: ${where}`);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;

  class GuardedXhr {
    open(method: string, url: string | URL): void {
      throw record(`XMLHttpRequest ${method}`, resolve(String(url)));
    }
  }
  globalThis.XMLHttpRequest = GuardedXhr as unknown as typeof XMLHttpRequest;
}

export function takeUnmockedNetworkAttempts(): string[] {
  return attempts.splice(0, attempts.length);
}

/** URLs of the inert WebSockets opened so far, with the test that opened each. */
export function webSocketsOpened(): readonly string[] {
  return sockets;
}
