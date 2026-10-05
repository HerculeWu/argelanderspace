/**
 * An annotations store that cannot be read is a system error, never "no annotations" (docs/contracts.md: a store
 * that is damaged or unreadable is an unknown error, not zero). Only a truly absent current.json means "none yet".
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AnnotationsError, loadAnnotationsFile } from "../src/index.js";

test("an absent store is null, and nothing is created", () => {
  const dir = mkdtempSync(join(tmpdir(), "ann-unreadable-"));
  expect(loadAnnotationsFile(dir, "d")).toBeNull();
  mkdirSync(join(dir, "annotations", "d"), { recursive: true });
  expect(loadAnnotationsFile(dir, "d")).toBeNull();
});

test.each([
  ["the Doc's annotations directory is a file", ["annotations", "d"]],
  ["the annotations root is a file", ["annotations"]],
])("%s: a system error, and the blocking file keeps its bytes", (_name, parts) => {
  const dir = mkdtempSync(join(tmpdir(), "ann-unreadable-"));
  if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
  const blocking = join(dir, ...parts);
  writeFileSync(blocking, "not a directory");
  expect(() => loadAnnotationsFile(dir, "d")).toThrow(AnnotationsError);
  expect(readFileSync(blocking, "utf8")).toBe("not a directory");
});
