/**
 * Spec 14.1 for Render (copilot ticket 23): a REAL latexmk/pdflatex compile of a manuscript. TeX Live's default lets a
 * document \input any readable absolute path; the Writer compile now runs with paranoid file access, so text that got
 * past (or around) the agent-text screening still cannot read outside the compile workspace. Gated on the engine like
 * the other real-compile tests (a skip is not a pass).
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriterManuscript, WriterNumberingResponse } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { compileTex, haveLatexmk, writerTexEnv } from "@argelanderspace/infra";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { stubPipelines, stubSources } from "./helpers.js";

const HAVE = haveLatexmk();
if (!HAVE) console.warn("latexmk not on PATH — writer render-safety real-compile test skipped");

describe.skipIf(!HAVE)("a real Writer compile reads only its own workspace", () => {
  let lastDir = "";
  const compile = async (source: string, userPreamble = ""): Promise<WriterNumberingResponse> => {
    const dataDir = mkdtempSync(join(tmpdir(), "writer-render-safety-"));
    lastDir = dataDir;
    const outside = mkdtempSync(join(tmpdir(), "writer-outside-"));
    writeFileSync(
      join(outside, "sentinel.bib"),
      "@book{sentinel,\n  title = {SENTINEL-BIB-TITLE-5521},\n  author = {Zed, A.},\n  year = {2020},\n  publisher = {P}\n}\n"
    );
    const secret = join(dataDir, "outside-secret.txt");
    writeFileSync(secret, "TOP-SECRET-OUTSIDE-FILE-CONTENT\n");
    const app = createApp({
      paths: libraryPaths(dataDir),
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      broadcast: () => {},
    });
    const created = (await (
      await app.request("/api/writer/manuscripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: "report", title: "Safety" }),
      })
    ).json()) as WriterManuscript;
    created.userPreamble = userPreamble.replaceAll("@OUT@", outside);
    created.cells = [
      {
        id: "c_00000001",
        type: "latex",
        data: { source: source.replace("@SECRET@", secret).replaceAll("@OUT@", outside) },
      },
    ] as never;
    expect(
      (
        await app.request(`/api/writer/manuscripts/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(created),
        })
      ).status
    ).toBe(200);
    const res = await app.request(`/api/writer/manuscripts/${created.id}/numbering/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    mkdirSync(dataDir, { recursive: true });
    return (await res.json()) as WriterNumberingResponse;
  };

  test("an ordinary manuscript compiles to a preview", async () => {
    const out = await compile("\\section{Fine}\nPlain text with $x^2$.");
    expect(out.lastError).toBeNull();
    expect(out.status).toBe("ok");
  }, 120_000);

  test("\\input of an absolute path outside the workspace is refused and its content never reaches the preview", async () => {
    const out = await compile("\\section{Peek}\n\\input{@SECRET@}");
    expect(JSON.stringify(out)).not.toContain("TOP-SECRET-OUTSIDE-FILE-CONTENT");
    // The engine's log wraps lines: compare without whitespace.
    expect((out.lastError ?? "").replace(/\s+/g, "")).toMatch(/notfound|Notreading/i);
    expect(out.status).not.toBe("ok");
  }, 120_000);

  /** Every byte under the data dir (build logs, aux, pdf, numbering.json...) as latin1, to look for a value anywhere. */
  const everything = (dir: string): string => {
    let all = "";
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) all += everything(path);
      else {
        all += readFileSync(path).toString("latin1");
        // PDF text streams are compressed: read the typeset text the way a reader would
        if (name.endsWith(".pdf"))
          all += spawnSync("pdftotext", [path, "-"]).stdout?.toString("utf8") ?? "";
      }
    }
    return all;
  };
  const FAKE = "FAKE-WRITER-SECRET-VALUE-8472";

  test("B1: the reviewer's payload cannot read the server environment: no shell escape, scrubbed environment", async () => {
    process.env.FAKE_WRITER_SECRET_KEY = FAKE;
    try {
      // the reviewer's payload, in the user preamble where \makeatletter is legal; "undefined [" makes the writer
      // pipeline copy the message into preview.warnings (and so toward the model)
      // (two shapes: typeset into the page, and echoed through a message the pipeline turns into a warning)
      const out = await compile(
        'Body \\makeatletter\\@@input|"kpsewhich -var-value=FAKE_WRITER_SECRET_KEY" \\makeatother'
      );
      // the value is nowhere: response (warnings, error), log, aux, pdf, numbering.json
      expect(JSON.stringify(out)).not.toContain(FAKE);
      expect(everything(lastDir)).not.toContain(FAKE);
    } finally {
      delete process.env.FAKE_WRITER_SECRET_KEY;
    }
  }, 120_000);

  test("B1: the compile environment is scrubbed (no server variable, no shell escape, paranoid files) and the TeX variables stay", () => {
    process.env.FAKE_WRITER_SECRET_KEY = FAKE;
    process.env.TEXMFHOME = "/some/texmf";
    try {
      const env = writerTexEnv("/work/dir");
      expect(JSON.stringify(env)).not.toContain(FAKE);
      expect(Object.keys(env)).not.toContain("FAKE_WRITER_SECRET_KEY");
      expect(env).toMatchObject({
        shell_escape: "f",
        openin_any: "p",
        openout_any: "p",
        HOME: "/work/dir",
        TEXMFHOME: "/some/texmf",
      });
    } finally {
      delete process.env.FAKE_WRITER_SECRET_KEY;
      delete process.env.TEXMFHOME;
    }
  });

  test("B2: biber never runs in a Writer compile: an absolute \\addbibresource outside the workspace reaches neither the .bbl nor the PDF", async () => {
    const outside = mkdtempSync(join(tmpdir(), "writer-biber-out-"));
    const src = mkdtempSync(join(tmpdir(), "writer-biber-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "writer-biber-art-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "writer-biber-cache-"));
    writeFileSync(
      join(outside, "sentinel.bib"),
      "@book{sentinel,\n  title = {SENTINEL-BIB-TITLE-5521},\n  author = {Zed, A.},\n  year = {2020},\n  publisher = {P}\n}\n"
    );
    writeFileSync(
      join(src, "main.tex"),
      `\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{${join(outside, "sentinel.bib")}}\n\\begin{document}\nCited \\cite{sentinel}.\n\\printbibliography\n\\end{document}\n`
    );
    const result = await compileTex({
      srcDir: src,
      mainTex: join(src, "main.tex"),
      outDir,
      cacheDir,
      renderProfile: "writer",
      timeoutMs: 60_000,
    });
    expect(everything(outDir) + everything(cacheDir)).not.toContain("SENTINEL-BIB-TITLE-5521");
    expect(result.ok).toBe(false); // a refused biber is a failed compile, never a silent one
  }, 120_000);

  test("B2: bibtex itself cannot read an absolute .bib path under paranoid file access (and can without it)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "writer-bibtex-"));
    const work = mkdtempSync(join(tmpdir(), "writer-bibtex-run-"));
    writeFileSync(
      join(outside, "sentinel.bib"),
      "@book{sentinel,\n  title = {SENTINEL-BIB-TITLE-5521},\n  author = {Zed, A.},\n  year = {2020},\n  publisher = {P}\n}\n"
    );
    writeFileSync(
      join(work, "t.aux"),
      `\\relax\n\\citation{sentinel}\n\\bibstyle{plain}\n\\bibdata{${join(outside, "sentinel")}}\n`
    );
    const { spawnSync } = await import("node:child_process");
    const run = (env: Record<string, string>) => {
      spawnSync("bibtex", ["t"], {
        cwd: work,
        env: { PATH: process.env.PATH ?? "", HOME: work, ...env },
      });
      try {
        return readFileSync(join(work, "t.bbl"), "utf8");
      } catch {
        return "";
      }
    };
    expect(run({})).toContain("SENTINEL-BIB-TITLE-5521"); // the control: default access reads it
    writeFileSync(join(work, "t.bbl"), "");
    expect(run({ openin_any: "p", openout_any: "p" })).not.toContain("SENTINEL-BIB-TITLE-5521");
  }, 60_000);
});
