// The TeX runner per platform (desktop-app ticket 30 review): on Windows there are no process groups and a detached
// child gets a console window of its own, so the child is not detached, its window is hidden, and a kill ends the
// whole tree (latexmk's perl and the engines) with taskkill; elsewhere the child leads its own group and a kill is
// SIGKILL to the group.
import { describe, expect, it } from "vitest";
import { killTexTree, texSpawnFlags } from "../src/tex/proc.js";

describe("texSpawnFlags", () => {
  it("detaches into a process group on Unix, and never shows a window", () => {
    expect(texSpawnFlags("linux")).toEqual({ detached: true, windowsHide: true });
    expect(texSpawnFlags("darwin")).toEqual({ detached: true, windowsHide: true });
  });
  it("does not detach on Windows (a detached child would get a console window of its own)", () => {
    expect(texSpawnFlags("win32")).toEqual({ detached: false, windowsHide: true });
  });
});

describe("killTexTree", () => {
  function fakes() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        killGroup: (pid: number) => calls.push(`group ${pid}`),
        killChild: () => calls.push("child"),
        taskkill: (pid: number) => calls.push(`taskkill ${pid}`),
      },
    };
  }
  it("Unix: SIGKILL to the group; the child alone when that fails or there is no pid", () => {
    const a = fakes();
    killTexTree(42, "linux", a.deps);
    expect(a.calls).toEqual(["group 42"]);
    const b = fakes();
    killTexTree(42, "darwin", {
      ...b.deps,
      killGroup: () => {
        throw new Error("ESRCH");
      },
    });
    expect(b.calls).toEqual(["child"]);
    const c = fakes();
    killTexTree(undefined, "linux", c.deps);
    expect(c.calls).toEqual(["child"]);
  });
  it("Windows: the whole tree with taskkill, never a negative pid; the child alone when taskkill cannot start", () => {
    const a = fakes();
    killTexTree(42, "win32", a.deps);
    expect(a.calls).toEqual(["taskkill 42"]);
    const b = fakes();
    killTexTree(42, "win32", {
      ...b.deps,
      taskkill: () => {
        throw new Error("ENOENT");
      },
    });
    expect(b.calls).toEqual(["child"]);
    const c = fakes();
    killTexTree(undefined, "win32", c.deps);
    expect(c.calls).toEqual(["child"]);
  });
});
