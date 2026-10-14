/**
 * The TeX directory in a real ingest (desktop-app ticket 13), with the real TeX of this machine: the configured
 * directory holds only links to the real programs, and PATH holds no TeX at all (only the two system programs latexmk
 * needs to start: perl and sh). The config is the isolated config.toml of this test file (isolate-user-dirs.ts), read
 * at each compile — a changed `tex_dir` applies to the next compile without anything being restarted.
 *
 * Also: with TeX nowhere, the ingest fails with the refusal it always had; without pdftocairo the figure is not
 * converted and the ingest still succeeds (no figures, as before).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { configFilePath } from "../src/config.js";
import { ingestTexSource } from "../src/tex/ingest.js";
import { locateTool, TEX_TOOLS } from "../src/tex/toolchain.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const ORIGINAL_PATH = process.env.PATH;
// The real programs, found before PATH is taken away.
const real = Object.fromEntries(
  [...TEX_TOOLS, "kpsewhich", "pdftex", "xetex", "perl", "sh"].map((name) => [
    name,
    (() => {
      for (const dir of (ORIGINAL_PATH ?? "").split(":")) {
        if (!dir) continue;
        try {
          const p = join(dir, name);
          readFileSync(p, { flag: "r" }).subarray(0, 1);
          return p;
        } catch {
          /* not here */
        }
      }
      return null;
    })(),
  ])
) as Record<string, string | null>;
const HAVE_TEX = locateTool("latexmk") !== null && real.pdflatex !== null && real.perl !== null;
if (!HAVE_TEX)
  console.warn(
    "no TeX on this machine — the TeX-directory ingest test is skipped (a skip is not a pass)"
  );

let root: string;
let texDir: string;
let sysDir: string;

const writeConfig = (text: string) => {
  mkdirSync(dirname(configFilePath()), { recursive: true });
  writeFileSync(configFilePath(), text);
};
const tomlString = (s: string) => JSON.stringify(s);

function source(name: string, body: string, files: Record<string, Buffer> = {}): string {
  const dir = join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tex"), body);
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aspace-texdir-ingest-"));
  texDir = join(root, "texbin");
  sysDir = join(root, "sys");
  mkdirSync(texDir);
  mkdirSync(sysDir);
  for (const name of [...TEX_TOOLS, "kpsewhich", "pdftex", "xetex"]) {
    const target = real[name];
    if (target) symlinkSync(target, join(texDir, name));
  }
  for (const name of ["perl", "sh"]) {
    const target = real[name];
    if (target) symlinkSync(target, join(sysDir, name));
  }
});
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(configFilePath(), { force: true });
});
afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(root, { recursive: true, force: true });
});

const DOC = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Intro}",
  "Zqx text from the TeX directory.",
  "\\end{document}",
  "",
].join("\n");

describe.skipIf(!HAVE_TEX)(
  "ingest with the configured TeX directory and no TeX on PATH (real TeX)",
  () => {
    test("the ingest compiles with the TeX of the configured directory", async () => {
      process.env.PATH = sysDir;
      expect(locateTool("latexmk")).toBeNull(); // not on PATH, and Linux has no usual places
      writeConfig(`tex_dir = ${tomlString(texDir)}\n`);
      const outRoot = join(root, "out1");
      const r = await ingestTexSource(source("one", DOC), {
        outRoot,
        docId: "texdir-one",
        assets: false,
      });
      expect(r.ir.sections.length).toBeGreaterThan(0);
      expect(readFileSync(r.jsonPath, "utf8")).toContain("Zqx text from the TeX directory.");
    }, 180_000);

    test("a changed TeX directory applies to the next compile, without a restart", async () => {
      process.env.PATH = sysDir;
      writeConfig(`tex_dir = ${tomlString(texDir)}\n`);
      const outRoot = join(root, "out2");
      await ingestTexSource(source("two", DOC), { outRoot, docId: "texdir-two", assets: false });
      // A second directory whose latexmk only leaves a mark and fails: the next compile runs it.
      const other = join(root, "other");
      mkdirSync(other);
      const mark = join(root, "other-latexmk-ran");
      writeFileSync(
        join(other, "latexmk"),
        `#!${real.sh}\necho ran > ${tomlString(mark)}\nexit 3\n`,
        { mode: 0o755 }
      );
      for (const name of ["pdflatex", "xelatex"])
        symlinkSync(join(texDir, name), join(other, name));
      writeConfig(`tex_dir = ${tomlString(other)}\n`);
      await expect(
        ingestTexSource(source("three", DOC), { outRoot, docId: "texdir-three", assets: false })
      ).rejects.toThrow();
      expect(readFileSync(mark, "utf8")).toBe("ran\n");
    }, 180_000);

    test("without pdftocairo the figure is not converted and the ingest still succeeds", async () => {
      process.env.PATH = sysDir;
      writeConfig(`tex_dir = ${tomlString(texDir)}\n`);
      const progress: string[] = [];
      const body = [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\begin{figure}\\includegraphics{fig.pdf}\\caption{A figure}\\end{figure}",
        "Zqx figure text.",
        "\\end{document}",
        "",
      ].join("\n");
      const dir = source("fig", body, { "fig.pdf": readFileSync(join(FIXTURES, "fig-text.pdf")) });
      const r = await ingestTexSource(dir, {
        outRoot: join(root, "out3"),
        docId: "texdir-fig",
        onProgress: (m) => progress.push(m),
      });
      expect(readFileSync(r.jsonPath, "utf8")).toContain("Zqx figure text.");
      expect(progress.join("\n")).toContain(
        "pdftocairo (poppler-utils) not on PATH; vector figure not converted"
      );
    }, 180_000);
  }
);

describe("TeX found nowhere", () => {
  test("the ingest fails with the refusal it had before the TeX directory existed", async () => {
    process.env.PATH = join(root, "nothing-here");
    writeConfig(`tex_dir = ${tomlString(join(root, "no-such-dir"))}\n`);
    await expect(
      ingestTexSource(source("none", DOC), {
        outRoot: join(root, "out4"),
        docId: "texdir-none",
        assets: false,
      })
    ).rejects.toThrow(
      // the whole message, as main (0ed83a6) words it: the same doc id prefix, kind and refusal
      /^texdir-none: TeX compile failed \(unsupported-build\): latexmk is not on PATH \(required for TeX ingest: TeX Live\)\n$/
    );
  }, 60_000);
});
