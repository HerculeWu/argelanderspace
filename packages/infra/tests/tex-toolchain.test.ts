/**
 * Where the workbench finds TeX and the other external programs (desktop-app ticket 13): the configured TeX directory,
 * then PATH, then the usual install locations of the platform. Every case builds its own directories under a temporary
 * root; macOS and Windows are given as the platform and a constructed layout — that checks the lookup logic, not the
 * real platforms.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  locateTool,
  locateToolchain,
  TOOLCHAIN_TOOLS,
  texChildEnv,
  texChildPath,
  texDirState,
} from "../src/tex/toolchain.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "aspace-toolchain-"));
  roots.push(r);
  return r;
}
function exe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\necho fake\n");
  chmodSync(p, 0o755);
  return p;
}

describe("lookup order on Linux", () => {
  test("the configured TeX directory comes before PATH", () => {
    const r = root();
    const configured = join(r, "configured");
    const onPath = join(r, "onpath");
    exe(configured, "latexmk");
    exe(onPath, "latexmk");
    const found = locateTool("latexmk", {
      texDir: configured,
      platform: "linux",
      env: { PATH: onPath },
    });
    expect(found).toEqual({ path: join(configured, "latexmk"), source: "tex_dir" });
  });

  test("PATH is used when the configured directory does not have the program", () => {
    const r = root();
    const configured = join(r, "configured");
    mkdirSync(configured);
    const onPath = join(r, "onpath");
    exe(onPath, "latexmk");
    expect(
      locateTool("latexmk", { texDir: configured, platform: "linux", env: { PATH: onPath } })
    ).toEqual({
      path: join(onPath, "latexmk"),
      source: "path",
    });
  });

  test("a file that is not executable is not a program", () => {
    const r = root();
    const onPath = join(r, "onpath");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "latexmk"), "not executable");
    chmodSync(join(onPath, "latexmk"), 0o644);
    expect(locateTool("latexmk", { platform: "linux", env: { PATH: onPath } })).toBeNull();
  });

  test("nothing anywhere: null, and the TeX directory state says what is wrong with it", () => {
    const r = root();
    const empty = join(r, "empty");
    mkdirSync(empty);
    expect(locateTool("latexmk", { platform: "linux", env: { PATH: empty } })).toBeNull();
    expect(texDirState(null, "linux")).toBe("unset");
    expect(texDirState(join(r, "nope"), "linux")).toBe("missing");
    expect(texDirState(empty, "linux")).toBe("no_latexmk");
    expect(texDirState("relative/dir", "linux")).toBe("not_absolute");
    exe(empty, "latexmk");
    expect(texDirState(empty, "linux")).toBe("ok");
  });

  test("the other programs are looked up on PATH; the TeX directory is only for TeX's programs", () => {
    const r = root();
    const configured = join(r, "configured");
    exe(configured, "pdftocairo");
    exe(configured, "gs");
    exe(configured, "bwrap");
    const chain = locateToolchain({
      texDir: configured,
      platform: "linux",
      env: { PATH: join(r, "none") },
    });
    expect(chain.tools.pdftocairo).toBeNull();
    expect(chain.tools.ghostscript).toBeNull();
    expect(chain.tools.bwrap?.source).not.toBe("tex_dir");
  });

  test("the toolchain reports every tool, the directory TeX is in, and the PATH latexmk is given", () => {
    const r = root();
    const tex = join(r, "texbin");
    const bin = join(r, "bin");
    for (const name of ["latexmk", "pdflatex", "xelatex", "bibtex", "biber"]) exe(tex, name);
    exe(bin, "pdftocairo");
    exe(bin, "gs");
    const chain = locateToolchain({ texDir: tex, platform: "linux", env: { PATH: bin } });
    expect(Object.keys(chain.tools)).toEqual([...TOOLCHAIN_TOOLS]);
    expect(chain.tools.latexmk?.source).toBe("tex_dir");
    expect(chain.tools.pdftocairo).toEqual({ path: join(bin, "pdftocairo"), source: "path" });
    expect(chain.tools.ghostscript).toEqual({ path: join(bin, "gs"), source: "path" });
    // bubblewrap: PATH, then the system directories the sandbox runs it from (found there or not, never elsewhere)
    expect([undefined, "common"]).toContain(chain.tools.bwrap?.source);
    expect(chain.texBinDir).toBe(tex);
    expect(texChildPath(chain, "/usr/bin:/bin", "linux")).toBe(`${tex}:/usr/bin:/bin`);
  });
});

describe("macOS (constructed layout, injected platform)", () => {
  // The layout lives under the temporary root; `fsPath` maps the macOS path onto it.
  const macFs = (r: string) => (p: string) => join(r, p);

  test("PATH comes before the usual install locations; MacTeX is found when PATH has no TeX", () => {
    const r = root();
    const fsPath = macFs(r);
    exe(fsPath("/Library/TeX/texbin"), "latexmk");
    exe(fsPath("/opt/homebrew/bin"), "pdftocairo");
    const opts = { platform: "darwin" as const, env: { PATH: "/Users/wu/bin" }, fsPath };
    expect(locateTool("latexmk", opts)).toEqual({
      path: posix.join("/Library/TeX/texbin", "latexmk"),
      source: "common",
    });
    expect(locateTool("pdftocairo", opts)).toEqual({
      path: "/opt/homebrew/bin/pdftocairo",
      source: "common",
    });
    exe(fsPath("/Users/wu/bin"), "latexmk");
    expect(locateTool("latexmk", opts)).toEqual({ path: "/Users/wu/bin/latexmk", source: "path" });
  });

  test("Homebrew's TeX Live (Intel prefix) is found", () => {
    const r = root();
    const fsPath = macFs(r);
    exe(fsPath("/usr/local/bin"), "xelatex");
    expect(locateTool("xelatex", { platform: "darwin", env: { PATH: "" }, fsPath })).toEqual({
      path: "/usr/local/bin/xelatex",
      source: "common",
    });
  });
});

describe("Windows (constructed layout, injected platform)", () => {
  // The layout is built with POSIX directories under the temporary root; the lookup joins with win32 rules, so the
  // file system is reached through the injected `fsPath` that maps a Windows path onto the temporary root.
  function windowsFs(r: string) {
    return (p: string) =>
      join(r, ...p.replace(/^[A-Za-z]:/, (d) => d.slice(0, 1).toUpperCase()).split(/[\\/]+/));
  }

  test("PATHEXT decides which file is the program; a name without an extension is not one", () => {
    const r = root();
    const fsPath = windowsFs(r);
    exe(fsPath("C:\\tools"), "latexmk");
    const opts = {
      platform: "win32" as const,
      env: { Path: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fsPath,
    };
    expect(locateTool("latexmk", opts)).toBeNull();
    exe(fsPath("C:\\tools"), "latexmk.EXE");
    expect(locateTool("latexmk", opts)).toEqual({
      path: win32.join("C:\\tools", "latexmk.EXE"),
      source: "path",
    });
  });

  test("an extension PATHEXT does not list is not a program; the default PATHEXT applies when it is unset", () => {
    const r = root();
    const fsPath = windowsFs(r);
    exe(fsPath("C:\\tools"), "biber.ps1");
    expect(
      locateTool("biber", { platform: "win32", env: { Path: "C:\\tools" }, fsPath })
    ).toBeNull();
    exe(fsPath("C:\\tools"), "biber.exe");
    expect(
      locateTool("biber", { platform: "win32", env: { Path: "C:\\tools" }, fsPath })?.path
    ).toBe(win32.join("C:\\tools", "biber.exe"));
  });

  test("the configured directory, then PATH, then TeX Live and MiKTeX install locations", () => {
    const r = root();
    const fsPath = windowsFs(r);
    const texLive = "C:\\texlive\\2025\\bin\\windows";
    const miktex = "C:\\Users\\wu\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64";
    exe(fsPath(miktex), "pdflatex.exe");
    const env = {
      Path: "C:\\empty",
      PATHEXT: ".EXE",
      LOCALAPPDATA: "C:\\Users\\wu\\AppData\\Local",
    };
    expect(locateTool("pdflatex", { platform: "win32", env, fsPath })).toEqual({
      path: win32.join(miktex, "pdflatex.exe"),
      source: "common",
    });
    exe(fsPath(texLive), "pdflatex.exe");
    // TeX Live's newest year comes before MiKTeX.
    expect(locateTool("pdflatex", { platform: "win32", env, fsPath })?.path).toBe(
      win32.join(texLive, "pdflatex.exe")
    );
    exe(fsPath("C:\\empty"), "pdflatex.exe");
    expect(locateTool("pdflatex", { platform: "win32", env, fsPath })?.source).toBe("path");
    exe(fsPath("D:\\tex"), "pdflatex.exe");
    expect(locateTool("pdflatex", { platform: "win32", env, fsPath, texDir: "D:\\tex" })).toEqual({
      path: win32.join("D:\\tex", "pdflatex.exe"),
      source: "tex_dir",
    });
  });

  test("Ghostscript is gswin64c on Windows, and its install directory is found", () => {
    const r = root();
    const fsPath = windowsFs(r);
    const gsBin = "C:\\Program Files\\gs\\gs10.03.1\\bin";
    exe(fsPath(gsBin), "gswin64c.exe");
    const env = { Path: "", PATHEXT: ".EXE", ProgramFiles: "C:\\Program Files" };
    expect(locateTool("ghostscript", { platform: "win32", env, fsPath })).toEqual({
      path: win32.join(gsBin, "gswin64c.exe"),
      source: "common",
    });
  });

  test("the child PATH puts the TeX directory first with the Windows delimiter", () => {
    const r = root();
    const fsPath = windowsFs(r);
    exe(fsPath("D:\\tex"), "latexmk.exe");
    const chain = locateToolchain({
      platform: "win32",
      env: { Path: "", PATHEXT: ".EXE" },
      fsPath,
      texDir: "D:\\tex",
    });
    expect(chain.texBinDir).toBe("D:\\tex");
    expect(texChildPath(chain, "C:\\Windows", "win32")).toBe("D:\\tex;C:\\Windows");
  });
});

describe("the PATH latexmk runs with (ticket 13 revision)", () => {
  test("found on PATH: the user's PATH is left as it is (a newer biber earlier on PATH is not shadowed)", () => {
    const r = root();
    const early = join(r, "early");
    const tex = join(r, "texlive");
    exe(early, "biber");
    for (const name of ["latexmk", "pdflatex", "biber"]) exe(tex, name);
    const chain = locateToolchain({ platform: "linux", env: { PATH: `${early}:${tex}` } });
    expect(chain.tools.latexmk).toEqual({ path: join(tex, "latexmk"), source: "path" });
    expect(chain.texBinDir).toBeNull();
    expect(texChildPath(chain, `${early}:${tex}`, "linux")).toBe(`${early}:${tex}`);
    expect(texChildEnv(chain, { PATH: `${early}:${tex}`, X: "1" }, "linux")).toEqual({
      PATH: `${early}:${tex}`,
      X: "1",
    });
    // what latexmk will run is what is reported: the biber that comes first on PATH
    expect(chain.tools.biber).toEqual({ path: join(early, "biber"), source: "path" });
  });

  test("found in the TeX directory or a usual place: that directory comes first", () => {
    const r = root();
    const tex = join(r, "texbin");
    exe(tex, "latexmk");
    const viaDir = locateToolchain({ texDir: tex, platform: "linux", env: { PATH: "/usr/bin" } });
    expect(texChildPath(viaDir, "/usr/bin", "linux")).toBe(`${tex}:/usr/bin`);
    const fsPath = (p: string) => join(r, "mac", p);
    exe(fsPath("/Library/TeX/texbin"), "latexmk");
    const viaCommon = locateToolchain({ platform: "darwin", env: { PATH: "/usr/bin" }, fsPath });
    expect(viaCommon.tools.latexmk?.source).toBe("common");
    expect(texChildPath(viaCommon, "/usr/bin", "darwin")).toBe("/Library/TeX/texbin:/usr/bin");
  });
});

describe("the engines are reported as latexmk will find them (ticket 13 revision)", () => {
  test("the TeX directory has engines but no latexmk: latexmk comes from PATH, and so do its engines", () => {
    const r = root();
    const tex = join(r, "texbin");
    const bin = join(r, "bin");
    exe(tex, "pdflatex");
    exe(tex, "xelatex");
    exe(bin, "latexmk");
    exe(bin, "pdflatex");
    const chain = locateToolchain({ texDir: tex, platform: "linux", env: { PATH: bin } });
    expect(chain.texDirState).toBe("no_latexmk");
    expect(chain.tools.latexmk).toEqual({ path: join(bin, "latexmk"), source: "path" });
    expect(chain.tools.pdflatex).toEqual({ path: join(bin, "pdflatex"), source: "path" });
    // xelatex is only in the TeX directory, which latexmk does not see: missing for the compile
    expect(chain.tools.xelatex).toBeNull();
  });

  test("latexmk in the TeX directory: an engine beside it comes from there, one that is not, from PATH", () => {
    const r = root();
    const tex = join(r, "texbin");
    const bin = join(r, "bin");
    exe(tex, "latexmk");
    exe(tex, "pdflatex");
    exe(bin, "pdflatex");
    exe(bin, "xelatex");
    const chain = locateToolchain({ texDir: tex, platform: "linux", env: { PATH: bin } });
    expect(chain.tools.pdflatex).toEqual({ path: join(tex, "pdflatex"), source: "tex_dir" });
    expect(chain.tools.xelatex).toEqual({ path: join(bin, "xelatex"), source: "path" });
  });
});

describe("Windows PATHEXT is read from the environment", () => {
  test("an extension the environment's PATHEXT lists counts; one the default lists but it does not, does not", () => {
    const r = root();
    const fsPath = (p: string) =>
      join(r, ...p.replace(/^[A-Za-z]:/, (d) => d.slice(0, 1).toUpperCase()).split(/[\\/]+/));
    exe(fsPath("C:\\tools"), "biber.ps1");
    exe(fsPath("C:\\tools"), "latexmk.exe");
    const env = { Path: "C:\\tools", PATHEXT: ".PS1" };
    expect(locateTool("biber", { platform: "win32", env, fsPath })?.path).toBe(
      win32.join("C:\\tools", "biber.ps1")
    );
    expect(locateTool("latexmk", { platform: "win32", env, fsPath })).toBeNull();
  });
});
