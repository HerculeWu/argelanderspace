/**
 * M5 smoke tests: invoke the *built* CLI (`dist/bin.js`) end-to-end —
 * `ingest` on a local LaTeX fixture (offline; latexmk-gated), `library build
 * --offline` against a fixture data dir, and `serve` boot + `/api/papers`
 * probe + clean SIGTERM shutdown. Plus unit tests for the source
 * auto-detection (latex-only routing; DOI/URL gets a friendly error).
 *
 * Hermeticity: the spawned CLI gets `HOME=<tmp>` so the ADS token file is
 * absent (ADS self-degrades to "no-token", no network) and the ambient
 * `ARGELANDERSPACE_*` env is scrubbed.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { detectSource } from "../src/detect.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const ASTRO_BIN_HINT = "/home/wwu/miniforge3/envs/astro/bin";

function haveLatexmk(env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("latexmk", ["--version"], { env, stdio: "ignore" }).status === 0 &&
    spawnSync("pdflatex", ["--version"], { env, stdio: "ignore" }).status === 0
  );
}

/** Child env: scrubbed ARGELANDERSPACE_*, HOME in a tmp dir, astro bin on PATH
 *  (pandoc is only needed by the retired pandoc-gated suites elsewhere). */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ARGELANDERSPACE_")) delete env[k];
  }
  env.PATH = `${ASTRO_BIN_HINT}${delimiter}${env.PATH ?? ""}`;
  return env;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A fresh fixture data dir holding one golden stored-IR doc (tex pipeline). */
function makeDataDir(root: string): string {
  const dataDir = join(root, "data");
  const docDir = join(dataDir, "output", "arxiv-2501.17225");
  mkdirSync(docDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "tests", "golden", "tex", "arxiv-2501.17225.json"),
    join(docDir, "arxiv-2501.17225.json")
  );
  return dataDir;
}

test("CLI is built (dist/bin.js exists — run `pnpm --filter @argelanderspace/cli build`)", () => {
  expect(existsSync(BIN)).toBe(true);
});

describe("source auto-detection (latex routing + DOI stubs)", () => {
  test("arXiv id / prefix / URL → latex", () => {
    expect(detectSource("2501.17225")).toEqual({ kind: "latex", input: "2501.17225" });
    expect(detectSource("arXiv:2603.03522v2")).toEqual({
      kind: "latex",
      input: "arXiv:2603.03522v2",
    });
    expect(detectSource("https://arxiv.org/abs/2501.17225")).toEqual({
      kind: "latex",
      input: "https://arxiv.org/abs/2501.17225",
    });
    expect(detectSource("astro-ph/0701001")).toEqual({ kind: "latex", input: "astro-ph/0701001" });
  });
  test("bare DOI (optionally doi:-prefixed) → docless library stub", () => {
    expect(detectSource("10.1051/0004-6361/202039341")).toEqual({
      kind: "doi-stub",
      doi: "10.1051/0004-6361/202039341",
      fromUrl: false,
    });
    expect(detectSource("doi:10.3847/1538-4357/ab1234")).toEqual({
      kind: "doi-stub",
      doi: "10.3847/1538-4357/ab1234",
      fromUrl: false,
    });
  });
  test("bare DOI with pasted trailing punctuation / path junk → stripped", () => {
    for (const pasted of [
      "10.1051/0004-6361/202039341.",
      "10.1051/0004-6361/202039341)",
      "10.1051/0004-6361/202039341/",
      "10.1051/0004-6361/202039341.pdf",
    ]) {
      expect(detectSource(pasted), pasted).toEqual({
        kind: "doi-stub",
        doi: "10.1051/0004-6361/202039341",
        fromUrl: false,
      });
    }
  });
  test("URL carrying a DOI in its path → docless library stub", () => {
    expect(detectSource("https://doi.org/10.1051/0004-6361/202039341")).toEqual({
      kind: "doi-stub",
      doi: "10.1051/0004-6361/202039341",
      fromUrl: true,
    });
    expect(
      detectSource("https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.123.456")
    ).toEqual({ kind: "doi-stub", doi: "10.1103/PhysRevLett.123.456", fromUrl: true });
    // trailing publisher path/format junk is stripped from the DOI
    expect(
      detectSource("https://iopscience.iop.org/article/10.3847/1538-4357/ab1234/meta")
    ).toEqual({ kind: "doi-stub", doi: "10.3847/1538-4357/ab1234", fromUrl: true });
    expect(detectSource("https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.123.456")).toEqual({
      kind: "doi-stub",
      doi: "10.1103/PhysRevLett.123.456",
      fromUrl: true,
    });
    // a trailing slash on a doi.org link must not land in the identity key
    expect(detectSource("https://doi.org/10.1051/0004-6361/202039341/")).toEqual({
      kind: "doi-stub",
      doi: "10.1051/0004-6361/202039341",
      fromUrl: true,
    });
  });
  test("an arXiv DataCite DOI routes to the latex pipeline with the resolved id", () => {
    expect(detectSource("10.48550/arXiv.2501.17225")).toEqual({
      kind: "latex",
      input: "2501.17225",
    });
    expect(detectSource("https://doi.org/10.48550/arXiv.2501.17225v2")).toEqual({
      kind: "latex",
      input: "2501.17225",
    });
    // trailing publisher path junk is stripped before the id is resolved
    expect(detectSource("https://doi.org/10.48550/arXiv.2501.17225/pdf")).toEqual({
      kind: "latex",
      input: "2501.17225",
    });
  });
  test("an arXiv DataCite DOI with a malformed tail → friendly error, never a stub", () => {
    expect(() => detectSource("10.48550/arXiv.2501.17225junk")).toThrow(
      /cannot parse the arXiv id/
    );
    expect(() => detectSource("https://doi.org/10.48550/arXiv.notanid")).toThrow(
      /cannot parse the arXiv id/
    );
  });
  test("publisher URL without a DOI in its path → recognized, friendly error", () => {
    // pages are bot-walled and the URL carries no DOI, so nothing anchors an entry
    expect(() =>
      detectSource("https://www.aanda.org/articles/aa/full_html/2020/01/aa39341-20/aa39341-20.html")
    ).toThrow(/ocr-features/);
    expect(() => detectSource("https://academic.oup.com/mnras/article/512/4/5527/6571234")).toThrow(
      /in development/
    );
  });
  test("PDF path / nonexistent path / bare title → friendly error, no entry", () => {
    expect(() => detectSource("paper.pdf")).toThrow(/unrecognized source/);
    expect(() => detectSource("does/not/exist.tex")).toThrow(/unrecognized source/);
    expect(() => detectSource("Improving the open cluster census")).toThrow(/unrecognized source/);
  });
  test("existing local .tex / dir / tarball → latex", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-detect-"));
    const tex = join(root, "main.tex");
    copyFileSync(join(PKG, "..", "infra", "tests", "fixtures", "sample_latex.tex"), tex);
    expect(detectSource(tex)).toEqual({ kind: "latex", input: tex });
    expect(detectSource(root)).toEqual({ kind: "latex", input: root });
    const tar = join(root, "src.tar.gz");
    copyFileSync(join(PKG, "..", "infra", "tests", "fixtures", "eprint-sample.tar.gz"), tar);
    expect(detectSource(tar)).toEqual({ kind: "latex", input: tar });
  });
});

const LATEXMK = haveLatexmk(childEnv(mkdtempSync(join(tmpdir(), "aspace-cli-home-"))));

describe.skipIf(!LATEXMK)("ingest smoke (built CLI, real latexmk compile)", () => {
  test("local .tex ingests and prints the summary", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-ingest-"));
    const env = childEnv(root);
    const tex = join(root, "main.tex");
    // the pandoc-era sample needs its implicit packages + aastex macros
    // spelled out for latexmk (pandoc tolerated them); patch the tmp copy.
    const sampleSrc = readFileSync(
      join(REPO_ROOT, "packages", "core", "tests", "fixtures", "sample-latex", "sample_latex.tex"),
      "utf8"
    )
      .replace(
        "\\documentclass{article}",
        "\\documentclass{article}\n" +
          "\\usepackage{natbib}\n\\usepackage{graphicx}\n\\usepackage{url}\n" +
          "\\providecommand{\\arcsec}{''}\n\\providecommand{\\mnras}{MNRAS}\n" +
          "\\providecommand{\\aap}{A\\&A}\n\\providecommand{\\doi}[1]{doi: #1}"
      )
      .replace("$\\alpha\\textsubscript{c}$", "$\\alpha_{\\mathrm{c}}$");
    writeFileSync(tex, sampleSrc);
    // the sample's \includegraphics needs a real file for latexmk (pandoc
    // tolerated the dangling name); provide it.
    cpSync(
      join(PKG, "..", "infra", "tests", "fixtures", "fig-vector.pdf"),
      join(root, "nonexistent_figure.pdf")
    );
    const dataDir = join(root, "data");

    const r = runCli(["ingest", tex, "--data-dir", dataDir, "--no-assets"], env);
    // warnings (compile/fuse degradations) surface on stderr; --no-assets
    // emits exactly the no-figure-port one
    expect(r.stderr).toContain("warning: no figure port wired");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("=== ingest summary ===");
    expect(r.stdout).toContain("title       : A Sample LaTeX Paper for the Phase 5 Pipeline");
    expect(r.stdout).toContain("n_references: 2");
    expect(r.stdout).toContain("engine      : pdflatex");
    // the doc landed under <data-dir>/output/<doc_id>/<doc_id>.json
    expect(existsSync(join(dataDir, "output", "latex-main", "latex-main.json"))).toBe(true);
  }, 180_000);
});

// Stage 7 MS4: a DOI input creates a docless library entry instead of failing.
// Crossref may or may not answer from the test env (network optional): both
// the enriched and the bare-stub path exit 0 and persist the same DOI work.
describe("ingest DOI stub (built CLI)", () => {
  test("a DOI input creates a docless library entry, exit 0; a repeat finds it", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-doi-"));
    const dataDir = join(root, "data");
    const env = childEnv(root);
    // --no-assets is a latex-pipeline flag: the stub path warns it is ignored
    const r = runCli(
      ["ingest", "10.1051/0004-6361/202039341", "--data-dir", dataDir, "--no-assets"],
      env
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("note: --no-assets ignored");
    expect(r.stdout).toContain("created library entry doi:10.1051/0004-6361/202039341");
    expect(r.stdout).toContain("upload a LaTeX source zip");
    const lib = JSON.parse(readFileSync(join(dataDir, "library", "library.json"), "utf8")) as {
      works: Record<string, unknown>[];
    };
    const work = lib.works.find((w) => w.doi === "10.1051/0004-6361/202039341");
    expect(work).toBeDefined();
    expect(work?.id).toBe("doi:10.1051/0004-6361/202039341");
    expect(work?.origin).toBe("manual");
    expect(work?.doc_ids ?? []).toEqual([]);
    expect(typeof work?.cite_key).toBe("string");

    const again = runCli(["ingest", "10.1051/0004-6361/202039341", "--data-dir", dataDir], env);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("library entry already exists");
    const lib2 = JSON.parse(readFileSync(join(dataDir, "library", "library.json"), "utf8")) as {
      works: unknown[];
    };
    expect(lib2.works).toHaveLength(1);
  }, 120_000);

  test("a DOI-less publisher URL and a bare title stay friendly errors, exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-doi-"));
    const env = childEnv(root);
    const url = runCli(
      [
        "ingest",
        "https://academic.oup.com/mnras/article/512/4/5527/6571234",
        "--data-dir",
        join(root, "data"),
      ],
      env
    );
    expect(url.status).toBe(1);
    expect(url.stderr).toContain("in development");
    const bare = runCli(
      ["ingest", "Improving the open cluster census", "--data-dir", join(root, "data")],
      env
    );
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("unrecognized source");
    expect(existsSync(join(root, "data", "library", "library.json"))).toBe(false);
  }, 120_000);

  // A 10.9999/ DOI never has a Crossref record, so the bare-stub path is
  // deterministic whether or not the test env has network (404 or unreachable
  // both resolve to null).
  test("a URL-extracted DOI unknown to Crossref says it may not be a real DOI", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-doi-"));
    const dataDir = join(root, "data");
    const r = runCli(
      ["ingest", "https://doi.org/10.9999/nonexistent/xyz", "--data-dir", dataDir],
      childEnv(root)
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("created library entry doi:10.9999/nonexistent/xyz");
    expect(r.stdout).toContain("may not be a real DOI");
  }, 120_000);
});

describe("library build smoke (built CLI, offline)", () => {
  test("rebuilds from a fixture data dir and prints the summary JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-library-"));
    const dataDir = makeDataDir(root);
    const r = runCli(["library", "build", "--data-dir", dataDir, "--offline"], childEnv(root));
    expect(r.status).toBe(0);
    // the summary is the first JSON block on stdout (an ADS warning may follow)
    const json = JSON.parse(r.stdout.slice(0, r.stdout.indexOf("\n}\n") + 3)) as Record<
      string,
      unknown
    >;
    expect(json.works).toBe(1);
    expect(json.ads_status).toBe("no-token");
    // library.json was written
    expect(existsSync(join(dataDir, "library", "library.json"))).toBe(true);
  }, 60_000);
});

describe("serve smoke (built CLI)", () => {
  test("boots, answers /api/papers, shuts down cleanly on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-serve-"));
    const dataDir = makeDataDir(root);
    const child = spawn(process.execPath, [BIN, "serve", "--data-dir", dataDir, "--port", "0"], {
      env: childEnv(root),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    try {
      // wait for the "listening on" line, then parse the ephemeral port
      const port = await new Promise<number>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(
          () => rejectPromise(new Error(`no listen line; got: ${stdout}`)),
          20_000
        );
        child.stdout.on("data", () => {
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
          if (m) {
            clearTimeout(timer);
            resolvePromise(Number.parseInt(m[1] as string, 10));
          }
        });
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/papers`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ papers: ["arxiv-2501.17225"] });
    } finally {
      child.kill("SIGTERM");
    }
    const exit = await new Promise<number | null>((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code));
    });
    expect(exit).toBe(0);
  }, 60_000);
});
