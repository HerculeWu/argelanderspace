/**
 * What a failed compile leaves behind (desktop-app ticket 08): the run state latexmk would deadlock on is cleared
 * exactly as before, the same source compiles again at once, and — for a caller that asks — the complete log of
 * the failed run is kept as a file. Real compilations, gated on TeX Live being installed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileTex, haveLatexmk, haveTexEngine } from "../src/tex/compile.js";
import {
  missingFilesFromTexLog,
  TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES,
  TEX_FAILURE_LOG_PART_MAX_BYTES,
  type TexCompileFailure,
  type TexFailedAttempt,
  TexFailureCapture,
} from "../src/tex/failure-log.js";

const LATEX = haveLatexmk() && haveTexEngine("pdflatex") && haveTexEngine("xelatex");
if (!LATEX) console.warn("latexmk/pdflatex/xelatex not on PATH — real-compile tests skipped");

/** biblatex is not part of every TeX Live installation. */
const BIBLATEX = LATEX && spawnSync("kpsewhich", ["biblatex.sty"]).status === 0;

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

describe("the kept file (no TeX needed)", () => {
  const attempt = (over: Partial<TexFailedAttempt> = {}): TexFailedAttempt => ({
    engine: "pdflatex",
    instrumented: true,
    exitCode: 12,
    timedOut: false,
    log: "engine log line\n",
    bibLog: "",
    stdout: "",
    stderr: "",
    ...over,
  });
  const keepDir = () => mkdtemp(join(tmpdir(), "tex-faillog-pure-"));
  const failure: Omit<TexCompileFailure, "logSaved"> = {
    kind: "compile-error",
    engine: "pdflatex",
    exitCode: 12,
    timedOut: false,
    missingFiles: [],
  };

  test("each attempt holds the engine's log, the bibliography program's log and latexmk's own output, each under its own marker", async () => {
    const dir = await keepDir();
    const file = join(dir, "failure.log");
    const capture = new TexFailureCapture({ file });
    await capture.add(
      attempt({
        bibLog: "I couldn't open style file nosuch.bst\n",
        stdout: "Latexmk: applying rule 'bibtex main'",
        stderr: "Latexmk: Errors, so I did not complete making targets\n",
      })
    );
    await capture.add(attempt({ engine: "xelatex", log: "" }));
    await capture.finish(failure);
    expect(readFileSync(file, "utf8")).toBe(
      [
        "%% argelanderspace: latexmk attempt — engine pdflatex, instrumented, exit code 12",
        "engine log line",
        "%% argelanderspace: bibliography log (.blg) of this attempt",
        "I couldn't open style file nosuch.bst",
        "%% argelanderspace: latexmk's standard output of this attempt",
        "Latexmk: applying rule 'bibtex main'",
        "%% argelanderspace: latexmk's standard error of this attempt",
        "Latexmk: Errors, so I did not complete making targets",
        "%% argelanderspace: latexmk attempt — engine xelatex, instrumented, exit code 12",
        "%% argelanderspace: no log was written",
        "",
      ].join("\n")
    );
    expect(await readdir(dir)).toEqual(["failure.log"]);
  });

  test("an attempt longer than the limit keeps the two ends of its engine log and says how many bytes were left out; the other parts keep theirs within their own smaller limit", async () => {
    const dir = await keepDir();
    const file = join(dir, "failure.log");
    const capture = new TexFailureCapture({ file });
    const over = 1000;
    const big =
      "HEAD-OF-LOG\n" + "x".repeat(TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES + over - 24) + "\nTAIL-OF-LOG";
    const side = `SIDE-HEAD\n${"y".repeat(TEX_FAILURE_LOG_PART_MAX_BYTES + 500 - 20)}\nSIDE-TAIL`;
    await capture.add(attempt({ log: big, bibLog: side, stdout: "short stdout\n" }));
    await capture.finish(failure);
    const text = readFileSync(file, "utf8");
    const size = Buffer.byteLength(text, "utf8");
    // the whole attempt stays within the limit, the markers aside
    expect(size).toBeLessThanOrEqual(TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES + 1024);
    expect(text).toContain("HEAD-OF-LOG");
    expect(text).toContain("TAIL-OF-LOG");
    expect(text).toContain("SIDE-HEAD");
    expect(text).toContain("SIDE-TAIL");
    expect(text).toContain("short stdout");
    // the engine log gives way to the other parts: what they hold is left out of it as well
    const sideKept = TEX_FAILURE_LOG_PART_MAX_BYTES + Buffer.byteLength("short stdout\n");
    expect(text).toContain(`\n%% argelanderspace: ${over + sideKept} bytes left out here\n`);
    expect(text).toContain("\n%% argelanderspace: 500 bytes left out here\n");
    expect(text.match(/bytes left out here/g)).toHaveLength(2);
  });

  test("a directory standing where the collected log goes is left alone, with what is in it; no log is kept", async () => {
    const dir = await keepDir();
    const file = join(dir, "failure.log");
    await mkdir(`${file}.partial`);
    await writeFile(join(`${file}.partial`, "inside.txt"), "untouched");
    const told: TexCompileFailure[] = [];
    const capture = new TexFailureCapture({ file, onFailure: (f) => void told.push(f) });
    await capture.add(attempt());
    await capture.finish(failure);
    expect(readFileSync(join(`${file}.partial`, "inside.txt"), "utf8")).toBe("untouched");
    expect(existsSync(file)).toBe(false);
    expect(told.map((t) => t.logSaved)).toEqual([false]);
    // … and when the compile did not fail after all
    const again = new TexFailureCapture({ file });
    await again.add(attempt());
    await again.discard();
    expect(readFileSync(join(`${file}.partial`, "inside.txt"), "utf8")).toBe("untouched");
  });
});

describe("missingFilesFromTexLog: the bibliography program's reports", () => {
  test("bibtex's style and database files, biber's data source", () => {
    expect(
      missingFilesFromTexLog(
        [
          "I couldn't open style file nosuchstylezz.bst",
          "---line 2 of file main.aux",
          "I couldn't open database file my refs.bib",
          "[90] Utils.pm:411> ERROR - Cannot find 'other.bib'!",
          "I couldn't open style file nosuchstylezz.bst",
        ].join("\n")
      )
    ).toEqual(["nosuchstylezz.bst", "my refs.bib", "other.bib"]);
  });
});

describe("a failed compile: the bibliography stage", () => {
  test.skipIf(!LATEX)(
    "with a keeper, the same source retried at once really compiles again: the second kept log is a full one too",
    { timeout: 240_000 },
    async () => {
      const p = await project(BROKEN);
      const file = join(p.keep, "failure.log");
      const run = () =>
        compileTex(
          { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir, cacheDir: p.cacheDir },
          { failureLog: { file } }
        );
      const first = await run();
      expect(first.ok).toBe(false);
      const left = await cacheFiles(p.cacheDir);
      await rm(file);
      const again = await run();
      expect(again).toEqual(first);
      expect(await cacheFiles(p.cacheDir)).toEqual(left);
      const text = readFileSync(file, "utf8");
      expect(text.match(/^%% argelanderspace: latexmk attempt — /gm)).toHaveLength(4);
      expect(text.match(/^! Undefined control sequence\.$/gm)?.length).toBeGreaterThanOrEqual(4);
      expect(text).not.toMatch(/Nothing to do/);
    }
  );

  test.skipIf(!LATEX || !BIBLATEX)(
    "a Writer render of a biber manuscript (biber is switched off there): the kept file says which command failed",
    { timeout: 240_000 },
    async () => {
      const p = await project(
        "\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n" +
          "\\begin{document}\nSee \\cite{k}.\n\\printbibliography\n\\end{document}\n"
      );
      await writeFile(
        join(p.srcDir, "refs.bib"),
        "@article{k, author={A. Author}, title={T}, journal={J}, year={2020}}\n"
      );
      const file = join(p.keep, "failure.log");
      const told: TexCompileFailure[] = [];
      const r = await compileTex(
        {
          srcDir: p.srcDir,
          mainTex: p.mainTex,
          outDir: p.outDir,
          cacheDir: p.cacheDir,
          renderProfile: "writer",
        },
        { failureLog: { file, onFailure: (failure) => void told.push(failure) } }
      );
      expect(r.ok).toBe(false);
      expect(told).toHaveLength(1);
      const text = readFileSync(file, "utf8");
      // the engine's log has no error of its own; what failed is in what latexmk printed
      const printed = text
        .split("%% argelanderspace: latexmk's standard output of this attempt\n")
        .slice(1)
        .map((part) => part.split("%% argelanderspace: ")[0])
        .join("\n");
      expect(printed).toMatch(/Running 'false\b/);
      expect(printed).toMatch(/Latexmk: Error return from 'biber main'/);
      expect(printed).toMatch(/biber main: Could not open biber log file for 'main'/);
    }
  );

  test.skipIf(!LATEX)(
    "a bibliography style that does not exist: bibtex's report is in the kept file and the style is among the missing files; the run state is cleared all the same",
    { timeout: 240_000 },
    async () => {
      const source =
        "\\documentclass{article}\n\\begin{document}\nSee \\cite{k}.\n\\bibliographystyle{nosuchstylezz}\n\\bibliography{refs}\n\\end{document}\n";
      const bib = "@article{k, author={A. Author}, title={T}, journal={J}, year={2020}}\n";
      const plain = await project(source);
      await writeFile(join(plain.srcDir, "refs.bib"), bib);
      const without = await compileTex({
        srcDir: plain.srcDir,
        mainTex: plain.mainTex,
        outDir: plain.outDir,
        cacheDir: plain.cacheDir,
      });
      const p = await project(source);
      await writeFile(join(p.srcDir, "refs.bib"), bib);
      const file = join(p.keep, "failure.log");
      const told: TexCompileFailure[] = [];
      const r = await compileTex(
        { srcDir: p.srcDir, mainTex: p.mainTex, outDir: p.outDir, cacheDir: p.cacheDir },
        { failureLog: { file, onFailure: (failure) => void told.push(failure) } }
      );
      expect(r.ok).toBe(false);
      expect(r).toEqual(without);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("I couldn't open style file nosuchstylezz.bst");
      expect(text).toMatch(/^%% argelanderspace: bibliography log \(\.blg\) of this attempt$/m);
      expect(text).toMatch(/^%% argelanderspace: latexmk's standard output of this attempt$/m);
      expect(text).toMatch(/Latexmk: /);
      expect(told).toHaveLength(1);
      expect(told[0]?.missingFiles).toContain("nosuchstylezz.bst");
      expect(told[0]?.logSaved).toBe(true);
      // the clearing removed what it always has, the .blg included
      const left = await cacheFiles(p.cacheDir);
      expect(left).toEqual(await cacheFiles(plain.cacheDir));
      for (const name of left) expect(RUN_STATE).not.toContain(name.split(".").pop());
    }
  );
});
