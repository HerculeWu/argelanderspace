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
import {
  __setWriterSandboxForTests,
  compileTex,
  haveLatexmk,
  writerSandboxAvailable,
  writerTexEnv,
} from "@argelanderspace/infra";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { stubPipelines, stubSources } from "./helpers.js";

const HAVE = haveLatexmk();
if (!HAVE) console.warn("latexmk not on PATH — writer render-safety real-compile test skipped");

const PDFOBJ_SENTINEL = "PDFOBJ-SENTINEL-7391-OUTSIDE";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SANDBOX = HAVE && writerSandboxAvailable();
if (HAVE && !SANDBOX)
  console.warn(
    "bubblewrap does not work here — the sandbox boundary tests are SKIPPED (not passed)"
  );

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
    writeFileSync(join(outside, "secret.txt"), `${PDFOBJ_SENTINEL}\n`);
    writeFileSync(join(outside, "real.png"), Buffer.from(PNG_B64, "base64"));
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

  const PDFOBJ_PAYLOAD =
    "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 \\immediate\\pdfobj stream file{@OUT@/secret.txt}\\pdfcatalog{/X \\the\\pdflastobj\\space 0 R}";

  test.skipIf(!SANDBOX)(
    "sandbox: pdfTeX \\pdfobj file{} of a file outside the workspace (it ignores openin_any) embeds nothing: user preamble and cell",
    async () => {
      for (const [source, preamble] of [
        ["Body.", PDFOBJ_PAYLOAD],
        [`Body. ${PDFOBJ_PAYLOAD}`, ""],
      ] as const) {
        const out = await compile(source, preamble);
        expect(JSON.stringify(out)).not.toContain(PDFOBJ_SENTINEL);
        expect(everything(lastDir)).not.toContain(PDFOBJ_SENTINEL);
      }
    },
    180_000
  );

  test.skipIf(!SANDBOX)(
    "control: without the sandbox the same payload does read the file into the PDF (why the sandbox is the boundary)",
    async () => {
      __setWriterSandboxForTests(false);
      try {
        await compile("Body.", PDFOBJ_PAYLOAD);
        expect(everything(lastDir)).toContain(PDFOBJ_SENTINEL);
      } finally {
        __setWriterSandboxForTests(null);
      }
    },
    120_000
  );

  test.skipIf(!SANDBOX)(
    "sandbox: \\includegraphics of an absolute image outside the workspace embeds no image",
    async () => {
      const out = await compile("Body \\includegraphics{@OUT@/real.png}");
      expect(everything(lastDir)).not.toContain("/Subtype /Image");
      expect(out.status).not.toBe("ok");
    },
    120_000
  );

  test.skipIf(!SANDBOX)(
    "B1 payload variants inside the sandbox: typeset in a cell, in the preamble, and through \\message (the warning path)",
    async () => {
      process.env.FAKE_WRITER_SECRET_KEY = FAKE;
      try {
        const kp = '|"kpsewhich -var-value=FAKE_WRITER_SECRET_KEY" ';
        const variants: [string, string][] = [
          [`Body \\makeatletter\\@@input${kp}\\makeatother`, ""],
          ["Body.", `\\makeatletter\\message{undefined [\\@nameuse{@@input}${kp}]}\\makeatother`],
          [`Body \\makeatletter\\message{undefined [\\@nameuse{@@input}${kp}]}\\makeatother`, ""],
        ];
        for (const [source, preamble] of variants) {
          const out = await compile(source, preamble);
          expect(JSON.stringify(out)).not.toContain(FAKE);
          expect(everything(lastDir)).not.toContain(FAKE);
        }
      } finally {
        delete process.env.FAKE_WRITER_SECRET_KEY;
      }
    },
    240_000
  );

  const ordinary = async (
    template: string
  ): Promise<{ out: WriterNumberingResponse; dir: string }> => {
    const dataDir = mkdtempSync(join(tmpdir(), "writer-ordinary-"));
    const paths = libraryPaths(dataDir);
    mkdirSync(paths.libraryDir, { recursive: true });
    writeFileSync(
      paths.libraryBib,
      "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Stellar streams},\n  journal = {MNRAS},\n  year = {2020}\n}\n"
    );
    const app = createApp({
      paths,
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      broadcast: () => {},
    });
    const doc = (await (
      await app.request("/api/writer/manuscripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, title: "Ordinary" }),
      })
    ).json()) as WriterManuscript;
    mkdirSync(join(dataDir, "manuscripts", doc.id, "assets"), { recursive: true });
    writeFileSync(
      join(dataDir, "manuscripts", doc.id, "assets", "fig.png"),
      Buffer.from(PNG_B64, "base64")
    );
    doc.cells = [
      {
        id: "c_00000001",
        type: "latex",
        data: {
          source: `${template === "letter" ? "" : "\\section{Intro}\n"}As shown by \\cite{smith2020}, $x^2$.`,
        },
      },
      ...(template === "letter"
        ? []
        : [
            {
              id: "c_00000002",
              type: "figure",
              data: {
                caption: "A figure",
                label: "fig:a",
                placement: "center",
                width: 60,
                image: "fig.png",
              },
            },
          ]),
    ] as never;
    expect(
      (
        await app.request(`/api/writer/manuscripts/${doc.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc),
        })
      ).status
    ).toBe(200);
    const res = await app.request(`/api/writer/manuscripts/${doc.id}/numbering/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return { out: (await res.json()) as WriterNumberingResponse, dir: dataDir };
  };

  test.each(["report", "letter"])(
    "an ordinary %s manuscript (figure asset, bibtex bibliography, math) still compiles in the Writer compile (sandboxed when it works here)",
    async (template) => {
      const { out, dir } = await ordinary(template);
      expect(out.lastError).toBeNull();
      expect(out.status).toBe("ok");
      const all = everything(dir);
      expect(all).toContain("\\bibitem"); // bibtex ran inside the boundary
      if (template === "report") expect(all).toContain("/Subtype /Image"); // the workspace's own figure embedded
    },
    180_000
  );

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

  const biberProbe = async () => {
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
    await compileTex({
      srcDir: src,
      mainTex: join(src, "main.tex"),
      outDir,
      cacheDir,
      renderProfile: "writer",
      timeoutMs: 60_000,
    });
    expect(everything(outDir) + everything(cacheDir)).not.toContain("SENTINEL-BIB-TITLE-5521");
  };
  test(
    "B2: with the sandbox, an absolute \\addbibresource outside the workspace reaches neither the .bbl nor the PDF",
    biberProbe,
    120_000
  );
  test("B2: without the sandbox, biber still never runs (latexmk $biber refuses): same sentinel stays out", async () => {
    __setWriterSandboxForTests(false);
    try {
      await biberProbe();
    } finally {
      __setWriterSandboxForTests(null);
    }
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
