/**
 * The asynchronous zip writer (desktop-app ticket 14, the diagnostics bundle): the same archive as the synchronous
 * one, and the event loop keeps running while it compresses.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { extractZip } from "../src/lib/unzip.js";
import { zipEntries, zipEntriesAsync } from "../src/lib/zip.js";

test("the asynchronous writer makes the same archive as the synchronous one", async () => {
  const when = new Date(2026, 9, 14, 10, 11, 12);
  const entries = [
    { name: "a.txt", data: "hello\n" },
    { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 255]) },
  ];
  const sync = zipEntries(entries, when);
  const async = await zipEntriesAsync(entries, when);
  expect(Buffer.compare(sync, async)).toBe(0);
  const out = mkdtempSync(join(tmpdir(), "aspace-zip-async-"));
  try {
    extractZip(async, out);
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("hello\n");
    expect([...readFileSync(join(out, "dir/b.bin"))]).toEqual([0, 1, 2, 255]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("while a large entry is compressed, the event loop runs", async () => {
  const big = randomBytes(24 * 1024 * 1024);
  let ticks = 0;
  let done = false;
  const spin = (): void => {
    if (done) return;
    ticks += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  const zip = await zipEntriesAsync([{ name: "big.bin", data: big }]);
  done = true;
  expect(zip.length).toBeGreaterThan(big.length / 2);
  expect(ticks).toBeGreaterThan(5);
}, 45_000); // 24 MB of random bytes passes the 5s default when the package runs in parallel with other work
