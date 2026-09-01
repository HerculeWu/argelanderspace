/**
 * M5 smoke tests: invoke the *built* CLI (`dist/bin.js`) end-to-end —
 * `ingest` on a local LaTeX fixture (offline; pandoc-gated), `library build
 * --offline` against a fixture data dir, and `serve` boot + `/api/papers`
 * probe + clean SIGTERM shutdown. Plus unit tests for the source
 * auto-detection (latex-only routing; DOI/URL gets a friendly error).
 *
 * Hermeticity: the spawned CLI gets `HOME=<tmp>` so the ADS token file is
 * absent (ADS self-degrades to "no-token", no network) and the ambient
 * `ARGELANDERSPACE_*` env is scrubbed.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { detectSource } from "../src/detect.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const ASTRO_BIN_HINT = "/home/wwu/miniforge3/envs/astro/bin";

function havePandoc(env: NodeJS.ProcessEnv): boolean {
  const r = spawnSync("pandoc", ["--version"], { env, stdio: "ignore" });
  return r.status === 0;
}

/** Child env: scrubbed ARGELANDERSPACE_*, HOME in a tmp dir, astro bin on PATH. */
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

/** A fresh fixture data dir holding one golden reader doc. */
function makeDataDir(root: string): string {
  const dataDir = join(root, "data");
  const docDir = join(dataDir, "output", "arxiv-2501.17225");
  mkdirSync(docDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "tests", "golden", "arxiv-2501.17225.json"),
    join(docDir, "arxiv-2501.17225.json")
  );
  return dataDir;
}

test("CLI is built (dist/bin.js exists — run `pnpm --filter @argelanderspace/cli build`)", () => {
  expect(existsSync(BIN)).toBe(true);
});

describe("source auto-detection (latex-only routing)", () => {
  test("arXiv id / prefix / URL → latex", () => {
    expect(detectSource("2501.17225")).toBe("latex");
    expect(detectSource("arXiv:2603.03522v2")).toBe("latex");
    expect(detectSource("https://arxiv.org/abs/2501.17225")).toBe("latex");
    expect(detectSource("astro-ph/0701001")).toBe("latex");
  });
  test("DOI / publisher URL → recognized, friendly error (HTML/PDF in development)", () => {
    expect(() => detectSource("10.1051/0004-6361/123")).toThrow(/in development/);
    expect(() =>
      detectSource("https://www.aanda.org/articles/aa/full_html/2020/01/aa39341-20/aa39341-20.html")
    ).toThrow(/ocr-features/);
  });
  test("PDF path / nonexistent path → friendly error", () => {
    expect(() => detectSource("paper.pdf")).toThrow(/unrecognized source/);
    expect(() => detectSource("does/not/exist.tex")).toThrow(/unrecognized source/);
  });
  test("existing local .tex / dir / tarball → latex", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-detect-"));
    const tex = join(root, "main.tex");
    copyFileSync(join(PKG, "..", "infra", "tests", "fixtures", "sample_latex.tex"), tex);
    expect(detectSource(tex)).toBe("latex");
    expect(detectSource(root)).toBe("latex");
    const tar = join(root, "src.tar.gz");
    copyFileSync(join(PKG, "..", "infra", "tests", "fixtures", "eprint-sample.tar.gz"), tar);
    expect(detectSource(tar)).toBe("latex");
  });
});

const PANDOC = havePandoc(childEnv(mkdtempSync(join(tmpdir(), "aspace-cli-home-"))));

describe.skipIf(!PANDOC)("ingest smoke (built CLI, offline)", () => {
  test("local .tex ingests and prints the summary", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-ingest-"));
    const env = childEnv(root);
    const tex = join(root, "main.tex");
    cpSync(join(PKG, "..", "infra", "tests", "fixtures", "sample_latex.tex"), tex);
    const dataDir = join(root, "data");

    const r = runCli(["ingest", tex, "--data-dir", dataDir, "--no-assets"], env);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("=== ingest summary ===");
    expect(r.stdout).toContain("title       : A Sample LaTeX Paper for the Phase 5 Pipeline");
    expect(r.stdout).toContain("n_references: 2");
    // the doc landed under <data-dir>/output/<doc_id>/<doc_id>.json
    expect(existsSync(join(dataDir, "output", "latex-main", "latex-main.json"))).toBe(true);
  }, 180_000);

  test("a DOI input is an actionable in-development error, exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "aspace-cli-ingest-"));
    const r = runCli(
      ["ingest", "10.1051/0004-6361/202039341", "--data-dir", join(root, "data")],
      childEnv(root)
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("in development");
  });
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
