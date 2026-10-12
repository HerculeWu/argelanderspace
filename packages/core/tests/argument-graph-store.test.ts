/**
 * The argument-graph store (ADR 0009) against tmp dirs: file-name encoding of
 * work ids (reversible, slash-safe), first write, rev conflict without
 * overwrite, atomic write, and the system-error cases (corrupt / future
 * version / wrong Work) that must never read as "no graph" and never be
 * overwritten.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArgumentGraphFileError,
  argumentGraphDir,
  argumentGraphPath,
  decodeWorkIdFromFile,
  emptyArgumentGraph,
  encodeWorkIdForFile,
  listArgumentGraphWorkIds,
  loadArgumentGraph,
  replaceArgumentGraph,
} from "../src/argument-graphs/store.js";

const DOI = "doi:10.1051/0004-6361/202039341";

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-arggraph-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sample(workId = DOI, rev = 0): ArgumentGraph {
  return {
    version: 1,
    rev,
    work_id: workId,
    arguments: [
      {
        id: "a",
        title: "第一个",
        claim: "c",
        grounds: "g",
        warrant: "w",
        backing: "",
        qualifier: "",
        rebuttal: "",
        warrant_implicit: false,
        kind: "end",
        sources: [],
      },
    ],
    edges: [],
  };
}

describe("work id file-name encoding", () => {
  it("round-trips ids with colons, slashes, dots, unicode and percent signs", () => {
    for (const id of [
      DOI,
      "arxiv:2603.03522",
      "doi:10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2",
      "..",
      ".",
      "a/../b",
      "100%/x",
      "论文:一",
      "with space",
      "CON",
    ]) {
      const stem = encodeWorkIdForFile(id);
      expect(stem).toMatch(/^[A-Za-z0-9_%-]+$/);
      expect(decodeWorkIdFromFile(stem)).toBe(id);
    }
  });

  it("rejects ill-formed Unicode (lone surrogates) instead of colliding on U+FFFD", () => {
    for (const id of ["a\uD800b", "\uDC00", "x\uD83D"]) {
      expect(() => encodeWorkIdForFile(id)).toThrow(
        expect.objectContaining({ name: "ArgumentGraphFileError", kind: "unsafe_id" })
      );
    }
    expect(decodeWorkIdFromFile(encodeWorkIdForFile("😀"))).toBe("😀");
  });

  it("is injective on the cases that collide under naive schemes", () => {
    const stems = new Set(["a/b", "a:b", "a%2Fb", "a_b", "a-b", "a b"].map(encodeWorkIdForFile));
    expect(stems.size).toBe(6);
  });

  it("the path never leaves the graph directory", () => {
    const dir = argumentGraphDir("/data");
    for (const id of ["../../etc/passwd", "/abs", "a/b"]) {
      const p = argumentGraphPath("/data", id);
      expect(p.startsWith(`${dir}/`)).toBe(true);
      expect(p.slice(dir.length + 1)).not.toContain("/");
    }
  });

  it("rejects an empty or over-long id; decode refuses names the store would not write", () => {
    expect(() => encodeWorkIdForFile("")).toThrow(ArgumentGraphFileError);
    expect(() => encodeWorkIdForFile("/".repeat(100))).toThrow(ArgumentGraphFileError);
    // file name incl. ".json" <= 240: 235-char stem is the longest accepted
    expect(encodeWorkIdForFile("a".repeat(235))).toHaveLength(235);
    expect(() => encodeWorkIdForFile("a".repeat(236))).toThrow(ArgumentGraphFileError);
    for (const stem of ["", "a.b", "a%2", "a%zz", "a%41", "%FF", "a%2fb"]) {
      expect(decodeWorkIdFromFile(stem)).toBeNull();
    }
  });
});

describe("loadArgumentGraph", () => {
  it("a Work with no file is the empty graph at rev 0 (nothing is created)", () => {
    const dataDir = tmpDataDir();
    expect(loadArgumentGraph(dataDir, DOI)).toEqual(emptyArgumentGraph(DOI));
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

describe("replaceArgumentGraph", () => {
  it("first write: rev 0 → file at rev 1, pretty JSON in argument-graphs/, no tmp left", () => {
    const dataDir = tmpDataDir();
    const out = replaceArgumentGraph(dataDir, sample());
    expect(out).toEqual({ saved: sample(DOI, 1) });
    const dir = argumentGraphDir(dataDir);
    expect(readdirSync(dir)).toEqual([`${encodeWorkIdForFile(DOI)}.json`]);
    const text = readFileSync(argumentGraphPath(dataDir, DOI), "utf8");
    expect(text).toBe(JSON.stringify(sample(DOI, 1), null, 2));
    expect(loadArgumentGraph(dataDir, DOI)).toEqual(sample(DOI, 1));
    expect(listArgumentGraphWorkIds(dataDir)).toEqual([DOI]);
  });

  it("each Work has its own file", () => {
    const dataDir = tmpDataDir();
    replaceArgumentGraph(dataDir, sample("arxiv:1"));
    replaceArgumentGraph(dataDir, sample("arxiv:2"));
    expect(listArgumentGraphWorkIds(dataDir)).toEqual(["arxiv:1", "arxiv:2"]);
  });

  it("successive writes bump rev; a stale rev conflicts and leaves the file untouched", () => {
    const dataDir = tmpDataDir();
    replaceArgumentGraph(dataDir, sample());
    replaceArgumentGraph(dataDir, sample(DOI, 1));
    const before = readFileSync(argumentGraphPath(dataDir, DOI), "utf8");
    const changed = { ...sample(DOI, 1), arguments: [] };
    expect(replaceArgumentGraph(dataDir, changed)).toEqual({ conflictRev: 2 });
    expect(replaceArgumentGraph(dataDir, sample(DOI, 5))).toEqual({ conflictRev: 2 });
    // rev 0 on an existing graph is a conflict too (the "I thought there was none" caller)
    expect(replaceArgumentGraph(dataDir, sample(DOI, 0))).toEqual({ conflictRev: 2 });
    expect(readFileSync(argumentGraphPath(dataDir, DOI), "utf8")).toBe(before);
  });

  it("a missing graph conflicts for a caller claiming rev > 0", () => {
    expect(replaceArgumentGraph(tmpDataDir(), sample(DOI, 3))).toEqual({ conflictRev: 0 });
  });

  it("refuses a structurally invalid graph and writes nothing", () => {
    const dataDir = tmpDataDir();
    const bad = { ...sample(), edges: [{ from: "a", to: "a", role: "grounds" as const }] };
    expect(() => replaceArgumentGraph(dataDir, bad)).toThrow(/refusing to write/);
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

describe("unreadable files are system errors, never reset or overwritten", () => {
  function plant(dataDir: string, content: string): string {
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    const file = argumentGraphPath(dataDir, DOI);
    writeFileSync(file, content, "utf8");
    return file;
  }

  it("corrupt JSON", () => {
    const dataDir = tmpDataDir();
    const file = plant(dataDir, '{"version": 1, "rev": 4, "work_');
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ name: "ArgumentGraphFileError", kind: "corrupt" })
    );
    expect(() => replaceArgumentGraph(dataDir, sample())).toThrow(ArgumentGraphFileError);
    expect(readFileSync(file, "utf8")).toBe('{"version": 1, "rev": 4, "work_');
  });

  it("an unreadable file (a directory in its place) says so, not 'invalid JSON'", () => {
    const dataDir = tmpDataDir();
    mkdirSync(argumentGraphPath(dataDir, DOI), { recursive: true });
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({
        name: "ArgumentGraphFileError",
        kind: "corrupt",
        message: expect.stringContaining("could not be read"),
      })
    );
  });

  it("argument-graphs is a plain file: a system error with the errno code, not the empty graph", () => {
    const dataDir = tmpDataDir();
    writeFileSync(join(dataDir, "argument-graphs"), "x");
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({
        name: "ArgumentGraphFileError",
        kind: "corrupt",
        problem: { reason: "unreadable", code: "ENOTDIR" },
      })
    );
    expect(() => replaceArgumentGraph(dataDir, sample())).toThrow(ArgumentGraphFileError);
    expect(readFileSync(join(dataDir, "argument-graphs"), "utf8")).toBe("x");
  });

  it.skipIf(process.getuid?.() === 0)(
    "argument-graphs without permission: a system error (EACCES), not the empty graph",
    () => {
      const dataDir = tmpDataDir();
      const dir = argumentGraphDir(dataDir);
      mkdirSync(dir);
      chmodSync(dir, 0o000);
      try {
        expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
          expect.objectContaining({
            kind: "corrupt",
            problem: { reason: "unreadable", code: "EACCES" },
          })
        );
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  );

  it("only a missing file (also with no argument-graphs directory) is the empty graph", () => {
    const dataDir = tmpDataDir();
    expect(loadArgumentGraph(dataDir, DOI)).toEqual(emptyArgumentGraph(DOI));
    mkdirSync(argumentGraphDir(dataDir));
    expect(loadArgumentGraph(dataDir, DOI)).toEqual(emptyArgumentGraph(DOI));
  });

  it("a failed write reports the ORIGINAL error even when cleaning up the tmp path fails too", () => {
    const dataDir = tmpDataDir();
    mkdirSync(argumentGraphDir(dataDir));
    // the tmp path is a (non-empty) directory: writing to it fails with EISDIR, and rmSync on it fails as well
    const tmp = `${argumentGraphPath(dataDir, DOI)}.tmp`;
    mkdirSync(tmp);
    writeFileSync(join(tmp, "keep"), "x");
    let caught: unknown;
    try {
      replaceArgumentGraph(dataDir, sample());
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("EISDIR");
    expect((caught as Error).message).not.toMatch(/ERR_FS_EISDIR/);
    expect(readFileSync(join(tmp, "keep"), "utf8")).toBe("x");
    expect(readdirSync(argumentGraphDir(dataDir))).toEqual([
      `${encodeWorkIdForFile(DOI)}.json.tmp`,
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("a failed write leaves no tmp file behind", () => {
    const dataDir = tmpDataDir();
    const dir = argumentGraphDir(dataDir);
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    try {
      expect(() => replaceArgumentGraph(dataDir, sample())).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("the error carries structured reasons for each kind", () => {
    const dataDir = tmpDataDir();
    const file = plant(dataDir, "{oops");
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ file, problem: { reason: "not_json" } })
    );
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ problem: { reason: "schema" } })
    );
    writeFileSync(file, JSON.stringify({ version: 3 }));
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ problem: { reason: "future_version", version: 3 } })
    );
    writeFileSync(file, JSON.stringify(sample("arxiv:other", 1)));
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ problem: { reason: "wrong_work", workId: "arxiv:other" } })
    );
  });

  it("schema-invalid content", () => {
    const dataDir = tmpDataDir();
    const body = JSON.stringify({
      ...sample(DOI, 2),
      edges: [{ from: "a", to: "zz", role: "grounds" }],
    });
    const file = plant(dataDir, body);
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ kind: "corrupt" })
    );
    expect(() => replaceArgumentGraph(dataDir, sample(DOI, 2))).toThrow(ArgumentGraphFileError);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("a future version", () => {
    const dataDir = tmpDataDir();
    const body = JSON.stringify({ version: 2, rev: 9, work_id: DOI, layers: [] });
    const file = plant(dataDir, body);
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ kind: "future_version" })
    );
    expect(() => replaceArgumentGraph(dataDir, sample(DOI, 9))).toThrow(ArgumentGraphFileError);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("a file whose work_id is another Work", () => {
    const dataDir = tmpDataDir();
    plant(dataDir, JSON.stringify(sample("arxiv:other", 1)));
    expect(() => loadArgumentGraph(dataDir, DOI)).toThrow(
      expect.objectContaining({ kind: "wrong_work" })
    );
  });
});
