/**
 * M5 smoke tests: invoke the *built* CLI (`dist/bin.js`) end-to-end —
 * `ingest` on a local LaTeX fixture (offline; latexmk-gated), `library build
 * --offline` against a fixture data dir, and `serve` boot + `/api/papers`
 * probe + clean SIGTERM shutdown. Plus unit tests for the source
 * auto-detection (latex-only routing; DOI/URL gets a friendly error).
 *
 * Hermeticity: the spawned CLI gets `HOME=<tmp>` so the ADS token file is
 * absent (ADS self-degrades to "no-token", no network).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
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

/** Child env: HOME in a tmp dir, astro bin on PATH
 *  (pandoc is only needed by the retired pandoc-gated suites elsewhere). */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
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

describe("ingest --figure-dpi (accepted for compatibility, ignored; release-0.2 ticket 15)", () => {
  test("--help says it is ignored and shows no default", () => {
    const home = mkdtempSync(join(tmpdir(), "argelander-dpi-"));
    try {
      const help = runCli(["ingest", "--help"], childEnv(home));
      expect(help.status).toBe(0);
      const text = help.stdout.replace(/\s+/g, " ");
      expect(text).toContain("--figure-dpi <n> accepted for compatibility and ignored");
      expect(text).not.toMatch(/--figure-dpi[^-]*\(default/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("passing it is not an option error (the failure is the missing source, not the flag)", () => {
    const home = mkdtempSync(join(tmpdir(), "argelander-dpi-"));
    try {
      const r = runCli(
        ["ingest", "--figure-dpi", "300", join(home, "no-such.tex"), "--data-dir", join(home, "d")],
        childEnv(home)
      );
      expect(r.stderr).not.toMatch(/unknown option|--figure-dpi/);
      expect(r.status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
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
    // the argument-graph merge note is an additive key that only a merge produces (frozen summary shape)
    expect("argument_graph_merges" in json).toBe(false);
    // library.json was written
    expect(existsSync(join(dataDir, "library", "library.json"))).toBe(true);
  }, 60_000);
});

/** A library with two Works, A and C (C carries an argument graph), and a bib entry that bridges them. */
function mergeFixture() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-argmerge-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  mkdirSync(join(dataDir, "argument-graphs"), { recursive: true });
  const work = (id: string, title: string, doi: string, key: string) => ({
    id,
    title,
    authors: ["X"],
    year: 2001,
    doi,
    cite_key: key,
  });
  writeFileSync(
    join(dataDir, "library", "library.json"),
    JSON.stringify({
      version: 1,
      project: { name: "S", short: "S", field: "" },
      works: [
        work("doi:10.1/a", "Alpha galaxies", "10.1/a", "a2001"),
        work("doi:10.1/c", "Gamma", "10.1/c", "c2001"),
      ],
    })
  );
  const cFile = join(dataDir, "argument-graphs", "doi%3A10%2E1%2Fc.json");
  const graph = {
    version: 1,
    rev: 3,
    work_id: "doi:10.1/c",
    arguments: [
      {
        id: "a1",
        title: "t",
        claim: "",
        grounds: "",
        warrant: "",
        backing: "",
        qualifier: "",
        rebuttal: "",
        warrant_implicit: false,
        kind: "end",
        sources: [],
      },
    ],
    edges: [],
  };
  writeFileSync(cFile, JSON.stringify(graph, null, 2));
  const bib = join(root, "bridge.bib");
  writeFileSync(
    bib,
    "@article{b1,\n author={Ann},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}\n"
  );
  return { root, dataDir, cFile, graph, bib };
}

describe("library build folds Works that have argument graphs (ticket 06)", () => {
  test("a bridging --bib entry moves the absorbed Work's graph and says so in the summary JSON", () => {
    const { root, dataDir, cFile, bib } = mergeFixture();
    const r = runCli(
      ["library", "build", "--data-dir", dataDir, "--offline", "--bib", bib],
      childEnv(root)
    );
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout.slice(0, r.stdout.indexOf("\n}\n") + 3)) as {
      works: number;
      argument_graph_merges?: { outcome: string; absorbed_file: string }[];
    };
    expect(json.works).toBe(1);
    expect(json.argument_graph_merges).toHaveLength(1);
    // the command line is local: absolute locations
    expect(json.argument_graph_merges?.[0]).toMatchObject({
      outcome: "moved",
      absorbed_file: cFile,
    });
    const moved = JSON.parse(
      readFileSync(join(dataDir, "argument-graphs", "doi%3A10%2E1%2Fa.json"), "utf8")
    ) as { work_id: string; rev: number };
    expect(moved).toMatchObject({ work_id: "doi:10.1/a", rev: 3 });
    expect(existsSync(cFile)).toBe(false); // a real move: one graph on disk
  }, 60_000);

  test.each([[[]], [["--fetch"]], [["--fetch-remaining"]]] as string[][][])(
    "acquire %j: the merge note of the first rebuild survives the later ones",
    (extra) => {
      const { root, dataDir, bib } = mergeFixture();
      const r = runCli(
        ["acquire", bib, "--data-dir", dataDir, "--offline", ...extra],
        childEnv(root)
      );
      expect(r.status).toBe(0);
      const printed = /^\{\n[\s\S]*?\n\}$/m.exec(r.stdout)?.[0] ?? "";
      const json = JSON.parse(printed) as {
        argument_graph_merges?: { outcome: string; survivor_id: string }[];
      };
      expect(json.argument_graph_merges).toHaveLength(1);
      expect(json.argument_graph_merges?.[0]).toMatchObject({
        outcome: "moved",
        survivor_id: "doi:10.1/a",
      });
    },
    120_000
  );
});

/** Spawn `serve` with the given extra args/env; resolves with the port of its "listening on" line. */
async function serve(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ port: number; stdout: () => string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, [BIN, "serve", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  const stop = (): Promise<number | null> =>
    new Promise((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code));
      child.kill("SIGTERM");
    });
  try {
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`no listen line; got: ${stdout}`)),
        20_000
      );
      child.stdout.on("data", () => {
        // the three start-up lines end with the web dist one
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\n[\s\S]*web dist: .*\n/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          resolvePromise(Number.parseInt(m[1] as string, 10));
        }
      });
    });
    return { port, stdout: () => stdout, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

describe("serve: configuration comes from flags and config.toml only (desktop-app ticket 05)", () => {
  test("the removed variables change nothing; a same-origin write passes on the bound port", async () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-serve-"));
    const dataDir = makeDataDir(root);
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    const srv = await serve(["--data-dir", dataDir, "--port", "0"], {
      ...childEnv(root),
      ARGELANDERSPACE_DATA_DIR: decoy,
      ARGELANDERSPACE_PORT: "9",
      ARGELANDERSPACE_WEB_DIST: decoy,
      ARGELANDERSPACE_GLOBAL_DIR: "relative/global",
      ARGELANDERSPACE_GLOBAL_CACHE_DIR: "relative/cache",
    });
    try {
      expect(srv.stdout()).toContain(`  data dir: ${dataDir}\n`);
      expect(srv.stdout()).not.toContain(decoy);
      const papers = await fetch(`http://127.0.0.1:${srv.port}/api/papers`);
      expect(await papers.json()).toEqual({ papers: ["arxiv-2501.17225"] });
      const put = async (origin: string): Promise<number> =>
        (
          await fetch(`http://127.0.0.1:${srv.port}/api/plans`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Origin: origin },
            body: JSON.stringify({ version: 1, rev: 0, plans: [] }),
          })
        ).status;
      expect(await put("http://evil.example")).toBe(403);
      expect(await put("http://127.0.0.1:8000")).toBe(403);
      expect(await put(`http://127.0.0.1:${srv.port}`)).toBe(200);
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    expect(readdirSync(decoy)).toEqual([]);
  }, 60_000);

  test("without --port it binds config.toml `port`, not the removed variable", async () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-serve-"));
    const dataDir = makeDataDir(root);
    // a port that is free right now
    const probe = createNetServer();
    await new Promise<void>((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
    const free = (probe.address() as { port: number }).port;
    await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "argelanderspace"), { recursive: true });
    writeFileSync(join(xdg, "argelanderspace", "config.toml"), `port = ${free}\n`);
    const srv = await serve(["--data-dir", dataDir], {
      ...childEnv(root),
      XDG_CONFIG_HOME: xdg,
      ARGELANDERSPACE_PORT: "9",
    });
    try {
      expect(srv.port).toBe(free);
    } finally {
      expect(await srv.stop()).toBe(0);
    }
  }, 60_000);

  // Hard contract 「产品与执行边界」 item 2, as revised 2026-10-14 (desktop-app ticket 10): `serve` starts on the
  // default data location and names the key — on the terminal and in the settings' problem list — where a command
  // stops with a ConfigError (the commands' refusal is pinned in agent.test.ts and argument.test.ts).
  test("config.toml `data_dir` as an absolute path: serve starts on the default data location, naming the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-serve-"));
    try {
      const dataDir = makeDataDir(root);
      const xdg = join(root, "xdg");
      mkdirSync(join(xdg, "argelanderspace"), { recursive: true });
      writeFileSync(join(xdg, "argelanderspace", "config.toml"), `data_dir = "${dataDir}"\n`);
      const project = join(root, "project");
      mkdirSync(project);
      const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
        cwd: project,
        env: { ...childEnv(root), XDG_CONFIG_HOME: xdg },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      try {
        const port = await new Promise<number>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(
            () => rejectPromise(new Error(`no listen line; got: ${stdout} / ${stderr}`)),
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
        // The default data location, not the one the file names (the line follows the listening line).
        for (let i = 0; i < 50 && !stdout.includes("web dist:"); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(stdout).toContain(`data dir: ${join(project, "literatures")}`);
        // The page's problem list names the key.
        const settings = (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as {
          problems: { key: string | null; reason: string }[];
        };
        expect(settings.problems).toContainEqual({ key: "data_dir", reason: "must_be_relative" });
        // The terminal line is written once the server listens.
        for (let i = 0; i < 50 && !stderr.includes("the settings page lists them too"); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        child.kill("SIGTERM");
      }
      const exit = await new Promise<number | null>((resolvePromise) => {
        child.on("exit", (code) => resolvePromise(code));
      });
      expect(exit).toBe(0);
      // The terminal names the key and says the default location is in use; the value is never repeated.
      expect(stderr).toContain('"data_dir" must be a relative path');
      expect(stderr).toContain(
        "project data: the default location ./literatures is in use, not the one the file names"
      );
      expect(stderr).not.toContain(dataDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("help names config.toml, not environment variables, and the default port", () => {
    for (const args of [["--help"], ["serve", "--help"], ["read", "--help"]]) {
      const r = runCli(args, childEnv(mkdtempSync(join(tmpdir(), "aspace-cli-help-"))));
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(/ARGELANDERSPACE_|\benv\b|8000/);
      expect(r.stdout.replace(/\s+/g, " ")).toContain(
        "data directory (default ./literatures, or data_dir in config.toml)"
      );
    }
    const serveHelp = runCli(["serve", "--help"], childEnv(mkdtempSync(join(tmpdir(), "aspace-"))));
    expect(serveHelp.stdout.replace(/\s+/g, " ")).toContain(
      "port (default 1859, or port in config.toml)"
    );
  });
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
