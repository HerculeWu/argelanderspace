/**
 * Spec 14.1 for Render (copilot ticket 23): a REAL latexmk/pdflatex compile of a manuscript. TeX Live's default lets a
 * document \input any readable absolute path; the Writer compile now runs with paranoid file access, so text that got
 * past (or around) the agent-text screening still cannot read outside the compile workspace. Gated on the engine like
 * the other real-compile tests (a skip is not a pass).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
  ensureWriterSandboxProbe,
  haveLatexmk,
  isSafeTexRoot,
  runTexProcess,
  writerSandboxBinds,
  writerSandboxCommand,
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
const SANDBOX = HAVE && (await ensureWriterSandboxProbe());
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
    template: string,
    extra: { bib?: string; preamble?: string } = {}
  ): Promise<{ out: WriterNumberingResponse; dir: string }> => {
    const dataDir = mkdtempSync(join(tmpdir(), "writer-ordinary-"));
    const outside = mkdtempSync(join(tmpdir(), "writer-ordinary-out-"));
    writeFileSync(join(outside, "secret.txt"), `${PDFOBJ_SENTINEL}\n`);
    const paths = libraryPaths(dataDir);
    mkdirSync(paths.libraryDir, { recursive: true });
    writeFileSync(
      paths.libraryBib,
      (
        extra.bib ??
        "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Stellar streams},\n  journal = {MNRAS},\n  year = {2020}\n}\n"
      ).replaceAll("@OUT@", outside)
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
    doc.userPreamble = (extra.preamble ?? "").replaceAll("@OUT@", outside);
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

  const BIB_PAYLOAD =
    "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Stellar streams},\n  journal = {MNRAS},\n  year = {2020},\n  volume = {1},\n  number = {\\immediate\\pdfobj stream file{@OUT@/secret.txt}2}\n}\n";
  const UNCOMPRESSED = "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0";

  test.skipIf(!SANDBOX)(
    "library BibTeX with a pdfTeX file primitive in a field (an imported entry is unescaped) reads nothing inside the sandbox; without it, it does",
    async () => {
      const safe = await ordinary("report", { bib: BIB_PAYLOAD, preamble: UNCOMPRESSED });
      expect(everything(safe.dir)).not.toContain(PDFOBJ_SENTINEL);
      expect(JSON.stringify(safe.out)).not.toContain(PDFOBJ_SENTINEL);
      __setWriterSandboxForTests(false);
      try {
        const open = await ordinary("report", { bib: BIB_PAYLOAD, preamble: UNCOMPRESSED });
        expect(everything(open.dir)).toContain(PDFOBJ_SENTINEL); // the chain is real: this is why the sandbox matters
      } finally {
        __setWriterSandboxForTests(null);
      }
    },
    240_000
  );

  test.skipIf(!SANDBOX)(
    "inside the sandbox /proc shows no host path: environ, cmdline, cwd and hostname are neutral",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "writer-proc-probe-"));
      const sandbox = writerSandboxCommand(dataDir, writerTexEnv(dataDir), "sh", [
        "-c",
        "cat /proc/self/environ | tr '\\0' '\\n'; echo ---; cat /proc/1/cmdline | tr '\\0' ' '; echo ---; cat /proc/self/cmdline | tr '\\0' ' '; echo ---; readlink /proc/1/cwd; readlink /proc/self/cwd; hostname; ls /",
      ]);
      const result = await runTexProcess(sandbox.cmd, sandbox.args, {
        cwd: sandbox.cwd,
        timeoutMs: 30_000,
        env: sandbox.env,
        replaceEnv: true,
        fdInput: sandbox.fdInput,
      });
      expect(result.code).toBe(0);
      const out = result.stdout;
      expect(out).not.toContain(dataDir);
      expect(out).not.toContain(tmpdir());
      expect(out).not.toContain("/home");
      expect(out).toContain("HOME=/work");
      expect(out).toContain("writer-sandbox");
      expect(out).not.toMatch(/^(home|root|mnt|media)$/m); // the root listing holds no user trees
    },
    60_000
  );

  test("sandbox binds: only the system trees, TeX's own parts of /etc and /var, the TeX installation and the workspace", () => {
    const sandbox = writerSandboxCommand("/data/ws", writerTexEnv("/data/ws"), "latexmk", ["x"]);
    const options = sandbox.fdInput.toString("utf8").split("\0");
    const sources: string[] = [];
    options.forEach((option, index) => {
      if (["--ro-bind", "--ro-bind-try", "--bind"].includes(option))
        sources.push(options[index + 1] as string);
    });
    const allowed = new Set([
      "/usr",
      "/bin",
      "/lib",
      "/lib64",
      "/sbin",
      "/etc/texmf",
      "/etc/fonts",
      "/etc/alternatives",
      "/etc/ld.so.cache",
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d",
      "/etc/localtime",
      "/var/lib/texmf",
      "/var/cache/fontconfig",
      "/data/ws",
      ...writerSandboxBinds(),
    ]);
    for (const source of sources) expect(allowed.has(source), source).toBe(true);
    for (const bind of writerSandboxBinds()) expect(isSafeTexRoot(bind), bind).toBe(true);
    // the workspace is the only writable bind
    expect(options.filter((option) => option === "--bind")).toHaveLength(1);
    expect(sandbox.args.join(" ")).not.toContain("/data/ws"); // nor does the command line
  });

  test("a TeX root is never a parent of user data: roots, home trees, /tmp and similar are refused", () => {
    for (const bad of [
      "/",
      "/opt",
      "/usr/local",
      "/home",
      "/home/u/texlive",
      "/root/tex",
      "/tmp/texlive",
      "/mnt/data",
      "/var",
      "/etc",
      "/opt/../home/u",
      "relative/tex",
    ])
      expect(isSafeTexRoot(bad), bad).toBe(false);
    for (const good of [
      "/opt/texlive",
      "/opt/texlive/2024",
      "/usr/local/texlive/2024/bin/x86_64-linux".replace("/usr/local", "/opt"),
    ])
      expect(isSafeTexRoot(good), good).toBe(true);
  });

  test("a Copilot-marked refresh compiles with or without the sandbox, like the user's own (no gate)", async () => {
    try {
      const dataDir = mkdtempSync(join(tmpdir(), "writer-gate-"));
      const app = createApp({
        paths: libraryPaths(dataDir),
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
          body: JSON.stringify({ template: "report", title: "Gate" }),
        })
      ).json()) as WriterManuscript;
      const refresh = (headers: Record<string, string> = {}) =>
        app.request(`/api/writer/manuscripts/${doc.id}/numbering/refresh`, {
          method: "POST",
          headers,
        });
      const numberingFile = join(dataDir, "manuscripts", doc.id, "build", "numbering.json");
      __setWriterSandboxForTests(false);
      expect((await refresh({ "X-Copilot-Action": "1" })).status).toBe(200);
      expect(existsSync(numberingFile)).toBe(true);
      expect((await refresh()).status).toBe(200);
      __setWriterSandboxForTests(true);
      expect((await refresh({ "X-Copilot-Action": "1" })).status).toBe(200);
    } finally {
      __setWriterSandboxForTests(null);
    }
  }, 180_000);

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
