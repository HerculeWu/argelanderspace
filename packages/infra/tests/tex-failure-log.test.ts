/**
 * What a failed compile leaves behind (desktop-app ticket 08): the run state latexmk would deadlock on is cleared
 * exactly as before, the same source compiles again at once, and — for a caller that asks — the complete log of
 * the failed run is kept as a file. Real compilations, gated on TeX Live being installed.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileTex, haveLatexmk, haveTexEngine } from "../src/tex/compile.js";
import { missingFilesFromTexLog, type TexCompileFailure } from "../src/tex/failure-log.js";

const LATEX = haveLatexmk() && haveTexEngine("pdflatex") && haveTexEngine("xelatex");
if (!LATEX) console.warn("latexmk/pdflatex/xelatex not on PATH — real-compile tests skipped");

const BROKEN = "\\documentclass{article}\n\\begin{document}\n\\nosuchcommandX\n\\end{document}\n";
const FIXED = "\\documentclass{article}\n\\begin{document}\nfine\n\\end{document}\n";
/** The files latexmk's recorded state lives in; a failed run has always removed exactly these. */
const RUN_STATE = ["aux", "bbl", "blg", "fdb_latexmk", "log"];

async function project(source: string) {
  const srcDir = await mkdtemp(join(tmpdir(), "tex-faillog-src-"));
  const mainTex = join(srcDir, "main.tex");
  await writeFile(mainTex, source);
  const outDir = await mkdtemp(join(tmpdir(), "tex-faillog-out-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "tex-faillog-cache-"));
  const keep = await mkdtemp(join(tmpdir(), "tex-faillog-keep-"));
  return { srcDir, mainTex, outDir, cacheDir, keep };
}

/** Every file of every engine profile of a stable cache, as `profile/name`. */
async function cacheFiles(cacheDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const profile of (await readdir(cacheDir)).sort())
    for (const name of (await readdir(join(cacheDir, profile))).sort())
      out.push(`${profile}/${name}`);
  return out;
}

describe("a failed compile: the clearing of latexmk's run state", () => {
  test.skipIf(!LATEX)(
    "removes the run-state files of every profile, keeps the inputs, and the same source compiles again at once",
    { timeout: 240_000 },
    async () => {
      const p = await project(BROKEN);
      const first = await compileTex({
        srcDir: p.srcDir,
        mainTex: p.mainTex,
        outDir: p.outDir,
        cacheDir: p.cacheDir,
      });
      expect(first.ok).toBe(false);
      const left = await cacheFiles(p.cacheDir);
      expect(left.map((f) => f.split("/")[0]).filter((v, i, a) => a.indexOf(v) === i)).toEqual([
        "pdflatex-clean",
        "pdflatex-instrumented",
        "xelatex-clean",
        "xelatex-instrumented",
      ]);
      for (const file of left) expect(RUN_STATE).not.toContain(file.split(".").pop());
      expect(left).toContain("pdflatex-clean/main.tex");

      // Retried at once: latexmk really runs again (it reports the TeX error, not "Nothing to do").
      const again = await compileTex({
        srcDir: p.srcDir,
        mainTex: p.mainTex,
        outDir: p.outDir,
        cacheDir: p.cacheDir,
      });
      expect(again).toEqual(first);
      if (!again.ok) expect(again.excerpt).toContain("Undefined control sequence");
      expect(await cacheFiles(p.cacheDir)).toEqual(left);

      // And once the source is right, the same cache compiles it.
      await writeFile(p.mainTex, FIXED);
      const fixed = await compileTex({
        srcDir: p.srcDir,
        mainTex: p.mainTex,
        outDir: p.outDir,
        cacheDir: p.cacheDir,
      });
      expect(fixed.ok).toBe(true);
    }
  );
});

describe("a failed compile: the complete log is kept for a caller that asks", () => {
  test.skipIf(!LATEX)(
    "the log of every failed attempt is in the file, the run state is cleared all the same, and the outcome is the one without it",
    { timeout: 240_000 },
    async () => {
      const plain = await project(BROKEN);
      const without = await compileTex({
        srcDir: plain.srcDir,
        mainTex: plain.mainTex,
        outDir: plain.outDir,
        cacheDir: plain.cacheDir,
      });
      const p = await project(BROKEN);
      const file = join(p.keep, "failure.log");
      const told: TexCompileFailure[] = [];
      const withLog = await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir, cacheDir: p.cacheDir },
        { failureLog: { file, onFailure: (failure) => void told.push(failure) } }
      );
      expect(withLog).toEqual(without);
      expect(await cacheFiles(p.cacheDir)).toEqual(await cacheFiles(plain.cacheDir));
      for (const left of await cacheFiles(p.cacheDir))
        expect(RUN_STATE).not.toContain(left.split(".").pop());

      const text = readFileSync(file, "utf8");
      // the whole log, not the excerpt: the banner of the engine, the error, and the line that caused it
      expect(text).toMatch(/This is pdfTeX/);
      expect(text).toMatch(/This is XeTeX/);
      expect(text).toContain("! Undefined control sequence.");
      expect(text).toContain("\\nosuchcommandX");
      expect(text.match(/^%% argelanderspace: latexmk attempt — /gm)).toHaveLength(4);
      expect(await readdir(p.keep)).toEqual(["failure.log"]);
      expect(told).toEqual([
        {
          kind: "compile-error",
          engine: "pdflatex",
          exitCode: 12,
          timedOut: false,
          missingFiles: [],
          logSaved: true,
        },
      ]);

      // a second failure replaces the file; a compile that then succeeds leaves the last failure's log alone
      const before = text;
      await writeFile(p.mainTex, BROKEN.replace("nosuchcommandX", "anotherMissingY"));
      await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir, cacheDir: p.cacheDir },
        { failureLog: { file } }
      );
      const second = readFileSync(file, "utf8");
      expect(second).not.toEqual(before);
      expect(second).toContain("anotherMissingY");
      expect(second).not.toContain("nosuchcommandX");
      await writeFile(p.mainTex, FIXED);
      const fixed = await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir, cacheDir: p.cacheDir },
        { failureLog: { file, onFailure: (failure) => void told.push(failure) } }
      );
      expect(fixed.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toEqual(second);
      expect(await readdir(p.keep)).toEqual(["failure.log"]);
      expect(told).toHaveLength(1);
    }
  );

  test.skipIf(!LATEX)(
    "names the files the log reports missing; a compile that fails on one engine only keeps nothing",
    { timeout: 240_000 },
    async () => {
      const p = await project(
        "\\documentclass{article}\n\\usepackage{nosuchpackagezz}\n\\begin{document}\nx\n\\end{document}\n"
      );
      const file = join(p.keep, "failure.log");
      const told: TexCompileFailure[] = [];
      const r = await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir },
        { failureLog: { file, onFailure: (failure) => void told.push(failure) } }
      );
      expect(r.ok).toBe(false);
      expect(told).toHaveLength(1);
      expect(told[0]?.missingFiles).toEqual(["nosuchpackagezz.sty"]);
      expect(told[0]?.logSaved).toBe(true);

      // xelatex-only source: pdflatex fails, xelatex succeeds — not a failed compile.
      const q = await project(
        "\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nx\n\\end{document}\n"
      );
      const qFile = join(q.keep, "failure.log");
      const ok = await compileTex(
        { srcDir: q.srcDir, mainTex: q.mainTex, outDir: q.outDir },
        { failureLog: { file: qFile, onFailure: (failure) => void told.push(failure) } }
      );
      expect(ok.ok).toBe(true);
      expect(await readdir(q.keep)).toEqual([]);
      expect(told).toHaveLength(1);
    }
  );

  test.skipIf(!LATEX)(
    "a place that cannot be written, or a keeper that throws, costs the log and nothing else",
    { timeout: 240_000 },
    async () => {
      const plain = await project(BROKEN);
      const without = await compileTex({
        srcDir: plain.srcDir,
        mainTex: plain.mainTex,
        outDir: plain.outDir,
      });
      const p = await project(BROKEN);
      const told: TexCompileFailure[] = [];
      const missingDir = await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir },
        {
          failureLog: {
            file: join(p.keep, "no-such-dir", "failure.log"),
            onFailure: (failure) => {
              told.push(failure);
              throw new Error("keeper");
            },
          },
        }
      );
      expect(missingDir).toEqual(without);
      expect(told.map((t) => t.logSaved)).toEqual([false]);

      // Something already standing where the collected log goes (a link to a file elsewhere) is replaced, not followed.
      const elsewhere = join(p.keep, "elsewhere.txt");
      await writeFile(elsewhere, "untouched");
      await mkdir(join(p.keep, "d"));
      await symlink(elsewhere, join(p.keep, "d", "failure.log.partial"));
      await symlink(elsewhere, join(p.keep, "d", "failure.log"));
      await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir },
        { failureLog: { file: join(p.keep, "d", "failure.log") } }
      );
      expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
      expect(readFileSync(join(p.keep, "d", "failure.log"), "utf8")).toContain(
        "! Undefined control sequence."
      );
      expect(existsSync(join(p.keep, "d", "failure.log.partial"))).toBe(false);
    }
  );
});

describe("missingFilesFromTexLog (pure)", () => {
  test("picks the quoted names of the usual reports, each once, in order", () => {
    const log = [
      "! LaTeX Error: File `nosuch.sty' not found.",
      "! Package pdftex.def Error: File `figs/plot one.pdf' not found: using draft setting.",
      "LaTeX Warning: File `plot' not found on input line 12.",
      "! I can't find file `chapter2'.",
      "! LaTeX Error: File `nosuch.sty' not found.",
      "! Font \\x=nosuchfont at 10.0pt not loadable: Metric (TFM) file not found.",
      "! Font \\y=otherfont not loadable: Metric (TFM) file or installed font not found.",
    ].join("\n");
    expect(missingFilesFromTexLog(log)).toEqual([
      "nosuch.sty",
      "figs/plot one.pdf",
      "plot",
      "chapter2",
      "nosuchfont.tfm",
      "otherfont.tfm",
    ]);
    expect(missingFilesFromTexLog("")).toEqual([]);
  });
  test("keeps at most 32 names", () => {
    const log = Array.from(
      { length: 50 },
      (_, i) => `! LaTeX Error: File \`p${i}.sty' not found.`
    ).join("\n");
    expect(missingFilesFromTexLog(log)).toHaveLength(32);
  });
});
