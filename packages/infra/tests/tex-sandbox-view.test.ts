/**
 * Which latexmk the Writer's sandbox would run (ticket 13 revision): the sandbox is not changed; the check says whether
 * it sees the TeX the workbench found. Constructed directories stand in for the system directories.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sandboxLatexmk, sandboxTexState } from "../src/tex/sandbox-view.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function setup() {
  const r = mkdtempSync(join(tmpdir(), "aspace-sbview-"));
  roots.push(r);
  const exe = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
    return join(dir, name);
  };
  return { r, exe };
}

describe("the sandbox's latexmk", () => {
  test("TeX only in the configured directory, none in the system directories: the sandbox finds none", () => {
    const { r, exe } = setup();
    const located = exe(join(r, "texbin"), "latexmk");
    const sys = join(r, "sys");
    mkdirSync(sys);
    // the TeX directory is under /tmp: never bound, even when it is on PATH
    expect(
      sandboxTexState(located, true, { hostPath: join(r, "texbin"), systemDirs: [sys] })
    ).toEqual({
      state: "not_found",
      latexmk: null,
    });
  });

  test("another TeX in the system directories: the sandbox uses that one", () => {
    const { r, exe } = setup();
    const located = exe(join(r, "texbin"), "latexmk");
    const other = exe(join(r, "sys"), "latexmk");
    expect(sandboxTexState(located, true, { hostPath: "", systemDirs: [join(r, "sys")] })).toEqual({
      state: "different",
      latexmk: other,
    });
  });

  test("the same file (through a link): same; no sandbox or no latexmk: not applicable", () => {
    const { r, exe } = setup();
    const target = exe(join(r, "sys"), "latexmk");
    mkdirSync(join(r, "links"));
    symlinkSync(target, join(r, "links", "latexmk"));
    expect(
      sandboxTexState(join(r, "links", "latexmk"), true, {
        hostPath: "",
        systemDirs: [join(r, "sys")],
      }).state
    ).toBe("same");
    expect(sandboxTexState(target, false, { systemDirs: [join(r, "sys")] }).state).toBe(
      "not_applicable"
    );
    expect(sandboxTexState(null, true, { systemDirs: [join(r, "sys")] }).state).toBe(
      "not_applicable"
    );
  });

  test("a file that is not executable is not latexmk", () => {
    const { r } = setup();
    mkdirSync(join(r, "sys"));
    writeFileSync(join(r, "sys", "latexmk"), "x");
    chmodSync(join(r, "sys", "latexmk"), 0o644);
    expect(sandboxLatexmk({ hostPath: "", systemDirs: [join(r, "sys")] })).toBeNull();
  });
});
