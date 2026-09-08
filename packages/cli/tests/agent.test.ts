/**
 * Agent-subcommand tests (Stage 2 / MS1): invoke the *built* CLI
 * (`dist/bin.js`) against a throwaway data dir — one golden reader doc under
 * `output/` plus a copy of the core fixture `library.json` (34 works).
 *
 * Covers: `search` JSONL shape + its empty-note stderr hint (Stage 3 / MS4),
 * `read` markdown (+ `--section` / `--manifest`), `show` / `ref` happy paths
 * and unknown-id error quality, `note` / `label` store mutation, and the
 * `list` overview.
 *
 * Hermeticity: same conventions as smoke.test.ts — `HOME` in a tmp dir,
 * ambient `ARGELANDERSPACE_*` scrubbed, and `XDG_CONFIG_HOME` pointed at the
 * tmp home so a real user config.toml can't leak a `port` into the deep links.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const DOC_ID = "arxiv-2501.17225";
const WORK_ID = "arxiv:2603.03522";
const LINK = `http://localhost:8000/doc/${DOC_ID}`;

/** Child env: scrubbed ARGELANDERSPACE_*, HOME + XDG_CONFIG_HOME in tmp. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ARGELANDERSPACE_")) delete env[k];
  }
  env.XDG_CONFIG_HOME = join(home, "xdg");
  env.PATH = `${env.PATH ?? ""}${delimiter}/home/wwu/miniforge3/envs/astro/bin`;
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
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * A fresh fixture data dir: one golden reader doc + the 34-work fixture
 * library. Fresh per test so note/label mutations stay isolated.
 */
function makeDataDir(): { root: string; dataDir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-agent-"));
  const dataDir = join(root, "data");
  const docDir = join(dataDir, "output", DOC_ID);
  mkdirSync(docDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "tests", "golden", "tex", `${DOC_ID}.json`),
    join(docDir, `${DOC_ID}.json`)
  );
  mkdirSync(join(dataDir, "library"), { recursive: true });
  copyFileSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  return { root, dataDir, env: childEnv(root) };
}

/** stdout lines parsed as JSON (JSONL assertions). */
function parseJsonl(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Rewrite each work's note in the fixture library via `fn(workId)`. */
function rewriteNotes(dataDir: string, fn: (id: string) => string): void {
  const file = join(dataDir, "library", "library.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    works: { id: string; note?: string | null }[];
  };
  for (const w of data.works) w.note = fn(w.id);
  writeFileSync(file, JSON.stringify(data));
}

describe("search", () => {
  test("prints one JSON index row per library work", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["search", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    // the fixture library ships 34 works, all with note: null → hint on stderr
    expect(r.stderr).toBe("hint: 34/34 works have empty notes\n");
    const rows = parseJsonl(r.stdout);
    expect(rows.length).toBe(34);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "id",
          "title",
          "year",
          "venue",
          "authors",
          "arxiv_id",
          "doi",
          "cited_by_count",
          "note",
          "tags",
          "label",
          "read",
          "star",
          "doc_ids",
        ].sort()
      );
      expect(Array.isArray(row.doc_ids)).toBe(true);
      expect(Array.isArray(row.tags)).toBe(true);
    }
    const w = rows.find((x) => x.id === WORK_ID);
    expect(w).toMatchObject({
      title:
        "Most open clusters follow the radial acceleration relation (RAR) and the baryonic Tully-Fisher relation (BTFR)",
      authors: "Huisjes & Hernández",
      arxiv_id: "2603.03522",
      read: false,
      star: false,
    });
  });

  test("stderr hint counts only empty notes (whitespace-only counts as empty)", () => {
    const { dataDir, env } = makeDataDir();
    // one real note; the other 33 get whitespace-only notes → still empty
    rewriteNotes(dataDir, (id) => (id === WORK_ID ? "tidal-tail reference" : "   "));
    const r = runCli(["search", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("hint: 33/34 works have empty notes\n");
    // stdout stays pure JSONL
    expect(parseJsonl(r.stdout).length).toBe(34);
  });

  test("no hint when every work has a note", () => {
    const { dataDir, env } = makeDataDir();
    rewriteNotes(dataDir, () => "noted");
    const r = runCli(["search", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(parseJsonl(r.stdout).length).toBe(34);
  });
});

describe("read", () => {
  test("whole doc: header with title + deep link, then token-converted markdown", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("# Tidal tails of nearby open clusters")).toBe(true);
    expect(r.stdout).toContain(`link: ${LINK}`);
    expect(r.stdout).toContain("\n# 1 Introduction\n");
    expect(r.stdout).toContain("[cite: ref-6 | Bok 1934]");
    expect(r.stdout).toMatch(/\[ref: fig-1 \| figure \| number: 1 \|/);
    expect(r.stdout).not.toContain("[[cite:");
    expect(r.stdout).not.toContain("[[xref:");
  });

  test("--section renders one subtree with a section deep link", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--section", "sec-2", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`link: ${LINK}#sec-2`);
    expect(r.stdout).toContain("# 1 Introduction");
    expect(r.stdout).not.toContain("# Abstract");
    expect(r.stdout).not.toContain("# 2 Data");
  });

  test("--section with an unknown id lists available sections", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--section", "sec-999", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: unknown section "sec-999"');
    expect(r.stderr).toContain("sec-2");
  });

  test("--manifest refs: stdout is pure JSONL, header + link on stderr", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--manifest", "refs", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(LINK);
    const rows = parseJsonl(r.stdout);
    expect(rows.length).toBe(79); // 38 sections + 25 figs + 4 tables + 12 eqs
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.kind).toBe("string");
      expect(typeof row.content).toBe("string");
    }
    const fig1 = rows.find((x) => x.id === "fig-1");
    expect(fig1).toMatchObject({ kind: "figure", number: "1", section: "4:Results" });
  });

  test("--manifest bib: one row per reference", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--manifest", "bib", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    const rows = parseJsonl(r.stdout);
    expect(rows.length).toBe(76);
    expect(rows.find((x) => x.id === "ref-6")).toMatchObject({ short: "Bok 1934", year: 1934 });
  });

  test("--manifest with a bad kind is an actionable error", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", DOC_ID, "--manifest", "nope", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("error: --manifest must be refs|bib");
  });

  test("unknown doc id lists the available docs", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["read", "nope", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: unknown doc "nope"');
    expect(r.stderr).toContain(DOC_ID);
  });
});

describe("show", () => {
  test("figure: kind/number/caption/image URL + deep link", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["show", DOC_ID, "fig-1", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      doc_id: DOC_ID,
      id: "fig-1",
      kind: "figure",
      number: "1",
      image: `/images/${DOC_ID}/figures__All_in_one_XY__pdf.svg`,
      link: `${LINK}#fig-1`,
    });
    expect(out.caption).toContain("$X-Y$ plot of all the clusters");
  });

  test("equation: latex, no caption/image keys", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["show", DOC_ID, "eq-1", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ id: "eq-1", kind: "equation", number: "1" });
    expect(out.latex).toContain("\\sigma_{\\text{Dist}}");
    expect("caption" in out).toBe(false);
    expect(out.link).toBe(`${LINK}#eq-1`);
  });

  test("unknown float id suggests the closest matches", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["show", DOC_ID, "fig-999", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: unknown float "fig-999"');
    expect(r.stderr).toContain("fig-9");
  });
});

describe("ref", () => {
  test("by id: structured fields + raw + citing blocks + deep link", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["ref", DOC_ID, "ref-6", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      doc_id: DOC_ID,
      id: "ref-6",
      short: "Bok 1934",
      year: 1934,
      link: `${LINK}#ref-6`,
    });
    expect(out.raw).toContain("Bok, B. J. 1934");
    expect(out.cited_in).toContain("p-6");
  });

  test("by match key resolves to the same entry", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["ref", DOC_ID, "Bok 1934", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as Record<string, unknown>).id).toBe("ref-6");
  });

  test("unknown reference suggests the closest matches", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["ref", DOC_ID, "ref-999", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: unknown reference "ref-999"');
    expect(r.stderr).toContain("closest matches: ref-9");
  });
});

describe("note", () => {
  test("sets, then prints the current note; persists to library.json", () => {
    const { dataDir, env } = makeDataDir();
    const r1 = runCli(["note", WORK_ID, "tidal", "tails", "paper", "--data-dir", dataDir], env);
    expect(r1.status).toBe(0);
    expect(JSON.parse(r1.stdout)).toEqual({ id: WORK_ID, note: "tidal tails paper" });
    const r2 = runCli(["note", WORK_ID, "--data-dir", dataDir], env);
    expect(JSON.parse(r2.stdout)).toEqual({ id: WORK_ID, note: "tidal tails paper" });
    const onDisk = JSON.parse(readFileSync(join(dataDir, "library", "library.json"), "utf8")) as {
      works: { id: string; note?: string }[];
    };
    expect(onDisk.works.find((w) => w.id === WORK_ID)?.note).toBe("tidal tails paper");
  });

  test("unknown work id is an actionable error", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["note", "work:bogus", "x", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: unknown work "work:bogus"');
    expect(r.stderr).toContain(WORK_ID);
  });
});

describe("label", () => {
  test("patches read/star/tags/label and persists", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(
      [
        "label",
        WORK_ID,
        "--read",
        "true",
        "--star",
        "true",
        "--tags",
        "alpha, beta",
        "--label",
        "yellow",
        "--data-dir",
        dataDir,
      ],
      env
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      id: WORK_ID,
      label: "yellow",
      read: true,
      star: true,
      tags: ["alpha", "beta"],
    });
    const onDisk = JSON.parse(readFileSync(join(dataDir, "library", "library.json"), "utf8")) as {
      works: { id: string; read?: boolean; star?: boolean; tags?: string[]; label?: string }[];
    };
    const w = onDisk.works.find((x) => x.id === WORK_ID);
    expect(w).toMatchObject({ read: true, star: true, label: "yellow", tags: ["alpha", "beta"] });
  });

  test("a non-boolean --read is an actionable error", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["label", WORK_ID, "--read", "maybe", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error: --read must be true|false, got "maybe"');
  });
});

describe("list", () => {
  test("overview counts + one compact line per doc with its deep link", () => {
    const { dataDir, env } = makeDataDir();
    const r = runCli(["list", "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("library: works=34 docs=1 read=0 unread=34 labeled=0");
    expect(lines[1]).toBe(
      `doc: ${DOC_ID} | latex | sec=38 | refs=76 | ` +
        `Tidal tails of nearby open clusters — I. Mapping with Gaia DR3 | ${LINK}`
    );
  });
});
