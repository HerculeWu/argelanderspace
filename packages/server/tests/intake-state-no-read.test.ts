/**
 * The intake checklist's content is never read (project-intake ticket 06): the state comes from one `lstat`. The fs
 * entry points that would open or read a file are wrapped, and none may be called. (A mode-000 file cannot show this
 * when the tests run as root, so the calls are watched instead of the permission.)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTAKE_CHECKLIST_FILE } from "@argelanderspace/contracts";
import { afterAll, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const watch = <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    ((...args: Parameters<T>) => {
      reads.calls.push(name);
      return fn(...args);
    }) as T;
  return {
    ...real,
    default: real,
    readFileSync: watch("readFileSync", real.readFileSync),
    openSync: watch("openSync", real.openSync),
    readSync: watch("readSync", real.readSync),
    createReadStream: watch("createReadStream", real.createReadStream),
  };
});

const { intakeChecklistState } = await import("../src/intake-state.js");
const root = mkdtempSync(join(tmpdir(), "aspace-intake-noread-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a present checklist is reported without opening or reading it", () => {
  writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "- 状态：已完成\n");
  reads.calls.length = 0;
  expect(intakeChecklistState(root)).toBe("present");
  expect(reads.calls).toEqual([]);
});

test("the wrapper does see a read (the test can fail)", async () => {
  const { readFileSync } = await import("node:fs");
  reads.calls.length = 0;
  readFileSync(join(root, INTAKE_CHECKLIST_FILE));
  expect(reads.calls).toEqual(["readFileSync"]);
});
