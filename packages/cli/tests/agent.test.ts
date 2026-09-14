/**
 * Agent-subcommand tests (Stage 2 / MS1): invoke the *built* CLI
 * (`dist/bin.js`) against a throwaway data dir — one golden reader doc under
 * `output/` plus a copy of the core fixture `library.json` (34 works).
 *
 * Covers: `search` JSONL shape + its empty-note stderr hint (Stage 3 / MS4),
 * `read` markdown (+ `--section` / `--manifest`), `show` / `ref` happy paths
 * and unknown-id error quality, `note` / `label` store mutation, the
 * `list` overview, and the `annot` JSONL contract (Stage 8 / MS5 — byte-exact
 * freeze guard over the golden tex doc + its assets, which the content
 * fingerprint hashes).
 *
 * Hermeticity: same conventions as smoke.test.ts — `HOME` in a tmp dir,
 * ambient `ARGELANDERSPACE_*` scrubbed, and `XDG_CONFIG_HOME` pointed at the
 * tmp home so a real user config.toml can't leak a `port` into the deep links.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Annotation,
  AnnotationSchema,
  canonicalContainerText,
  canonicalSegmentsText,
  type DocIr,
  type IrBlock,
  TexDocIrSchema,
} from "@argelanderspace/contracts";
import { docContentFingerprint } from "@argelanderspace/core";
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

describe("annot", () => {
  const TITLE = "Tidal tails of nearby open clusters — I. Mapping with Gaia DR3";
  const T0 = "2026-09-10T08:00:00.000Z";
  const T1 = "2026-09-10T09:30:00.000Z";
  /** The fixed mismatch note (frozen from birth — roadmap §6). */
  const STALE_NOTE =
    "note: document content changed since its annotations were written; " +
    "they are archived and not shown";

  /** The golden doc + its figure assets (the content fingerprint hashes asset bytes). */
  function makeAnnotDataDir(): { dataDir: string; env: NodeJS.ProcessEnv; docDir: string } {
    const { dataDir, env } = makeDataDir();
    const docDir = join(dataDir, "output", DOC_ID);
    cpSync(join(REPO_ROOT, "tests", "golden", "tex", "assets-2501.17225"), join(docDir, "assets"), {
      recursive: true,
    });
    return { dataDir, env, docDir };
  }

  function fixtureIr(docDir: string): DocIr {
    return TexDocIrSchema.parse(JSON.parse(readFileSync(join(docDir, `${DOC_ID}.json`), "utf8")));
  }

  function blockOf(ir: DocIr, id: string): IrBlock {
    const walk = function* (sections: DocIr["sections"]): Generator<IrBlock> {
      for (const s of sections) {
        yield* s.blocks;
        yield* walk(s.children);
      }
    };
    for (const b of walk(ir.sections)) if (b.id === id) return b;
    throw new Error(`fixture block ${id} not found`);
  }

  function contextOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
    if (row === undefined || typeof row.context !== "object" || row.context === null) {
      throw new Error("expected a row with a context object");
    }
    return row.context as Record<string, unknown>;
  }

  interface AnnotFixture {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    docDir: string;
    currentPath: string;
    /** Expected stdout rows in output order (frozen JSONL shape). */
    expected: Record<string, unknown>[];
  }

  /**
   * A doc with a populated annotation store: seven annotations covering every
   * target shape, stored SCRAMBLED so the reading-order sort is exercised (a
   * text and a structure annotation share block p-23 to pin the stored-order
   * tiebreak). The rows pass through `AnnotationSchema` before being written,
   * so the file bytes and the expected rows share the schema's key order.
   */
  function setupAnnotatedDoc(): AnnotFixture {
    const { dataDir, env, docDir } = makeAnnotDataDir();
    const ir = fixtureIr(docDir);
    const p23Text = canonicalContainerText(blockOf(ir, "p-23"), { type: "content" });
    const list1 = blockOf(ir, "list-1");
    if (list1.type !== "list") throw new Error("fixture drift: list-1 is not a list");
    const list1Items = list1.items.map((it) => canonicalSegmentsText(it.segments));
    const fig1Caption = canonicalContainerText(blockOf(ir, "fig-1"), { type: "caption" });
    const eq1 = blockOf(ir, "eq-1");
    if (eq1.type !== "equation") throw new Error("fixture drift: eq-1 is not an equation");
    const raw: Annotation[] = [
      {
        id: "a_00000005",
        target: {
          type: "text",
          block: "fig-1",
          container: { type: "caption" },
          start: 0,
          end: 30,
          quote: fig1Caption.slice(0, 30),
        },
        body: "caption should mention the interactive figure",
        created_at: T0,
        updated_at: T1,
      },
      {
        id: "a_00000001",
        target: { type: "document" },
        body: "strong paper; cite in review",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "a_00000003",
        target: {
          type: "structure",
          id: "eq-1",
          kind: "equation",
          snapshot: { number: "1", label: "eq:Dist_err", latex: eq1.latex },
        },
        body: "why $\\omega_2$ in the denominator?",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "a_00000004",
        target: {
          type: "text",
          block: "p-23",
          container: { type: "content" },
          start: 15,
          end: 23,
          quote: "the grid",
        },
        body: "which grid resolution?",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "a_00000007",
        target: {
          type: "structure",
          id: "list-1",
          kind: "list",
          snapshot: { ordered: false, items: list1Items },
        },
        body: "third bullet needs a citation",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "a_00000002",
        target: {
          type: "structure",
          id: "sec-4",
          kind: "section",
          snapshot: { number: "2.1", heading: "Gaia data" },
        },
        body: "merge into 2.2?",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "a_00000006",
        target: {
          type: "structure",
          id: "p-23",
          kind: "paragraph",
          snapshot: { text: p23Text },
        },
        body: "define X^2 here",
        created_at: T0,
        updated_at: T0,
      },
    ];
    const annotations = raw.map((a) => AnnotationSchema.parse(a));
    const dir = join(dataDir, "annotations", DOC_ID);
    mkdirSync(dir, { recursive: true });
    const currentPath = join(dir, "current.json");
    writeFileSync(
      currentPath,
      JSON.stringify(
        {
          version: 1,
          rev: 7,
          content_fingerprint: docContentFingerprint(ir, { docDir }),
          annotations,
        },
        null,
        2
      )
    );
    const byId = (id: string): Annotation => {
      const a = annotations.find((x) => x.id === id);
      if (a === undefined) throw new Error(`fixture annotation ${id}`);
      return a;
    };
    const row = (a: Annotation, context: Record<string, unknown>): Record<string, unknown> => ({
      id: a.id,
      doc_id: DOC_ID,
      target: a.target,
      context,
      body: a.body,
      created_at: a.created_at,
      updated_at: a.updated_at,
      link: `${LINK}#ann-${a.id}`,
    });
    const expected = [
      row(byId("a_00000001"), { title: TITLE }),
      row(byId("a_00000002"), { section_id: "sec-4", section_path: ["2 Data", "2.1 Gaia data"] }),
      row(byId("a_00000003"), { section_id: "sec-4", section_path: ["2 Data", "2.1 Gaia data"] }),
      row(byId("a_00000004"), {
        section_id: "sec-7",
        section_path: ["3 Methods", "3.1 CP method"],
        container_text: p23Text,
      }),
      row(byId("a_00000006"), {
        section_id: "sec-7",
        section_path: ["3 Methods", "3.1 CP method"],
        container_text: p23Text,
      }),
      row(byId("a_00000005"), {
        section_id: "sec-11",
        section_path: ["4 Results"],
        container_text: fig1Caption,
      }),
      row(byId("a_00000007"), {
        section_id: "sec-33",
        section_path: ["6 Conclusions"],
        container_text: list1Items.join("\n"),
      }),
    ];
    return { dataDir, env, docDir, currentPath, expected };
  }

  test("one JSONL row per annotation, reading order — whole stdout byte-exact", () => {
    const f = setupAnnotatedDoc();
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${f.expected.map((row) => JSON.stringify(row)).join("\n")}\n`);
  });

  test("frozen field order + per-target-type context (literal spot checks)", () => {
    const f = setupAnnotatedDoc();
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(0);
    const rows = parseJsonl(r.stdout);
    expect(rows.map((x) => x.id)).toEqual([
      "a_00000001", // document-level first
      "a_00000002", // sec-4
      "a_00000003", // eq-1 (inside sec-4)
      "a_00000004", // p-23 text — stored before a_00000006, same block
      "a_00000006", // p-23 paragraph
      "a_00000005", // fig-1 caption text
      "a_00000007", // list-1 (Conclusions)
    ]);
    for (const x of rows) {
      expect(Object.keys(x)).toEqual([
        "id",
        "doc_id",
        "target",
        "context",
        "body",
        "created_at",
        "updated_at",
        "link",
      ]);
    }
    // document row: context is the title only; link carries the #ann-<id> anchor
    expect(rows[0]).toEqual({
      id: "a_00000001",
      doc_id: DOC_ID,
      target: { type: "document" },
      context: { title: TITLE },
      body: "strong paper; cite in review",
      created_at: T0,
      updated_at: T0,
      link: `${LINK}#ann-a_00000001`,
    });
    // structure-section row, full literal: location-only context
    expect(rows[1]).toEqual({
      id: "a_00000002",
      doc_id: DOC_ID,
      target: {
        type: "structure",
        id: "sec-4",
        kind: "section",
        snapshot: { number: "2.1", heading: "Gaia data" },
      },
      context: { section_id: "sec-4", section_path: ["2 Data", "2.1 Gaia data"] },
      body: "merge into 2.2?",
      created_at: T0,
      updated_at: T0,
      link: `${LINK}#ann-a_00000002`,
    });
    // structure-equation row: no container_text (full content via `show`)
    expect(rows[2]?.context).toEqual({
      section_id: "sec-4",
      section_path: ["2 Data", "2.1 Gaia data"],
    });
    // text row on p-23: literal target + the FULL canonical container text
    expect(rows[3]?.target).toEqual({
      type: "text",
      block: "p-23",
      container: { type: "content" },
      start: 15,
      end: 23,
      quote: "the grid",
    });
    expect(contextOf(rows[3]).container_text).toBe(
      "The point from the grid with the lowest value of $X^{2}$ was selected as the CP."
    );
    // list structure row: container_text = items' canonical texts joined with "\n"
    const items = (contextOf(rows[6]).container_text as string).split("\n");
    expect(items.length).toBe(6);
    expect(items[0]).toBe(
      "We analysed 21 nearby clusters older than 100 Myr with a minimum of 100 members using " +
        "the CP (and the new SCCP) method to identify their tidal tails if they exist. " +
        "We found tidal tails in 19 clusters and a stellar halo for one cluster."
    );
  });

  test("content changed: empty stdout + one fixed stderr note, exit 0, nothing written", () => {
    const f = setupAnnotatedDoc();
    const before = readFileSync(f.currentPath, "utf8");
    const docJson = join(f.docDir, `${DOC_ID}.json`);
    const src = readFileSync(docJson, "utf8");
    if (!src.includes("was selected as the CP.")) throw new Error("fixture drift");
    writeFileSync(docJson, src.replace("was selected as the CP.", "was selected as the CP!"));
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${STALE_NOTE}\n`);
    // truly read-only: current.json byte-identical, no archive/ dir appeared
    expect(readFileSync(f.currentPath, "utf8")).toBe(before);
    expect(existsSync(join(f.dataDir, "annotations", DOC_ID, "archive"))).toBe(false);
  });

  test("missing annotations file: empty stdout, exit 0, silent stderr", () => {
    const { dataDir, env } = makeAnnotDataDir();
    const r = runCli(["annot", DOC_ID, "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("zero annotations: empty stdout, exit 0 — no note even on a stale fingerprint", () => {
    const { dataDir, env } = makeAnnotDataDir();
    const dir = join(dataDir, "annotations", DOC_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "current.json"),
      JSON.stringify({
        version: 1,
        rev: 0,
        content_fingerprint: "0".repeat(64), // wrong on purpose: empty short-circuits first
        annotations: [],
      })
    );
    const r = runCli(["annot", DOC_ID, "--data-dir", dataDir], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("unknown doc id is the standard actionable error", () => {
    const { dataDir, env } = makeAnnotDataDir();
    const r = runCli(["annot", "nope", "--data-dir", dataDir], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: unknown doc "nope" — available: ${DOC_ID}\n`);
  });

  test("corrupt current.json is an error, never a silent reset", () => {
    const f = setupAnnotatedDoc();
    writeFileSync(f.currentPath, "{ not json");
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: annotations store:");
    expect(r.stderr).toContain("is not valid JSON");
    expect(readFileSync(f.currentPath, "utf8")).toBe("{ not json");
  });

  test("an unreadable figure asset fails the fingerprint: error, files untouched", () => {
    const f = setupAnnotatedDoc();
    const before = readFileSync(f.currentPath, "utf8");
    rmSync(join(f.docDir, "assets", "figures__All_in_one_XY__pdf.svg"));
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const asset = join(f.docDir, "assets", "figures__All_in_one_XY__pdf.svg");
    expect(r.stderr).toBe(
      `error: annotations fingerprint: cannot read asset "figures__All_in_one_XY__pdf.svg" (${asset}): ENOENT: no such file or directory, stat '${asset}'\n`
    );
    expect(readFileSync(f.currentPath, "utf8")).toBe(before);
  });

  test("stable asset symlink outside doc keeps byte-exact normal CLI output and remains read-only", () => {
    const f = setupAnnotatedDoc();
    const before = readFileSync(f.currentPath);
    const normal = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    const asset = join(f.docDir, "assets", "figures__All_in_one_XY__pdf.svg");
    const outside = join(f.dataDir, "outside.svg");
    copyFileSync(asset, outside);
    rmSync(asset);
    symlinkSync(outside, asset);
    const linked = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(linked).toEqual(normal);
    expect(linked.status).toBe(0);
    expect(linked.stderr).toBe("");
    expect(linked.stdout).not.toBe("");
    expect(readFileSync(f.currentPath)).toEqual(before);
    expect(existsSync(join(f.dataDir, "annotations", DOC_ID, "archive"))).toBe(false);
  });

  test("corrupt doc IR is an error and leaves the store untouched", () => {
    const f = setupAnnotatedDoc();
    const before = readFileSync(f.currentPath, "utf8");
    writeFileSync(join(f.docDir, `${DOC_ID}.json`), "{ nope");
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("error: ")).toBe(true);
    expect(readFileSync(f.currentPath, "utf8")).toBe(before);
  });

  test("a dangling target id fails with stdout COMPLETELY empty (no partial rows)", () => {
    const f = setupAnnotatedDoc();
    const stored = JSON.parse(readFileSync(f.currentPath, "utf8")) as {
      annotations: Annotation[];
    };
    // schema-valid but pointing at a block the IR doesn't carry; a dangling
    // target sorts LAST, so this also pins "no rows printed before the throw".
    stored.annotations.push(
      AnnotationSchema.parse({
        id: "a_00000009",
        target: {
          type: "text",
          block: "p-9999",
          container: { type: "content" },
          start: 0,
          end: 1,
          quote: "x",
        },
        body: "hand-edited dangling annotation",
        created_at: T0,
        updated_at: T0,
      })
    );
    const before = JSON.stringify(stored, null, 2);
    writeFileSync(f.currentPath, before);
    const r = runCli(["annot", DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      `error: annotation target "p-9999" is not in doc "${DOC_ID}" (inconsistent store)`
    );
    expect(readFileSync(f.currentPath, "utf8")).toBe(before);
  });
});
