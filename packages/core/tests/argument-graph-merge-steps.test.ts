/**
 * Crash safety of the argument-graph move (ticket 06): between any two filesystem steps of a move at least one
 * complete copy of the graph is on disk under a published (non-scratch) name. A process killed between two steps
 * leaves exactly the state recorded at that boundary, so the invariant is checked at every boundary.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  before: (_op: string) => {},
  fail: new Map<string, Error>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap =
    <K extends "linkSync" | "unlinkSync" | "renameSync" | "rmSync" | "fsyncSync">(name: K) =>
    (...args: unknown[]) => {
      hooks.before(name);
      const failure = hooks.fail.get(name);
      if (failure) throw failure;
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
  return {
    ...real,
    linkSync: wrap("linkSync"),
    unlinkSync: wrap("unlinkSync"),
    renameSync: wrap("renameSync"),
    rmSync: wrap("rmSync"),
    fsyncSync: wrap("fsyncSync"),
  };
});

import { followWorkFolds } from "../src/argument-graphs/merge.js";
import {
  argumentGraphDir,
  argumentGraphPath,
  loadArgumentGraph,
  replaceArgumentGraph,
} from "../src/argument-graphs/store.js";

const dirs: string[] = [];
afterEach(() => {
  hooks.before = () => {};
  hooks.fail.clear();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function put(dataDir: string, id: string, title: string): ArgumentGraph {
  const r = replaceArgumentGraph(dataDir, {
    version: 1,
    rev: 0,
    work_id: id,
    arguments: [
      {
        id: "a1",
        title,
        claim: "c",
        grounds: "",
        warrant: "",
        backing: "",
        qualifier: "",
        rebuttal: "",
        warrant_implicit: false,
        kind: "end",
        sources: [],
      },
    ],
    edges: [],
  });
  if (!("saved" in r)) throw new Error("fixture");
  return r.saved;
}

/** Published graph files (not scratch files) that hold the complete graph titled `title`. */
function completeCopies(dataDir: string, title: string): string[] {
  const dir = argumentGraphDir(dataDir);
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .filter((n) => {
      try {
        return (
          (JSON.parse(readFileSync(join(dir, n), "utf8")) as ArgumentGraph).arguments[0]?.title ===
          title
        );
      } catch {
        return false;
      }
    });
}

const fold = [{ absorbed: "c", survivor: "a", stored: true }];

describe("the move, step by step", () => {
  it("a complete copy exists at every step boundary; the end state has one file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    const boundaries: string[] = [];
    hooks.before = (op) => {
      boundaries.push(`${op}:${completeCopies(dir, "the graph").length}`);
      expect(completeCopies(dir, "the graph").length).toBeGreaterThanOrEqual(1);
    };
    const notes = followWorkFolds(dir, [...fold]);
    expect(notes[0]?.outcome).toBe("moved");
    expect(boundaries.some((b) => b.startsWith("linkSync"))).toBe(true);
    expect(boundaries.some((b) => b.startsWith("unlinkSync"))).toBe(true);
    // at the unlink the survivor and the original both hold it; afterwards only the survivor
    expect(boundaries.find((b) => b.startsWith("unlinkSync"))).toBe("unlinkSync:2");
    expect(completeCopies(dir, "the graph")).toHaveLength(1);
    expect(loadArgumentGraph(dir, "a").work_id).toBe("a");
  });

  it("neither link nor rename works: transfer_failed, the original untouched, no survivor file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    hooks.fail.set("linkSync", Object.assign(new Error("EIO"), { code: "EIO" }));
    hooks.fail.set("renameSync", Object.assign(new Error("EIO"), { code: "EIO" }));
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note).toMatchObject({ outcome: "transfer_failed", error: "write_failed" });
    expect(loadArgumentGraph(dir, "c").work_id).toBe("c");
    expect(completeCopies(dir, "the graph")).toEqual([readdirSync(argumentGraphDir(dir))[0]]);
    expect(readdirSync(argumentGraphDir(dir))).toHaveLength(1); // scratch file cleaned
  });

  it("hard links unsupported: the fallback renames the scratch file into place", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    hooks.fail.set("linkSync", Object.assign(new Error("EPERM"), { code: "EPERM" }));
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note?.outcome).toBe("moved");
    expect(loadArgumentGraph(dir, "a").arguments[0]?.title).toBe("the graph");
    expect(readdirSync(argumentGraphDir(dir))).toHaveLength(1);
  });

  it("the original cannot be removed after publishing: reported, the graph is under the survivor's name", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    hooks.fail.set("unlinkSync", Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note).toMatchObject({ outcome: "moved", absorbed_file_left: true });
    expect(loadArgumentGraph(dir, "a").arguments[0]?.title).toBe("the graph");
    expect(loadArgumentGraph(dir, "c").arguments[0]?.title).toBe("the graph");
    expect(argumentGraphPath(dir, "c")).toBe(note?.absorbed_file);
  });
});
