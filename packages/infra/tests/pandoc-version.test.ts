/**
 * Version-floor tests for the pandoc adapter (`src/latex/pandoc.ts`,
 * Stage 3.1 decision #9): `pandoc --version` output parsing, the 3.9 floor
 * comparison, and the actionable error — with the process layer mocked, so
 * every version string can be exercised regardless of the host's pandoc.
 */

import { describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  bin: "/fake/pandoc" as string | null,
  out: "",
  err: "",
  status: 0,
}));

vi.mock("../src/lib/proc.js", () => ({
  findOnPath: () => state.bin,
  runCapture: () => ({ status: state.status, stdout: state.out, stderr: state.err }),
}));

import {
  assertPandocVersion,
  PandocError,
  pandocMeetsFloor,
  parsePandocVersion,
} from "../src/latex/pandoc.js";

// assertPandocVersion memoizes per resolved binary — give each case its own
// fake path so the cache never leaks between tests.
let binSeq = 0;
function givenPandocVersion(out: string): void {
  binSeq += 1;
  state.bin = `/fake/pandoc-${binSeq}`;
  state.out = out;
  state.status = 0;
}

describe("parsePandocVersion", () => {
  test("parses the first line of `pandoc --version`", () => {
    expect(parsePandocVersion("pandoc 3.9.0.2\nFeatures: +server …")).toEqual([3, 9]);
    expect(parsePandocVersion("pandoc 3.1.3")).toEqual([3, 1]);
    expect(parsePandocVersion("pandoc 2.9.2.1")).toEqual([2, 9]);
    expect(parsePandocVersion("pandoc 4.0")).toEqual([4, 0]);
    expect(parsePandocVersion("pandoc.exe 3.6.4")).toEqual([3, 6]);
  });

  test("returns null for unrecognized output", () => {
    expect(parsePandocVersion("")).toBeNull();
    expect(parsePandocVersion("not pandoc at all")).toBeNull();
    expect(parsePandocVersion("pandoc unknown")).toBeNull();
  });
});

describe("pandocMeetsFloor", () => {
  test("3.9 is the floor", () => {
    expect(pandocMeetsFloor([3, 9])).toBe(true);
    expect(pandocMeetsFloor([3, 12])).toBe(true);
    expect(pandocMeetsFloor([4, 0])).toBe(true);
    expect(pandocMeetsFloor([3, 1])).toBe(false);
    expect(pandocMeetsFloor([2, 19])).toBe(false);
  });
});

describe("assertPandocVersion", () => {
  test("accepts pandoc >= 3.9", () => {
    givenPandocVersion("pandoc 3.9.0.2\n");
    expect(() => assertPandocVersion()).not.toThrow();
    givenPandocVersion("pandoc 3.12.1\n");
    expect(() => assertPandocVersion()).not.toThrow();
  });

  test("rejects an old pandoc with an actionable error", () => {
    givenPandocVersion("pandoc 3.1.3\n");
    expect(() => assertPandocVersion()).toThrow(PandocError);
    try {
      assertPandocVersion();
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("3.1.3"); // the found version
      expect(msg).toContain(state.bin); // …and its path
      expect(msg).toContain(">= 3.9"); // the floor
      expect(msg).toContain("shim"); // the remedy
      return;
    }
    throw new Error("expected assertPandocVersion to throw");
  });

  test("rejects pandoc 2.x and unparseable output", () => {
    givenPandocVersion("pandoc 2.9.2.1\n");
    expect(() => assertPandocVersion()).toThrow(PandocError);
    givenPandocVersion("garbage\n");
    expect(() => assertPandocVersion()).toThrow(/unparseable/);
    givenPandocVersion(""); // spawn failed
    state.status = 1;
    expect(() => assertPandocVersion()).toThrow(/unparseable/);
    state.status = 0;
  });

  test("no pandoc on PATH → the missing-pandoc error", () => {
    state.bin = null;
    expect(() => assertPandocVersion()).toThrow(/not installed/);
  });
});
