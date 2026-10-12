/**
 * Argument-graph CLI tests (论证图 ticket 07): `argument get` / `argument put` / `pdf-path`, invoked as the
 * *built* CLI (`dist/bin.js`) against a throwaway data dir (the 34-work fixture library; never the repo's
 * `literatures/`). The byte-exact assertions below are the freeze guard of these commands once released
 * (contracts "论证图"); the full list lives in the ticket's Comments.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argumentGraphPath } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const WORK_ID = "arxiv:2603.03522";
const OTHER_WORK_ID = "arxiv:2603.00001";
const LATEX_DOC_ID = "arxiv-2501.17225";

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("ARGELANDERSPACE_")) delete env[k];
  env.XDG_CONFIG_HOME = join(home, "xdg");
  env.PATH = `${env.PATH ?? ""}${delimiter}/home/wwu/miniforge3/envs/astro/bin`;
  return env;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): RunResult {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeDataDir() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-argument-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  copyFileSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  return { root, dataDir, env: childEnv(root), file: (name: string) => join(root, name) };
}

/** Every file and directory under `dir`, relative, sorted, with sizes of files (to prove nothing changed). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(join(d, e.name), r);
      } else {
        out.push(`${r} ${readFileSync(join(d, e.name)).length}`);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

const GRAPH = {
  version: 1,
  rev: 0,
  work_id: WORK_ID,
  arguments: [
    {
      id: "a1",
      title: "Cluster RAR",
      claim: "Open clusters follow the RAR",
      grounds: "Gaia DR3 kinematics",
      warrant: "",
      backing: "",
      qualifier: "mostly",
      rebuttal: "",
      warrant_implicit: true,
      kind: "end",
      sources: [
        { text: "Section 3.2", target: { doc_id: LATEX_DOC_ID, anchor: "sec-3" } },
        { text: "p. 4", target: { doc_id: "pdf-x1", page: 4 } },
        { text: "Eq. 2" },
      ],
    },
    { id: "a2", title: "Data quality" },
  ],
  edges: [{ from: "a2", to: "a1", role: "grounds" }],
};

/** `GRAPH` as `argument get` prints it after a `put` (rev 1, defaults filled, frozen key order). */
const GRAPH_GOLDEN = `{
  "version": 1,
  "rev": 1,
  "work_id": "arxiv:2603.03522",
  "arguments": [
    {
      "id": "a1",
      "title": "Cluster RAR",
      "claim": "Open clusters follow the RAR",
      "grounds": "Gaia DR3 kinematics",
      "warrant": "",
      "backing": "",
      "qualifier": "mostly",
      "rebuttal": "",
      "warrant_implicit": true,
      "kind": "end",
      "sources": [
        {
          "text": "Section 3.2",
          "target": {
            "doc_id": "arxiv-2501.17225",
            "anchor": "sec-3"
          }
        },
        {
          "text": "p. 4",
          "target": {
            "doc_id": "pdf-x1",
            "page": 4
          }
        },
        {
          "text": "Eq. 2"
        }
      ]
    },
    {
      "id": "a2",
      "title": "Data quality",
      "claim": "",
      "grounds": "",
      "warrant": "",
      "backing": "",
      "qualifier": "",
      "rebuttal": "",
      "warrant_implicit": false,
      "kind": "normal",
      "sources": []
    }
  ],
  "edges": [
    {
      "from": "a2",
      "to": "a1",
      "role": "grounds"
    }
  ]
}
`;

const EMPTY_GOLDEN = `{
  "version": 1,
  "rev": 0,
  "work_id": "arxiv:2603.03522",
  "arguments": [],
  "edges": []
}
`;

function putGraph(
  f: ReturnType<typeof makeDataDir>,
  graph: unknown,
  args: string[] = ["--rev", "0"]
): RunResult {
  const file = f.file("graph.json");
  writeFileSync(file, typeof graph === "string" ? graph : JSON.stringify(graph));
  return runCli(["argument", "put", WORK_ID, file, ...args, "--data-dir", f.dataDir], f.env);
}

describe("argument get", () => {
  test("a work without a graph: the empty graph at rev 0, byte-exact, nothing created", () => {
    const f = makeDataDir();
    const before = snapshot(f.root);
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({ status: 0, stdout: EMPTY_GOLDEN, stderr: "" });
    expect(snapshot(f.root)).toEqual(before);
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  test("an existing graph: frozen key order, whatever order the stored file has; read leaves files alone", () => {
    const f = makeDataDir();
    expect(putGraph(f, GRAPH).status).toBe(0);
    // scramble the stored key order by hand: the output order must not follow it
    const file = argumentGraphPath(f.dataDir, WORK_ID);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const scrambled = Object.fromEntries(Object.entries(stored).reverse());
    scrambled.arguments = (stored.arguments as Record<string, unknown>[]).map((a) =>
      Object.fromEntries(Object.entries(a).reverse())
    );
    writeFileSync(file, JSON.stringify(scrambled));
    const before = snapshot(f.root);
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({ status: 0, stdout: GRAPH_GOLDEN, stderr: "" });
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a zero-argument graph at rev 3 is printed as stored (the rev is what put needs)", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    writeFileSync(
      argumentGraphPath(f.dataDir, WORK_ID),
      JSON.stringify({ version: 1, rev: 3, work_id: WORK_ID, arguments: [], edges: [] })
    );
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(EMPTY_GOLDEN.replace('"rev": 0', '"rev": 3'));
  });

  test("unknown work: error with candidates, exit 1, empty stdout", () => {
    const f = makeDataDir();
    const r = runCli(["argument", "get", "arxiv:2603.0352", "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: unknown work "arxiv:2603.0352" — closest matches: ${WORK_ID}\n`.replace(
        "closest matches: arxiv:2603.03522",
        "closest matches: arxiv:2603.03522"
      )
    );
  });

  test("unknown work far from any id: the truncated full list", () => {
    const f = makeDataDir();
    const r = runCli(["argument", "get", "nope", "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^error: unknown work "nope" — available: .+ … \(34 total\)\n$/);
  });

  test("a graph file of a work that is not in the library is not shown", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    writeFileSync(
      argumentGraphPath(f.dataDir, "arxiv:gone"),
      JSON.stringify({ version: 1, rev: 2, work_id: "arxiv:gone", arguments: [], edges: [] })
    );
    const r = runCli(["argument", "get", "arxiv:gone", "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: unknown work "arxiv:gone"/);
  });

  test.each([
    ["not JSON", "{oops", "not valid JSON"],
    ["schema-invalid", JSON.stringify({ version: 1 }), "failed schema validation"],
    [
      "future version",
      JSON.stringify({ version: 2, rev: 1, work_id: WORK_ID, arguments: [], edges: [] }),
      "has version 2; this build only reads version 1",
    ],
    [
      "another work's file",
      JSON.stringify({ version: 1, rev: 1, work_id: OTHER_WORK_ID, arguments: [], edges: [] }),
      `belongs to work "${OTHER_WORK_ID}"`,
    ],
  ])(
    "unreadable graph file (%s): error, exit 1, no graph on stdout, file untouched",
    (_n, text, msg) => {
      const f = makeDataDir();
      mkdirSync(join(f.dataDir, "argument-graphs"));
      const file = argumentGraphPath(f.dataDir, WORK_ID);
      writeFileSync(file, text);
      const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`error: argument graph: ${file} ${msgTail(msg, text)}\n`);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  );
});

/** The store's own message tails, spelled out so the CLI's `error: ` + store message form is pinned. */
function msgTail(msg: string, text: string): string {
  if (msg === "not valid JSON") {
    let detail = "";
    try {
      JSON.parse(text);
    } catch (e) {
      detail = (e as Error).message;
    }
    return `is not valid JSON: ${detail}`;
  }
  if (msg === "failed schema validation") {
    return "failed schema validation: rev: Invalid input: expected number, received undefined; work_id: Invalid input: expected string, received undefined; arguments: Invalid input: expected array, received undefined; edges: Invalid input: expected array, received undefined";
  }
  return msg;
}

describe("argument put", () => {
  test("writes a new graph: stdout is the new rev, then get prints it back", () => {
    const f = makeDataDir();
    const r = putGraph(f, GRAPH);
    expect(r).toEqual({ status: 0, stdout: `{"work_id":"${WORK_ID}","rev":1}\n`, stderr: "" });
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g.stdout).toBe(GRAPH_GOLDEN);
    expect(existsSync(`${argumentGraphPath(f.dataDir, WORK_ID)}.tmp`)).toBe(false);
  });

  test("work_id may be left out; the file's own rev is ignored in favour of --rev", () => {
    const f = makeDataDir();
    const { work_id: _w, ...noWork } = { ...GRAPH, rev: 99 };
    const r = putGraph(f, noWork);
    expect(r.stdout).toBe(`{"work_id":"${WORK_ID}","rev":1}\n`);
  });

  test("reads stdin with '-'", () => {
    const f = makeDataDir();
    const r = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      JSON.stringify(GRAPH)
    );
    expect(r).toEqual({ status: 0, stdout: `{"work_id":"${WORK_ID}","rev":1}\n`, stderr: "" });
  });

  test("a zero-argument stored graph needs no --replace; rev 3 → 4", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    writeFileSync(
      argumentGraphPath(f.dataDir, WORK_ID),
      JSON.stringify({ version: 1, rev: 3, work_id: WORK_ID, arguments: [], edges: [] })
    );
    const r = putGraph(f, GRAPH, ["--rev", "3"]);
    expect(r.stdout).toBe(`{"work_id":"${WORK_ID}","rev":4}\n`);
  });

  test("a non-empty stored graph: without --replace refused, zero write", () => {
    const f = makeDataDir();
    expect(putGraph(f, GRAPH).status).toBe(0);
    const file = argumentGraphPath(f.dataDir, WORK_ID);
    const before = readFileSync(file, "utf8");
    const r = putGraph(f, { ...GRAPH, arguments: [GRAPH.arguments[1]], edges: [] }, ["--rev", "1"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: work "${WORK_ID}" already has a graph with 2 arguments; pass --replace to replace it; nothing was written\n`,
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("--replace with the right rev replaces (and may empty) a non-empty graph", () => {
    const f = makeDataDir();
    expect(putGraph(f, GRAPH).status).toBe(0);
    const r = putGraph(f, { version: 1, arguments: [], edges: [] }, ["--rev", "1", "--replace"]);
    expect(r.stdout).toBe(`{"work_id":"${WORK_ID}","rev":2}\n`);
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g.stdout).toBe(EMPTY_GOLDEN.replace('"rev": 0', '"rev": 2'));
  });

  test("rev mismatch (stale and ahead): refused with the current rev, zero write; checked before --replace", () => {
    const f = makeDataDir();
    expect(putGraph(f, GRAPH).status).toBe(0);
    const file = argumentGraphPath(f.dataDir, WORK_ID);
    const before = readFileSync(file, "utf8");
    for (const given of ["0", "7"]) {
      const r = putGraph(f, GRAPH, ["--rev", given, "--replace"]);
      expect(r).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: rev mismatch: the stored graph of work "${WORK_ID}" is at rev 1, --rev ${given} was given; run \`argument get\` again and rebase your changes; nothing was written\n`,
      });
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("--rev is required, and must be a non-negative integer", () => {
    const f = makeDataDir();
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const missing = runCli(["argument", "put", WORK_ID, file, "--data-dir", f.dataDir], f.env);
    expect(missing).toEqual({
      status: 1,
      stdout: "",
      stderr: "error: required option '--rev <n>' not specified\n",
    });
    for (const bad of ["-1", "1.5", "abc", "01", ""]) {
      const r = runCli(
        ["argument", "put", WORK_ID, file, `--rev=${bad}`, "--data-dir", f.dataDir],
        f.env
      );
      expect(r).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: --rev must be a non-negative integer, got "${bad}"\n`,
      });
    }
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  }, 30_000);

  test("unknown work: error with candidates, nothing written", () => {
    const f = makeDataDir();
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const r = runCli(
      ["argument", "put", "arxiv:2603.0352", file, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: unknown work "arxiv:2603.0352" — closest matches: ${WORK_ID}\n`);
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  test("work_id in the file that differs from the work: refused, zero write", () => {
    const f = makeDataDir();
    const r = putGraph(f, { ...GRAPH, work_id: OTHER_WORK_ID });
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: work_id in "${f.file("graph.json")}" ("${OTHER_WORK_ID}") does not match the work given ("${WORK_ID}")\n`,
    });
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  test("file missing / not JSON: fixed messages, zero write", () => {
    const f = makeDataDir();
    const gone = f.file("nope.json");
    const r1 = runCli(
      ["argument", "put", WORK_ID, gone, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(r1).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: cannot read "${gone}" (ENOENT)\n`,
    });
    const r2 = putGraph(f, "{oops");
    expect(r2).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: "${f.file("graph.json")}" is not valid JSON\n`,
    });
    const r3 = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      "not json"
    );
    expect(r3.stderr).toBe("error: stdin is not valid JSON\n");
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  const withArgs = (args: unknown[], edges: unknown[] = []) => ({
    version: 1,
    arguments: args,
    edges,
  });
  const A1 = { id: "a1", title: "One" };
  const A2 = { id: "a2", title: "Two" };

  test.each([
    [
      "blank title",
      withArgs([{ id: "a1", title: "  " }]),
      ["arguments.0.title: title must not be blank"],
    ],
    [
      "title too long",
      withArgs([{ id: "a1", title: "x".repeat(81) }]),
      ["arguments.0.title: Too big: expected string to have <=80 characters"],
    ],
    ["duplicate id", withArgs([A1, A1]), ["arguments.1.id: duplicate argument id a1"]],
    [
      "edge to a missing argument",
      withArgs([A1], [{ from: "a1", to: "ghost", role: "grounds" }]),
      ["edges.0.to: edge to refers to unknown argument ghost"],
    ],
    [
      "self-loop",
      withArgs([A1], [{ from: "a1", to: "a1", role: "warrant" }]),
      ["edges.0: self-loop on argument a1"],
    ],
    [
      "duplicate edge",
      withArgs(
        [A1, A2],
        [
          { from: "a1", to: "a2", role: "grounds" },
          { from: "a1", to: "a2", role: "grounds" },
        ]
      ),
      ["edges.1: duplicate grounds edge from a1 to a2"],
    ],
    [
      "unknown edge role",
      withArgs([A1, A2], [{ from: "a1", to: "a2", role: "claim" }]),
      ['edges.0.role: Invalid option: expected one of "grounds"|"warrant"|"backing"|"rebuttal"'],
    ],
    [
      "unknown key on an argument",
      withArgs([{ id: "a1", title: "One", mood: "x" }]),
      ['arguments.0: Unrecognized key: "mood"'],
    ],
    [
      "source with both anchor and page",
      withArgs([
        {
          id: "a1",
          title: "One",
          sources: [{ text: "s", target: { doc_id: "d", anchor: "sec-1", page: 2 } }],
        },
      ]),
      ["arguments.0.sources.0.target: a source target carries exactly one of anchor or page"],
    ],
    [
      "blank source text",
      withArgs([{ id: "a1", title: "One", sources: [{ text: "" }] }]),
      ["arguments.0.sources.0.text: Too small: expected string to have >=1 characters"],
    ],
    [
      "wrong version",
      { version: 2, arguments: [], edges: [] },
      ["version: Invalid input: expected 1"],
    ],
    ["not an object", [], ["<root>: Invalid input: expected object, received array"]],
  ])(
    "validation failure (%s): every issue by position, exit 1, zero write",
    (_name, graph, lines) => {
      const f = makeDataDir();
      const r = putGraph(f, graph);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        `error: "${f.file("graph.json")}" is not a valid argument graph (${lines.length} issue${lines.length === 1 ? "" : "s"}); nothing was written\n${lines.map((l) => `  ${l}`).join("\n")}\n`
      );
      expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
    }
  );

  test("several problems are all listed, in the order found", () => {
    const f = makeDataDir();
    const r = putGraph(
      f,
      withArgs([A1, { id: "a1", title: "" }], [{ from: "a1", to: "a1", role: "grounds" }])
    );
    expect(r.status).toBe(1);
    expect(r.stderr.split("\n").slice(1, -1)).toEqual([
      "  arguments.1.title: title must not be blank",
      "  arguments.1.id: duplicate argument id a1",
      "  edges.0: self-loop on argument a1",
    ]);
  });

  test("an unreadable stored graph is never overwritten", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    const file = argumentGraphPath(f.dataDir, WORK_ID);
    writeFileSync(file, "{oops");
    const r = putGraph(f, GRAPH, ["--rev", "0", "--replace"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^error: argument graph: .+ is not valid JSON: /);
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });
});

describe("pdf-path", () => {
  const PDF_ID = "pdf-11111111-1111-4111-8111-111111111111";

  function addPdfDoc(dataDir: string, id: string, opts: { original?: boolean } = {}) {
    const dir = join(dataDir, "output", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        version: 1,
        doc_id: id,
        format: "pdf",
        display_name: "paper.pdf",
        original_filename: "paper.pdf",
        acquired_via: "user_pdf_upload",
        acquired_at: "2026-10-12T00:00:00.000Z",
        byte_length: 9,
        sha256: "a".repeat(64),
        page_count: 1,
        pages: [{ width: 612, height: 792, rotation: 0 }],
      })
    );
    if (opts.original !== false) writeFileSync(join(dir, "original.pdf"), "%PDF-1.7\n");
  }

  test("prints the absolute path of the original, read-only, nothing else", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const before = snapshot(f.root);
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 0,
      stdout: `${join(f.dataDir, "output", PDF_ID, "original.pdf")}\n`,
      stderr: "",
    });
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a LaTeX doc is not a PDF doc", () => {
    const f = makeDataDir();
    const dir = join(f.dataDir, "output", LATEX_DOC_ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(
      join(REPO_ROOT, "tests", "golden", "tex", `${LATEX_DOC_ID}.json`),
      join(dir, `${LATEX_DOC_ID}.json`)
    );
    addPdfDoc(f.dataDir, PDF_ID);
    const r = runCli(["pdf-path", LATEX_DOC_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: doc "${LATEX_DOC_ID}" is not a PDF doc\n`,
    });
  });

  test("unknown doc: error with PDF candidates only", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const dir = join(f.dataDir, "output", LATEX_DOC_ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(
      join(REPO_ROOT, "tests", "golden", "tex", `${LATEX_DOC_ID}.json`),
      join(dir, `${LATEX_DOC_ID}.json`)
    );
    const r = runCli(["pdf-path", "pdf-1111", "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: unknown PDF doc "pdf-1111" — closest matches: ${PDF_ID}\n`,
    });
    const r2 = runCli(["pdf-path", "nope", "--data-dir", f.dataDir], f.env);
    expect(r2.stderr).toBe(`error: unknown PDF doc "nope" — available: ${PDF_ID}\n`);
  });

  test("no output directory at all, or a path-like id: unknown doc, nothing created", () => {
    const f = makeDataDir();
    const before = snapshot(f.root);
    for (const id of ["nope", "../library", "a/b", ".hidden"]) {
      const r = runCli(["pdf-path", id, "--data-dir", f.dataDir], f.env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`error: unknown PDF doc "${id}" — available: \n`);
    }
    expect(snapshot(f.root)).toEqual(before);
  });

  test("original missing: its own error", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID, { original: false });
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: the original PDF of doc "${PDF_ID}" is missing\n`,
    });
  });

  test("original is a symlink: refused, not followed", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID, { original: false });
    const target = f.file("elsewhere.pdf");
    writeFileSync(target, "%PDF-1.7\n");
    symlinkSync(target, join(f.dataDir, "output", PDF_ID, "original.pdf"));
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: the original PDF of doc "${PDF_ID}" is not a regular file\n`,
    });
  });

  test("metadata gone but the bundle is there: system error naming the doc", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const meta = join(f.dataDir, "output", PDF_ID, `${PDF_ID}.json`);
    writeFileSync(meta, "{oops");
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`^error: doc "${PDF_ID}": `));
  });
});
