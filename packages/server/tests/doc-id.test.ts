/**
 * `badDocId` — the server's one Doc id path-traversal guard (Python
 * `_paper_path` / `get_image` parity), shared by app.ts, doc-delete.ts,
 * acquisition.ts and text-docs.ts. The empty string is NOT bad here: every
 * call site pairs the guard with its own `!id.trim()` check.
 */

import { describe, expect, test } from "vitest";
import { badDocId, badFileName } from "../src/doc-id.js";

describe("badDocId", () => {
  test("rejects a forward slash anywhere", () => {
    expect(badDocId("a/b")).toBe(true);
    expect(badDocId("/abs")).toBe(true);
    expect(badDocId("x/")).toBe(true);
  });

  test("rejects a backslash anywhere", () => {
    expect(badDocId("a\\b")).toBe(true);
    expect(badDocId("\\x")).toBe(true);
  });

  test("rejects a leading dot (hidden names, `.` and `..`)", () => {
    expect(badDocId(".hidden")).toBe(true);
    expect(badDocId(".")).toBe(true);
    expect(badDocId("..")).toBe(true);
  });

  test("accepts ordinary ids, including an inner dot", () => {
    expect(badDocId("2401.12345")).toBe(false);
    expect(badDocId("smith2020")).toBe(false);
    expect(badDocId("a.b")).toBe(false);
    expect(badDocId("a..b")).toBe(false);
  });

  test("the empty string and whitespace are not bad (call sites check `!trim()` separately)", () => {
    expect(badDocId("")).toBe(false);
    expect(badDocId("   ")).toBe(false);
  });

  test("badFileName is the same guard as badDocId", () => {
    expect(badFileName).toBe(badDocId);
  });
});
