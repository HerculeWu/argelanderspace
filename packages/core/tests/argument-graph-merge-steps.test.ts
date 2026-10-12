/**
 * Crash safety of the argument-graph move (ticket 06): between any two filesystem steps of a move at least one
 * complete copy of the graph is on disk under a published (non-scratch) name. A process killed between two steps
 * leaves exactly the state recorded at that boundary, so the invariant is checked at every boundary.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  before: (_op: string) => {},
  after: (_op: string) => {},
  fail: new Map<string, Error>(),
  /** replaces writeSync(fd, buffer, offset, length): returns the byte count it reports */
  write: null as null | ((real: (...a: unknown[]) => number, args: unknown[]) => number),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap =
    <K extends "linkSync" | "unlinkSync" | "renameSync" | "rmSync" | "fsyncSync">(name: K) =>
    (...args: unknown[]) => {
      hooks.before(name);
      const failure = hooks.fail.get(name);
      if (failure) throw failure;
      const result = (real[name] as (...a: unknown[]) => unknown)(...args);
      hooks.after(name);
      return result;
    };
  return {
    ...real,
    linkSync: wrap("linkSync"),
    unlinkSync: wrap("unlinkSync"),
    renameSync: wrap("renameSync"),
    rmSync: wrap("rmSync"),
    fsyncSync: wrap("fsyncSync"),
    writeSync: (...args: unknown[]) =>
      hooks.write !== null
        ? hooks.write(real.writeSync as unknown as (...a: unknown[]) => number, args)
        : (real.writeSync as unknown as (...a: unknown[]) => number)(...args),
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
  hooks.after = () => {};
  hooks.write = null;
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

  it("a short write that reports no progress: transfer_failed, original byte-identical, no survivor file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    const before = readFileSync(argumentGraphPath(dir, "c"));
    hooks.write = () => 0;
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note).toMatchObject({ outcome: "transfer_failed", error: "write_failed" });
    expect(readFileSync(argumentGraphPath(dir, "c")).equals(before)).toBe(true);
    expect(readdirSync(argumentGraphDir(dir))).toEqual([
      argumentGraphPath(dir, "c").split("/").pop(),
    ]);
  });

  it("partial writes that do report their counts are completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    hooks.write = (real, args) => {
      const [fd, buf, off, len] = args as [number, Buffer, number, number];
      return real(fd, buf, off, Math.min(len, 7));
    };
    expect(followWorkFolds(dir, [...fold])[0]?.outcome).toBe("moved");
    expect(loadArgumentGraph(dir, "a").arguments[0]?.title).toBe("the graph");
  });

  it("a write that claims everything but stored a prefix: the scratch file is not published, the original stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    const before = readFileSync(argumentGraphPath(dir, "c"));
    hooks.write = (real, args) => {
      const [fd, buf, off, len] = args as [number, Buffer, number, number];
      real(fd, buf, off, Math.floor(len / 2));
      return len; // lies
    };
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note).toMatchObject({ outcome: "transfer_failed" });
    expect(readFileSync(argumentGraphPath(dir, "c")).equals(before)).toBe(true);
    expect(readdirSync(argumentGraphDir(dir))).toHaveLength(1);
  });

  it("the published file does not read back as the graph: the original stays and our bad file is taken down", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    const before = readFileSync(argumentGraphPath(dir, "c"));
    hooks.after = (op) => {
      if (op === "linkSync") writeFileSync(argumentGraphPath(dir, "a"), '{"version":1,"rev":');
    };
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note).toMatchObject({ outcome: "transfer_failed", error: "write_failed" });
    expect(readFileSync(argumentGraphPath(dir, "c")).equals(before)).toBe(true);
    expect(readdirSync(argumentGraphDir(dir))).toEqual([
      argumentGraphPath(dir, "c").split("/").pop(),
    ]);
    expect(note?.survivor_file).toBe(argumentGraphPath(dir, "a"));
  });

  it("a readback mismatch where the survivor name is no longer our file leaves that file alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    hooks.after = (op) => {
      if (op === "linkSync") {
        // someone replaced the survivor's file by another file right after we published
        rmSync(argumentGraphPath(dir, "a"));
        writeFileSync(argumentGraphPath(dir, "a"), "somebody else's bytes");
      }
    };
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note?.outcome).toBe("transfer_failed");
    expect(readFileSync(argumentGraphPath(dir, "a"), "utf8")).toBe("somebody else's bytes");
    expect(loadArgumentGraph(dir, "c").arguments[0]?.title).toBe("the graph");
  });

  it("an empty survivor replaced by rename that does not read back: original stays, no bad file remains", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    const e = put(dir, "a", "x");
    replaceArgumentGraph(dir, { ...e, arguments: [], edges: [] });
    put(dir, "c", "the graph");
    const before = readFileSync(argumentGraphPath(dir, "c"));
    hooks.after = (op) => {
      if (op === "renameSync") writeFileSync(argumentGraphPath(dir, "a"), "{broken");
    };
    const note = followWorkFolds(dir, [...fold])[0];
    expect(note?.outcome).toBe("transfer_failed");
    expect(readFileSync(argumentGraphPath(dir, "c")).equals(before)).toBe(true);
    expect(readdirSync(argumentGraphDir(dir)).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(() => loadArgumentGraph(dir, "a")).not.toThrow(); // either missing (empty) or a valid graph, never a corrupt file
  });

  it("only a link error that means 'no hard links' falls back to rename; others fail with the original intact", () => {
    for (const code of ["EACCES", "ENOSPC", "EDQUOT", "EIO"]) {
      const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
      dirs.push(dir);
      put(dir, "c", "the graph");
      hooks.fail.set("linkSync", Object.assign(new Error(code), { code }));
      const note = followWorkFolds(dir, [...fold])[0];
      expect(note).toMatchObject({ outcome: "transfer_failed" });
      expect(loadArgumentGraph(dir, "c").arguments[0]?.title).toBe("the graph");
      expect(readdirSync(argumentGraphDir(dir))).toHaveLength(1);
    }
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
      const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
      dirs.push(dir);
      put(dir, "c", "the graph");
      hooks.fail.set("linkSync", Object.assign(new Error(code), { code }));
      expect(followWorkFolds(dir, [...fold])[0]?.outcome).toBe("moved");
    }
  });

  it("two lost rounds report what is true: an unreadable file is not 'both have a graph'", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argsteps-"));
    dirs.push(dir);
    put(dir, "c", "the graph");
    let n = 0;
    hooks.fail.set("linkSync", Object.assign(new Error("exists"), { code: "EEXIST" }));
    hooks.before = (op) => {
      // after each "lost" link, the survivor name appears as an EMPTY graph again so the loop retries
      if (op === "linkSync" && n++ < 3) {
        rmSync(argumentGraphPath(dir, "a"), { force: true });
      }
    };
    const note = followWorkFolds(dir, [...fold])[0];
    // survivor is absent (never occupied): neither kept nor moved
    expect(note?.outcome).toBe("transfer_failed");
    expect(loadArgumentGraph(dir, "c").arguments[0]?.title).toBe("the graph");
  });
});
