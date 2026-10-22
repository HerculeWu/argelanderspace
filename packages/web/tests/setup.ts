import { afterAll, afterEach } from "vitest";
import "../src/i18n";
import { installNetworkGuard, takeUnmockedNetworkAttempts } from "./network-guard";

// Any fetch / XMLHttpRequest that no test mocked fails here instead of dialling
// happy-dom's default origin (localhost:3000). An unstubbed WebSocket is inert
// and only warns (see network-guard.ts).
installNetworkGuard();

function failOnAttempts(where: string): void {
  const attempts = takeUnmockedNetworkAttempts();
  if (attempts.length > 0) {
    throw new Error(`Unmocked fetch / XMLHttpRequest ${where} (stub it in the test):\n${attempts.join("\n")}`);
  }
}
afterEach(() => failOnAttempts("in this test"));
// An attempt that lands after the last afterEach of the file still fails the file, with its own test name in the report.
afterAll(() => failOnAttempts("after the last test of this file"));
