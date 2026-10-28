/**
 * `readLocalPdf` refuses a file whose length is not what its handle reported, or that changed while it was read,
 * instead of returning a prefix (project intake ticket 01, repair round). The two "changed" cases need the handle to
 * answer `fstat` differently from what is read, which a real file cannot be made to do on cue, so `fstatSync` is wrapped.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type StatPatch = (call: number, real: import("node:fs").Stats) => Record<string, unknown>;
let patch: StatPatch | null = null;
let fstatCalls = 0;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: (fd: number) => {
      const real = actual.fstatSync(fd);
      if (!patch) return real;
      fstatCalls += 1;
      return Object.assign(
        Object.create(Object.getPrototypeOf(real)),
        real,
        patch(fstatCalls, real)
      );
    },
  };
});

const { readLocalPdf } = await import("../src/local-pdf-source.js");

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-pdf-source-"));
  path = join(dir, "a.pdf");
  writeFileSync(path, Buffer.alloc(100, 7));
  patch = null;
  fstatCalls = 0;
});
afterEach(() => {
  patch = null;
  rmSync(dir, { recursive: true, force: true });
});

test("a stable file is returned whole", () => {
  const read = readLocalPdf(path);
  expect(read).toMatchObject({ ok: true, filename: "a.pdf" });
  expect(read.ok && read.bytes.length).toBe(100);
});

// Both fstat calls answer the same altered size, so the post-read recheck sees nothing changed: only the
// "read exactly `size` bytes, then probe one more" check can catch these.
test("a file longer than both fstat answers say (grown meanwhile) is refused, not cut to a prefix", () => {
  patch = (_call, real) => ({ size: real.size - 40 });
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "changed_while_reading" });
});

test("a file shorter than both fstat answers say (shrunk meanwhile) is refused", () => {
  patch = (_call, real) => ({ size: real.size + 40 });
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "changed_while_reading" });
});

test("a file longer by exactly one byte than the reported size is refused", () => {
  patch = (_call, real) => ({ size: real.size - 1 });
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "changed_while_reading" });
});

test("a rewrite that keeps the length but moves the modification time is refused", () => {
  patch = (call, real) => (call === 2 ? { mtimeMs: real.mtimeMs + 1000 } : {});
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "changed_while_reading" });
});

test("a size change seen by the second fstat is refused", () => {
  patch = (call, real) => (call === 2 ? { size: real.size + 1 } : {});
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "changed_while_reading" });
});

test.skipIf(!existsSync("/proc/self/status"))(
  "a pseudo-file that reports size 0 but has content is refused, not returned as a one-byte prefix",
  () => {
    expect(readLocalPdf("/proc/self/status")).toEqual({
      ok: false,
      reason: "changed_while_reading",
    });
  }
);

test("a real empty file is still empty", () => {
  writeFileSync(path, Buffer.alloc(0));
  expect(readLocalPdf(path)).toEqual({ ok: false, reason: "empty" });
});
