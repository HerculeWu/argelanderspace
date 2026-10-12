/**
 * Argument-graph CLI tests (论证图 ticket 07): `argument get` / `argument put` / `pdf-path`, invoked as the
 * *built* CLI (`dist/bin.js`) against a throwaway data dir (the 34-work fixture library; never the repo's
 * `literatures/`). The byte-exact assertions below are the freeze guard of these commands once released
 * (contracts "论证图"); the full list lives in the ticket's Comments.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgumentSchema } from "@argelanderspace/contracts";
import { argumentGraphPath } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import { describeGraphIssue, orderedGraph } from "../src/argument.js";

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
    maxBuffer: 64 << 20,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A real shell pipeline (so stdin of the CLI is a pipe fd, not a spawnSync buffer). */
function sh(command: string, env: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync("sh", ["-c", command], {
    env,
    encoding: "utf8",
    timeout: 100_000,
    maxBuffer: 64 << 20,
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

/** The one JSON line `argument put` prints on success (frozen key order: work_id, rev, link). */
function putOut(rev: number, port = 8000, workId = WORK_ID): string {
  return `{"work_id":${JSON.stringify(workId)},"rev":${rev},"link":"http://localhost:${port}/#argument/${encodeURIComponent(workId)}"}\n`;
}

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
    ["not JSON", "{oops", "is not valid JSON"],
    ["schema-invalid", JSON.stringify({ version: 1 }), "does not match the argument graph format"],
    [
      "unknown key on disk",
      JSON.stringify({ version: 1, rev: 1, work_id: WORK_ID, arguments: [], edges: [], x: 1 }),
      "does not match the argument graph format",
    ],
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
    "unreadable graph file (%s): one own line, exit 1, no graph on stdout, file untouched",
    (_n, text, tail) => {
      const f = makeDataDir();
      mkdirSync(join(f.dataDir, "argument-graphs"));
      const file = argumentGraphPath(f.dataDir, WORK_ID);
      writeFileSync(file, text);
      const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
      expect(r).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: stored argument graph ${JSON.stringify(file)} ${tail}\n`,
      });
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  );

  test("the graph file is a directory: unreadable (EISDIR), not an empty graph", () => {
    const f = makeDataDir();
    mkdirSync(argumentGraphPath(f.dataDir, WORK_ID), { recursive: true });
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: stored argument graph ${JSON.stringify(argumentGraphPath(f.dataDir, WORK_ID))} could not be read (EISDIR)\n`,
    });
  });

  test("argument-graphs is a plain file: a system error (ENOTDIR), never an empty rev 0 graph", () => {
    const f = makeDataDir();
    writeFileSync(join(f.dataDir, "argument-graphs"), "x");
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: stored argument graph ${JSON.stringify(argumentGraphPath(f.dataDir, WORK_ID))} could not be read (ENOTDIR)\n`,
    });
    const p = putGraph(f, GRAPH);
    expect(p.status).toBe(1);
    expect(p.stdout).toBe("");
    expect(p.stderr).toMatch(/^error: stored argument graph ".+" could not be read \(ENOTDIR\)\n$/);
    expect(readFileSync(join(f.dataDir, "argument-graphs"), "utf8")).toBe("x");
  });

  test.skipIf(process.getuid?.() === 0)(
    "argument-graphs without permission: a system error (EACCES), never an empty graph",
    () => {
      const f = makeDataDir();
      const dir = join(f.dataDir, "argument-graphs");
      mkdirSync(dir);
      chmodSync(dir, 0o000);
      try {
        const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
        expect(r).toEqual({
          status: 1,
          stdout: "",
          stderr: `error: stored argument graph ${JSON.stringify(argumentGraphPath(f.dataDir, WORK_ID))} could not be read (EACCES)\n`,
        });
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  );

  test("library.json damaged: one own line naming the file, nothing on stdout", () => {
    const f = makeDataDir();
    const lib = join(f.dataDir, "library", "library.json");
    writeFileSync(lib, "{oops");
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: library file ${JSON.stringify(lib)} is not valid JSON\n`,
    });
    writeFileSync(lib, JSON.stringify({ works: [null] }));
    const r2 = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(r2).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: library file ${JSON.stringify(lib)} has an unexpected structure\n`,
    });
    mkdirSync(join(f.root, "d2", "library", "library.json"), { recursive: true });
    const r3 = runCli(["argument", "get", WORK_ID, "--data-dir", join(f.root, "d2")], f.env);
    expect(r3).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: library file ${JSON.stringify(join(f.root, "d2", "library", "library.json"))} could not be read (EISDIR)\n`,
    });
  });

  test("a work whose id cannot be a file name: own line, zero write", () => {
    const f = makeDataDir();
    const lib = JSON.parse(readFileSync(join(f.dataDir, "library", "library.json"), "utf8"));
    const longId = `x${"y".repeat(300)}`;
    lib.works[0].id = longId;
    writeFileSync(join(f.dataDir, "library", "library.json"), JSON.stringify(lib));
    const r = runCli(["argument", "get", longId, "--data-dir", f.dataDir], f.env);
    const quoted = `"${longId.slice(0, 100)}…"`;
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: work ${quoted} cannot have an argument graph: its id cannot be used as a file name\n`,
    });
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const p = runCli(
      ["argument", "put", longId, file, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(p).toEqual(r);
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  test("an empty library: unknown work says there are none", () => {
    const f = makeDataDir();
    writeFileSync(join(f.dataDir, "library", "library.json"), JSON.stringify({ works: [] }));
    const r = runCli(["argument", "get", "nope", "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: unknown work "nope" — the library at "${join(f.dataDir, "library", "library.json")}" has no works\n`,
    });
  });

  test("an empty work id is not matched against everything: the available list", () => {
    const f = makeDataDir();
    const r = runCli(["argument", "get", "", "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^error: unknown work "" — available: .+ … \(34 total\)\n$/);
    expect(r.stderr).not.toMatch(/closest/);
  });

  test("a wrong --data-dir names where it looked", () => {
    const f = makeDataDir();
    const empty = f.file("elsewhere");
    mkdirSync(empty);
    const r = runCli(["argument", "get", WORK_ID, "--data-dir", empty], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: unknown work "${WORK_ID}" — the library at "${join(empty, "library", "library.json")}" has no works\n`,
    });
  });

  test("an id with a newline or quote cannot forge extra lines", () => {
    const f = makeDataDir();
    const r = runCli(["argument", "get", 'a\nerror: x"', "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr.split("\n")).toHaveLength(2);
    expect(r.stderr).toMatch(/^error: unknown work "a\\nerror: x\\"" — /);
  });
});

describe("argument put", () => {
  test("writes a new graph: stdout is the new rev, then get prints it back", () => {
    const f = makeDataDir();
    const r = putGraph(f, GRAPH);
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g.stdout).toBe(GRAPH_GOLDEN);
    expect(existsSync(`${argumentGraphPath(f.dataDir, WORK_ID)}.tmp`)).toBe(false);
  });

  test("work_id may be left out; the file's own rev is ignored in favour of --rev", () => {
    const f = makeDataDir();
    const { work_id: _w, ...noWork } = { ...GRAPH, rev: 99 };
    const r = putGraph(f, noWork);
    expect(r.stdout).toBe(putOut(1));
  });

  test("version may be left out (it is 1); a version that is written must be 1", () => {
    const f = makeDataDir();
    const { version: _v, ...noVersion } = GRAPH;
    expect(putGraph(f, noVersion)).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
    // get still prints the version
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g.stdout).toBe(GRAPH_GOLDEN);
    for (const bad of [2, 0, "1", null, true]) {
      const r = putGraph(f, { ...GRAPH, version: bad }, ["--rev", "1", "--replace"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(
        `error: "${f.file("graph.json")}" is not a valid argument graph (1 issue); nothing was written\n  version: must be 1\n`
      );
    }
    // a hand-written graph with only the arguments: version, rev and work_id are all optional
    const bare = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "1", "--replace", "--data-dir", f.dataDir],
      f.env,
      '{"arguments":[{"id":"x","title":"X"}],"edges":[]}'
    );
    expect(bare).toEqual({ status: 0, stdout: putOut(2), stderr: "" });
  }, 60_000);

  test("reads stdin with '-'", () => {
    const f = makeDataDir();
    const r = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      JSON.stringify(GRAPH)
    );
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
  });

  test("a zero-argument stored graph needs no --replace; rev 3 → 4", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    writeFileSync(
      argumentGraphPath(f.dataDir, WORK_ID),
      JSON.stringify({ version: 1, rev: 3, work_id: WORK_ID, arguments: [], edges: [] })
    );
    const r = putGraph(f, GRAPH, ["--rev", "3"]);
    expect(r.stdout).toBe(putOut(4));
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
    expect(r.stdout).toBe(putOut(2));
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

  test("--rev is required: our own sentence, not commander's", () => {
    const f = makeDataDir();
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const missing = runCli(["argument", "put", WORK_ID, file, "--data-dir", f.dataDir], f.env);
    expect(missing).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "error: --rev is required: pass the rev that `argument get` printed (0 when the work has no graph)\n",
    });
  });

  test("--rev must be a non-negative integer (checked before anything else)", () => {
    const f = makeDataDir();
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    for (const bad of ["-1", "1.5", "abc", "01", "", "9007199254740993", "1e3", " 1"]) {
      const r = runCli(
        ["argument", "put", "no-such-work", file, `--rev=${bad}`, "--data-dir", f.dataDir],
        f.env
      );
      expect(r).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: --rev must be a non-negative integer, got "${bad}"\n`,
      });
    }
    const odd = runCli(
      ["argument", "put", WORK_ID, file, '--rev=a\nb"', "--data-dir", f.dataDir],
      f.env
    );
    expect(odd.stderr).toBe('error: --rev must be a non-negative integer, got "a\\nb\\""\n');
    // a separate value is read as the option's argument too
    const sep = runCli(
      ["argument", "put", WORK_ID, file, "--rev", "-1", "--data-dir", f.dataDir],
      f.env
    );
    expect(sep.stderr).toBe('error: --rev must be a non-negative integer, got "-1"\n');
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  }, 60_000);

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
      stderr: `error: work_id in "${f.file("graph.json")}" is "${OTHER_WORK_ID}", which does not match work "${WORK_ID}"\n`,
    });
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  });

  test.each([
    ["a number", 5],
    ["null", null],
    ["an object", {}],
  ])("a work_id in the file that is %s: its own sentence, zero write", (_n, value) => {
    const f = makeDataDir();
    const r = putGraph(f, { ...GRAPH, work_id: value });
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: work_id in "${f.file("graph.json")}" must be a string\n`,
    });
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
    const viaStdin = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      JSON.stringify({ ...GRAPH, work_id: value })
    );
    expect(viaStdin.stderr).toBe("error: work_id in stdin must be a string\n");
  });

  test("input that cannot be read or parsed: fixed own messages, zero write", () => {
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
    // a path with a newline stays on one line
    const odd = runCli(
      ["argument", "put", WORK_ID, "a\nb.json", "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(odd.stderr).toBe('error: cannot read "a\\nb.json" (ENOENT)\n');
    // a directory
    const dir = f.file("adir");
    mkdirSync(dir);
    const r4 = runCli(
      ["argument", "put", WORK_ID, dir, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(r4).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: cannot read "${dir}" (EISDIR)\n`,
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
    const empty = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      ""
    );
    expect(empty.stderr).toBe("error: stdin is not valid JSON\n");
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)("an unreadable file (EACCES)", () => {
    const f = makeDataDir();
    const file = f.file("locked.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    chmodSync(file, 0o000);
    try {
      const r = runCli(
        ["argument", "put", WORK_ID, file, "--rev", "0", "--data-dir", f.dataDir],
        f.env
      );
      expect(r).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: cannot read "${file}" (EACCES)\n`,
      });
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("stdin that is a directory: cannot read stdin (EISDIR)", () => {
    const f = makeDataDir();
    const r = sh(
      `node ${BIN} argument put ${WORK_ID} - --rev 0 --data-dir ${f.dataDir} < ${f.root}`,
      f.env
    );
    expect(r).toEqual({ status: 1, stdout: "", stderr: "error: cannot read stdin (EISDIR)\n" });
  });

  const withArgs = (args: unknown[], edges: unknown[] = []) => ({
    version: 1,
    arguments: args,
    edges,
  });
  const A1 = { id: "a1", title: "One" };
  const A2 = { id: "a2", title: "Two" };
  const src = (source: unknown) => withArgs([{ id: "a1", title: "One", sources: [source] }]);
  const tgt = (target: unknown) => src({ text: "s", target });
  const arg = (extra: Record<string, unknown>) => withArgs([{ id: "a1", title: "One", ...extra }]);
  const big = (n: number) => "x".repeat(n);
  /** `n` distinct (from, to, role) edges among `ids` (no self-loops). */
  const distinctEdges = (ids: string[], n: number) => {
    const edges: { from: string; to: string; role: string }[] = [];
    for (const from of ids)
      for (const to of ids)
        for (const role of ["grounds", "warrant", "backing", "rebuttal"])
          if (from !== to && edges.length < n) edges.push({ from, to, role });
    return edges;
  };

  /** [name, graph, the exact issue lines (position: sentence), 0-based positions] */
  const CASES: [string, unknown, string[]][] = [
    [
      "blank title",
      withArgs([{ id: "a1", title: "  " }]),
      ["arguments[0].title: must not be blank"],
    ],
    [
      "title too long",
      withArgs([A1, { id: "a2", title: big(81) }]),
      ["arguments[1].title: must be at most 80 characters"],
    ],
    ["empty id", withArgs([{ id: "", title: "t" }]), ["arguments[0].id: must not be empty"]],
    [
      "id too long",
      withArgs([{ id: big(65), title: "t" }]),
      ["arguments[0].id: must be at most 64 characters"],
    ],
    ["duplicate id", withArgs([A1, A1]), ['arguments[1].id: duplicate id "a1"']],
    [
      "edge to a missing argument",
      withArgs([A1], [{ from: "a1", to: "ghost", role: "grounds" }]),
      ['edges[0].to: refers to unknown argument "ghost"'],
    ],
    [
      "edge from a missing argument",
      withArgs([A1], [{ from: "ghost", to: "a1", role: "grounds" }]),
      ['edges[0].from: refers to unknown argument "ghost"'],
    ],
    [
      "an unknown id with a newline cannot forge a line",
      withArgs([A1], [{ from: "a1", to: "x\nerror: fake", role: "grounds" }]),
      ['edges[0].to: refers to unknown argument "x\\nerror: fake"'],
    ],
    [
      "self-loop",
      withArgs([A1], [{ from: "a1", to: "a1", role: "warrant" }]),
      ['edges[0]: connects argument "a1" to itself'],
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
      ['edges[1]: duplicate grounds edge from "a1" to "a2"'],
    ],
    [
      "a duplicated self-loop is both",
      withArgs(
        [A1],
        [
          { from: "a1", to: "a1", role: "grounds" },
          { from: "a1", to: "a1", role: "grounds" },
        ]
      ),
      [
        'edges[0]: connects argument "a1" to itself',
        'edges[1]: connects argument "a1" to itself',
        'edges[1]: duplicate grounds edge from "a1" to "a1"',
      ],
    ],
    [
      "unknown edge role",
      withArgs([A1, A2], [{ from: "a1", to: "a2", role: "claim" }]),
      ["edges[0].role: must be one of grounds, warrant, backing, rebuttal"],
    ],
    [
      "missing edge role",
      withArgs([A1, A2], [{ from: "a1", to: "a2" }]),
      ["edges[0].role: is required"],
    ],
    ["edge that is not an object", withArgs([A1], [5]), ["edges[0]: must be an object"]],
    [
      "unknown key on an argument",
      withArgs([{ id: "a1", title: "One", mood: "x" }]),
      ['arguments[0]: unknown field "mood"'],
    ],
    [
      "two unknown keys, one with a newline",
      withArgs([{ id: "a1", title: "One", mood: "x", "a\nb": 1 }]),
      ['arguments[0]: unknown field "mood"', 'arguments[0]: unknown field "a\\nb"'],
    ],
    [
      "unknown key at the root",
      { version: 1, arguments: [], edges: [], extra: 1 },
      ['<root>: unknown field "extra"'],
    ],
    [
      "source target with both anchor and page",
      tgt({ doc_id: "d", anchor: "sec-1", page: 2 }),
      ["arguments[0].sources[0].target: must have exactly one of anchor or page"],
    ],
    [
      "source target with neither",
      tgt({ doc_id: "d" }),
      ["arguments[0].sources[0].target: must have exactly one of anchor or page"],
    ],
    [
      "target without doc_id",
      tgt({ page: 1 }),
      ["arguments[0].sources[0].target.doc_id: is required"],
    ],
    [
      "doc_id too long",
      tgt({ doc_id: big(513), page: 1 }),
      ["arguments[0].sources[0].target.doc_id: must be at most 512 characters"],
    ],
    [
      "anchor too long",
      tgt({ doc_id: "d", anchor: big(513) }),
      ["arguments[0].sources[0].target.anchor: must be at most 512 characters"],
    ],
    [
      "empty anchor",
      tgt({ doc_id: "d", anchor: "" }),
      ["arguments[0].sources[0].target.anchor: must not be empty"],
    ],
    [
      "page 0",
      tgt({ doc_id: "d", page: 0 }),
      ["arguments[0].sources[0].target.page: must be greater than 0"],
    ],
    [
      "page 1.5",
      tgt({ doc_id: "d", page: 1.5 }),
      ["arguments[0].sources[0].target.page: must be an integer"],
    ],
    [
      "page 1e300",
      tgt({ doc_id: "d", page: 1e300 }),
      ["arguments[0].sources[0].target.page: must be at most 9007199254740991"],
    ],
    [
      "page as a string",
      tgt({ doc_id: "d", page: "4" }),
      ["arguments[0].sources[0].target.page: must be a number"],
    ],
    ["target null", tgt(null), ["arguments[0].sources[0].target: must be an object"]],
    ["blank source text", src({ text: "" }), ["arguments[0].sources[0].text: must not be empty"]],
    [
      "source text too long",
      src({ text: big(20_001) }),
      ["arguments[0].sources[0].text: must be at most 20000 characters"],
    ],
    ["source text a number", src({ text: 5 }), ["arguments[0].sources[0].text: must be a string"]],
    [
      "51 sources",
      arg({ sources: Array.from({ length: 51 }, () => ({ text: "s" })) }),
      ["arguments[0].sources: must have at most 50 items"],
    ],
    ["sources not an array", arg({ sources: {} }), ["arguments[0].sources: must be an array"]],
    [
      "field over 20000",
      arg({ claim: big(20_001), backing: big(20_001) }),
      [
        "arguments[0].claim: must be at most 20000 characters",
        "arguments[0].backing: must be at most 20000 characters",
      ],
    ],
    ["a field that is a number", arg({ claim: 3 }), ["arguments[0].claim: must be a string"]],
    ["bad kind", arg({ kind: "foo" }), ["arguments[0].kind: must be one of native, end, normal"]],
    [
      "boolean as a string",
      arg({ warrant_implicit: "yes" }),
      ["arguments[0].warrant_implicit: must be a boolean"],
    ],
    [
      "501 arguments",
      withArgs(Array.from({ length: 501 }, (_, i) => ({ id: `a${i}`, title: "t" }))),
      ["arguments: must have at most 500 items"],
    ],
    [
      "5001 edges",
      withArgs(
        Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, title: "t" })),
        distinctEdges(
          Array.from({ length: 40 }, (_, i) => `a${i}`),
          5001
        )
      ),
      ["edges: must have at most 5000 items"],
    ],
    [
      "arguments not an array",
      { version: 1, arguments: {}, edges: [] },
      ["arguments: must be an array"],
    ],
    ["arguments missing", { version: 1, edges: [] }, ["arguments: is required"]],
    ["wrong version", { version: 2, arguments: [], edges: [] }, ["version: must be 1"]],
    ["version null", { version: null, arguments: [], edges: [] }, ["version: must be 1"]],
    ["version as a string", { version: "1", arguments: [], edges: [] }, ["version: must be 1"]],
    ["not an object (array)", [], ["<root>: must be an object"]],
    ["not an object (null)", null, ["<root>: must be an object"]],
    ["not an object (number)", 5, ["<root>: must be an object"]],
  ];

  test.each(CASES)(
    "validation failure (%s): every issue by 0-based position in our own words, exit 1, zero write",
    (_name, graph, lines) => {
      const f = makeDataDir();
      const r = putGraph(f, JSON.stringify(graph));
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        `error: "${f.file("graph.json")}" is not a valid argument graph (${lines.length} issue${lines.length === 1 ? "" : "s"}); nothing was written\n${lines.map((l) => `  ${l}`).join("\n")}\n`
      );
      expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
    }
  );

  test("no pinned issue line carries a library's own wording", () => {
    const forbidden = /Invalid input|Too big|Too small|Unrecognized|Invalid option|expected /;
    for (const [, , lines] of CASES) for (const l of lines) expect(l).not.toMatch(forbidden);
  });

  test("a library issue of a kind we did not map gets the fixed fallback sentence", () => {
    expect(
      describeGraphIssue({ code: "not_multiple_of", path: ["arguments", 2, "x"] }, {})
    ).toEqual(["arguments[2].x: does not satisfy the argument graph format"]);
    expect(describeGraphIssue({ code: "custom", path: ["weird"] }, { weird: 1 })).toEqual([
      "weird: does not satisfy the argument graph format",
    ]);
    expect(describeGraphIssue({ code: "invalid_type", path: [], expected: "bigint" }, 5)).toEqual([
      "<root>: does not satisfy the argument graph format",
    ]);
  });

  test("several problems are all listed, in the order found", () => {
    const f = makeDataDir();
    const r = putGraph(
      f,
      withArgs([A1, { id: "a1", title: "" }], [{ from: "a1", to: "a1", role: "grounds" }])
    );
    expect(r.status).toBe(1);
    expect(r.stderr.split("\n").slice(1, -1)).toEqual([
      "  arguments[1].title: must not be blank",
      '  arguments[1].id: duplicate id "a1"',
      '  edges[0]: connects argument "a1" to itself',
    ]);
  });

  test("structural rules are not reported in the same round as shape problems", () => {
    const f = makeDataDir();
    const r = putGraph(f, withArgs([A1, A1, { id: "a3", title: 5 }]));
    expect(r.stderr.split("\n").slice(1, -1)).toEqual(["  arguments[2].title: must be a string"]);
  });

  test("more than 100 issues: the first 100 lines, then a count of the rest", () => {
    const f = makeDataDir();
    const r = putGraph(
      f,
      withArgs(Array.from({ length: 150 }, (_, i) => ({ id: `a${i}`, title: "" })))
    );
    expect(r.status).toBe(1);
    const lines = r.stderr.split("\n");
    expect(lines[0]).toBe(
      `error: "${f.file("graph.json")}" is not a valid argument graph (150 issues); nothing was written`
    );
    expect(lines).toHaveLength(1 + 100 + 1 + 1);
    expect(lines[1]).toBe("  arguments[0].title: must not be blank");
    expect(lines[100]).toBe("  arguments[99].title: must not be blank");
    expect(lines[101]).toBe("  … 50 more");
    expect(lines[102]).toBe("");
  });

  test("exactly the limits are accepted", () => {
    const f = makeDataDir();
    const args: Record<string, unknown>[] = Array.from({ length: 500 }, (_, i) => ({
      id: i === 0 ? big(64) : `a${i}`,
      title: big(80),
    }));
    args[1] = {
      ...args[1],
      claim: big(20_000),
      sources: Array.from({ length: 50 }, () => ({ text: big(20_000) })),
    };
    const edges = distinctEdges(
      args.map((a) => a.id as string),
      5000
    );
    const r = putGraph(f, withArgs(args, edges));
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
  }, 60_000);

  test("a graph with a cycle (and a missing Claim, an End with an out-edge) is written as is", () => {
    const f = makeDataDir();
    const cyc = withArgs(
      [
        { id: "a1", title: "One", kind: "end" },
        { id: "a2", title: "Two" },
      ],
      [
        { from: "a1", to: "a2", role: "grounds" },
        { from: "a2", to: "a1", role: "grounds" },
      ]
    );
    expect(putGraph(f, cyc)).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(JSON.parse(g.stdout).edges).toHaveLength(2);
  });

  test("Markdown, math and non-ASCII text round-trip byte for byte", () => {
    const f = makeDataDir();
    const text = String.raw`**bold** \`code\`

- item

$$\sum_{i=1}^{n} \alpha_i \le \frac{1}{2}$$
中文、日本語、ελληνικά — 😀 "quoted" \ back`;
    const graph = withArgs([
      {
        id: "α-1",
        title: "標題 😀",
        claim: text,
        grounds: text,
        sources: [{ text: "第 3.2 节" }],
      },
    ]);
    expect(putGraph(f, graph).status).toBe(0);
    const g = JSON.parse(
      runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env).stdout
    );
    expect(g.arguments[0].claim).toBe(text);
    expect(g.arguments[0].grounds).toBe(text);
    expect(g.arguments[0].id).toBe("α-1");
    expect(g.arguments[0].title).toBe("標題 😀");
    expect(g.arguments[0].sources[0].text).toBe("第 3.2 节");
  });

  test("an unreadable stored graph is never overwritten", () => {
    const f = makeDataDir();
    mkdirSync(join(f.dataDir, "argument-graphs"));
    const file = argumentGraphPath(f.dataDir, WORK_ID);
    writeFileSync(file, "{oops");
    const r = putGraph(f, GRAPH, ["--rev", "0", "--replace"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: stored argument graph ${JSON.stringify(file)} is not valid JSON\n`,
    });
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a write that fails: one own line with the error code, nothing left behind",
    () => {
      const f = makeDataDir();
      const dir = join(f.dataDir, "argument-graphs");
      mkdirSync(dir);
      chmodSync(dir, 0o555);
      try {
        const r = putGraph(f, GRAPH);
        expect(r).toEqual({
          status: 1,
          stdout: "",
          stderr: "error: could not write the argument graph (EACCES); nothing was written\n",
        });
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  );

  test("the link follows ARGELANDERSPACE_PORT; ids are URL-encoded", () => {
    const f = makeDataDir();
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const r = runCli(["argument", "put", WORK_ID, file, "--rev", "0", "--data-dir", f.dataDir], {
      ...f.env,
      ARGELANDERSPACE_PORT: "9123",
    });
    expect(r).toEqual({ status: 0, stdout: putOut(1, 9123), stderr: "" });
    expect(JSON.parse(r.stdout).link).toBe("http://localhost:9123/#argument/arxiv%3A2603.03522");
  });
});

describe("argument put over a real pipe (stdin as a non-blocking pipe fd)", () => {
  test("a writer that starts late (sleeps first)", () => {
    const f = makeDataDir();
    writeFileSync(f.file("g.json"), JSON.stringify(GRAPH));
    const r = sh(
      `(sleep 2; cat ${f.file("g.json")}) | node ${BIN} argument put ${WORK_ID} - --rev 0 --data-dir ${f.dataDir}`,
      f.env
    );
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
  }, 60_000);

  test("a writer that sends in slow pieces", () => {
    const f = makeDataDir();
    const text = JSON.stringify(GRAPH);
    const half = Math.floor(text.length / 2);
    writeFileSync(f.file("p1"), text.slice(0, half));
    writeFileSync(f.file("p2"), text.slice(half));
    const r = sh(
      `(cat ${f.file("p1")}; sleep 1; cat ${f.file("p2")}) | node ${BIN} argument put ${WORK_ID} - --rev 0 --data-dir ${f.dataDir}`,
      f.env
    );
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
  }, 60_000);

  test("a multi-megabyte graph through cat", () => {
    const f = makeDataDir();
    const args = Array.from({ length: 500 }, (_, i) => ({
      id: `a${i}`,
      title: `t${i}`,
      claim: "é".repeat(9_500),
    }));
    const text = JSON.stringify({ version: 1, arguments: args, edges: [] });
    expect(text.length).toBeGreaterThan(4_700_000);
    writeFileSync(f.file("big.json"), text);
    const r = sh(
      `cat ${f.file("big.json")} | node ${BIN} argument put ${WORK_ID} - --rev 0 --data-dir ${f.dataDir}`,
      f.env
    );
    expect(r).toEqual({ status: 0, stdout: putOut(1), stderr: "" });
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(JSON.parse(g.stdout).arguments[499].claim).toBe("é".repeat(9_500));
  }, 120_000);

  test("argument get | argument put - --rev N --replace, repeatedly", () => {
    const f = makeDataDir();
    expect(putGraph(f, GRAPH).status).toBe(0);
    for (let rev = 1; rev <= 5; rev++) {
      const r = sh(
        `node ${BIN} argument get ${WORK_ID} --data-dir ${f.dataDir} | node ${BIN} argument put ${WORK_ID} - --rev ${rev} --replace --data-dir ${f.dataDir}`,
        f.env
      );
      expect(r).toEqual({ status: 0, stdout: putOut(rev + 1), stderr: "" });
    }
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g.stdout).toBe(GRAPH_GOLDEN.replace('"rev": 1', '"rev": 6'));
  }, 120_000);
});

describe("get output key order is exhaustive over the schema", () => {
  test("every field the schema knows is printed (a new field must be added to the ordered builders)", () => {
    const full = {
      version: 1 as const,
      rev: 1,
      work_id: "w",
      arguments: [
        ArgumentSchema.parse({
          id: "a",
          title: "t",
          sources: [
            { text: "s", target: { doc_id: "d", anchor: "x" } },
            { text: "s", target: { doc_id: "d", page: 2 } },
          ],
        }),
      ],
      edges: [{ from: "a", to: "a", role: "grounds" as const }],
    };
    const out = orderedGraph(full) as {
      arguments: { sources: { target: object }[] }[];
      edges: object[];
    };
    expect(Object.keys(out)).toEqual(["version", "rev", "work_id", "arguments", "edges"]);
    expect(Object.keys(out.arguments[0] ?? {})).toEqual(Object.keys(ArgumentSchema.shape));
    expect(Object.keys(out.edges[0] ?? {})).toEqual(["from", "to", "role"]);
    expect(Object.keys(out.arguments[0]?.sources[0] ?? {})).toEqual(["text", "target"]);
    expect(Object.keys(out.arguments[0]?.sources[0]?.target ?? {})).toEqual(["doc_id", "anchor"]);
    expect(Object.keys(out.arguments[0]?.sources[1]?.target ?? {})).toEqual(["doc_id", "page"]);
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
      stdout: `${join(realpathSync(f.dataDir), "output", PDF_ID, "original.pdf")}\n`,
      stderr: "",
    });
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a data dir reached through a symlink prints the real path", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const link = f.file("data-link");
    symlinkSync(f.dataDir, link);
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", link], f.env);
    expect(r).toEqual({
      status: 0,
      stdout: `${join(realpathSync(f.dataDir), "output", PDF_ID, "original.pdf")}\n`,
      stderr: "",
    });
  });

  test("the doc does not have to belong to a work, and its hash is not checked", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    writeFileSync(join(f.dataDir, "output", PDF_ID, "original.pdf"), "different bytes");
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(0);
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
      expect(r.stderr).toBe(
        `error: unknown PDF doc "${id}" — there are no PDF docs in "${join(f.dataDir, "output")}"\n`
      );
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

  test("original.pdf is a directory: not a regular file", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID, { original: false });
    mkdirSync(join(f.dataDir, "output", PDF_ID, "original.pdf"));
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: the original PDF of doc "${PDF_ID}" is not a regular file\n`,
    });
  });

  test("an id with a newline cannot forge extra lines", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const r = runCli(["pdf-path", "a\nerror: x", "--data-dir", f.dataDir], f.env);
    expect(r.stderr).toBe(`error: unknown PDF doc "a\\nerror: x" — available: ${PDF_ID}\n`);
  });

  test("candidates are truncated like note's: 12 and a total", () => {
    const f = makeDataDir();
    for (let i = 0; i < 14; i++) {
      addPdfDoc(f.dataDir, `pdf-00000000-0000-4000-8000-0000000000${String(10 + i)}`);
    }
    const r = runCli(["pdf-path", "nope", "--data-dir", f.dataDir], f.env);
    expect(r.stderr).toMatch(
      /^error: unknown PDF doc "nope" — available: (pdf-[0-9a-f-]+, ){11}pdf-[0-9a-f-]+ … \(14 total\)\n$/
    );
  });

  test.each([
    ["not JSON", "{oops", "its metadata is not valid JSON"],
    ["not an object", "[]", "its metadata is not a JSON object"],
    [
      "wrong shape (no 80-line dump)",
      JSON.stringify({ format: "pdf", doc_id: PDF_ID }),
      "its metadata does not match the PDF doc format",
    ],
    [
      "another doc's metadata",
      JSON.stringify({
        version: 1,
        doc_id: "pdf-other",
        format: "pdf",
        display_name: "p.pdf",
        original_filename: "p.pdf",
        acquired_via: "user_pdf_upload",
        acquired_at: "2026-10-12T00:00:00.000Z",
        byte_length: 9,
        sha256: "a".repeat(64),
        page_count: 1,
        pages: [{ width: 612, height: 792, rotation: 0 }],
      }),
      "its metadata belongs to another doc",
    ],
    [
      "format missing next to a PDF original",
      JSON.stringify({ version: 1, doc_id: PDF_ID }),
      "its metadata is not marked as a PDF doc",
    ],
  ])("damaged metadata (%s): one own line", (_n, text, reason) => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    writeFileSync(join(f.dataDir, "output", PDF_ID, `${PDF_ID}.json`), text);
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: doc "${PDF_ID}": ${reason}\n`,
    });
  });

  test("metadata file gone but the bundle is there", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    rmSync(join(f.dataDir, "output", PDF_ID, `${PDF_ID}.json`));
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: doc "${PDF_ID}": its metadata file is missing\n`,
    });
  });

  test("the output directory is a plain file", () => {
    const f = makeDataDir();
    writeFileSync(join(f.dataDir, "output"), "x");
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: doc "${PDF_ID}": the output directory is not a plain directory\n`,
    });
  });
});

describe("argument put: stdin that never ends, and stdin that is a terminal", () => {
  function startPut(f: ReturnType<typeof makeDataDir>) {
    return spawn(
      process.execPath,
      [BIN, "argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      { env: f.env, stdio: ["pipe", "pipe", "pipe"] }
    );
  }

  /** Wait for exit; `null` if the process is still alive after `ms` (it is then killed for good). */
  function exitWithin(child: ReturnType<typeof spawn>, ms: number) {
    return new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    } | null>((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, ms);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s ends a put that waits for a writer that never closes: quickly, non-zero, nothing written",
    async (sig) => {
      const f = makeDataDir();
      const before = snapshot(f.root);
      const child = startPut(f);
      child.stdin?.write('{"version":1,"arguments":['); // a half-sent graph; the pipe stays open
      await pause(1500); // let it load and sit in the read
      child.kill(sig);
      const result = await exitWithin(child, 8000);
      expect(result).not.toBeNull();
      expect(result?.code === 0).toBe(false);
      expect(result?.signal ?? result?.code).toBeTruthy();
      expect(result?.stdout).toBe("");
      expect(snapshot(f.root)).toEqual(before);
      expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
    },
    30_000
  );

  test("a graph cut in the middle of a multi-byte character arrives intact", async () => {
    const f = makeDataDir();
    const title = "论证图é€𝔘x";
    const bytes = Buffer.from(
      JSON.stringify({ arguments: [{ id: "a", title }], edges: [] }),
      "utf8"
    );
    // cut inside the 3-byte "论" and inside the 4-byte "𝔘"
    const cuts = [bytes.indexOf(Buffer.from("论")) + 1, bytes.indexOf(Buffer.from("𝔘")) + 2];
    const child = startPut(f);
    let from = 0;
    for (const cut of cuts) {
      child.stdin?.write(bytes.subarray(from, cut));
      from = cut;
      await pause(300);
    }
    child.stdin?.end(bytes.subarray(from));
    const result = await exitWithin(child, 20_000);
    expect(result).toMatchObject({ code: 0, stdout: putOut(1), stderr: "" });
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(JSON.parse(g.stdout).arguments[0].title).toBe(title);
  }, 60_000);

  test("stdin is a terminal: refused at once with one own line, exit 1, nothing written", () => {
    const f = makeDataDir();
    const before = snapshot(f.root);
    // util-linux `script` gives the CLI a real pty as stdin/stdout/stderr (so the output carries CRLF)
    const r = spawnSync(
      "script",
      [
        "-qec",
        `${process.execPath} ${BIN} argument put ${WORK_ID} - --rev 0 --data-dir ${f.dataDir}`,
        "/dev/null",
      ],
      { env: f.env, encoding: "utf8", timeout: 20_000, input: "" }
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'error: stdin is a terminal; "-" reads the graph from a pipe or a redirected file\r\n'
    );
    expect(snapshot(f.root)).toEqual(before);
  });

  test("the terminal check comes after --rev and the work, like reading any input", () => {
    const f = makeDataDir();
    const r = spawnSync(
      "script",
      [
        "-qec",
        `${process.execPath} ${BIN} argument put nope - --rev 0 --data-dir ${f.dataDir}`,
        "/dev/null",
      ],
      { env: f.env, encoding: "utf8", timeout: 20_000, input: "" }
    );
    expect(r.stdout).toMatch(/^error: unknown work "nope" — /);
  });
});

describe("argument commands: messages that must stay one safe line", () => {
  const AWKWARD = [
    "\u2028",
    "\u2029",
    "\u0085",
    "\u007f",
    "\u0080",
    "\u009f",
    "\u202a",
    "\u202e",
    "\u2066",
    "\u2069",
    "\u200e",
    "\u200f",
    "\u061c",
    "\u001b",
  ];

  test("line separators, C1 controls and bidi controls are written as \\uXXXX in every quoted value", () => {
    const f = makeDataDir();
    const all = AWKWARD.join("");
    const hexes = AWKWARD.map(
      (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`
    ).join("");
    const get = runCli(["argument", "get", `a${all}b`, "--data-dir", f.dataDir], f.env);
    expect(get.stderr).toContain(`error: unknown work "a${hexes}b" — `);
    const pdf = runCli(["pdf-path", `a${all}b`, "--data-dir", f.dataDir], f.env);
    expect(pdf.stderr).toContain(`unknown PDF doc "a${hexes}b"`);
    const put = runCli(
      ["argument", "put", WORK_ID, `x${all}y.json`, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(put.stderr).toBe(`error: cannot read "x${hexes}y.json" (ENOENT)\n`);
    for (const out of [get.stderr, pdf.stderr, put.stderr]) {
      // nothing of the awkward characters survives, and the message is exactly one line however it is split
      for (const ch of AWKWARD) expect(out).not.toContain(ch);
      expect(out.split(/[\n\r\u2028\u2029\u0085]/)).toHaveLength(2);
    }
    // an id inside the graph, in a validation line
    const dup = JSON.stringify({
      arguments: [
        { id: "a\u2028\u202e", title: "t" },
        { id: "a\u2028\u202e", title: "t" },
      ],
      edges: [],
    });
    const r = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      dup
    );
    expect(r.stderr).toContain('duplicate id "a\\u2028\\u202e"');
    expect(r.stderr).not.toMatch(/[\u2028\u202e]/);
  });

  test("a __proto__ key is reported as an unknown field at every depth, not ignored", () => {
    const f = makeDataDir();
    const text =
      '{"__proto__":{"x":1},"arguments":[{"id":"a","title":"t","__proto__":1,"sources":[{"text":"s","__proto__":null}]},{"id":"b","title":"t"}],"edges":[{"from":"a","to":"b","role":"grounds","__proto__":{}}]}';
    const r = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      text
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const lines = r.stderr.split("\n").slice(1, -1);
    expect(r.stderr.split("\n")[0]).toBe(
      "error: stdin is not a valid argument graph (4 issues); nothing was written"
    );
    expect(lines.sort()).toEqual(
      [
        '  <root>: unknown field "__proto__"',
        '  arguments[0]: unknown field "__proto__"',
        '  arguments[0].sources[0]: unknown field "__proto__"',
        '  edges[0]: unknown field "__proto__"',
      ].sort()
    );
    expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
    // and a graph whose ONLY fault is __proto__ is refused too
    const only = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      '{"arguments":[],"edges":[],"__proto__":{}}'
    );
    expect(only.stderr).toBe(
      'error: stdin is not a valid argument graph (1 issue); nothing was written\n  <root>: unknown field "__proto__"\n'
    );
  });

  test("unknown keys that share their first 100 characters are all counted, each shown cut", () => {
    const f = makeDataDir();
    const k1 = `${"k".repeat(100)}1`;
    const k2 = `${"k".repeat(100)}2`;
    const r = runCli(
      ["argument", "put", WORK_ID, "-", "--rev", "0", "--data-dir", f.dataDir],
      f.env,
      JSON.stringify({ arguments: [], edges: [], [k1]: 1, [k2]: 2 })
    );
    const cut = `  <root>: unknown field "${"k".repeat(100)}…"`;
    expect(r.stderr).toBe(
      `error: stdin is not a valid argument graph (2 issues); nothing was written\n${cut}\n${cut}\n`
    );
  });

  test("a config.toml that does not load: the repository's own sentence, as `note` prints it", () => {
    const f = makeDataDir();
    const cfgDir = join(f.root, "xdg", "argelanderspace");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.toml"), 'port = "abc"\n');
    const expected = `error: ${join(cfgDir, "config.toml")}: "port" must be an integer between 0 and 65535\n`;
    const g = runCli(["argument", "get", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(g).toEqual({ status: 1, stdout: "", stderr: expected });
    const file = f.file("g.json");
    writeFileSync(file, JSON.stringify(GRAPH));
    const p = runCli(
      ["argument", "put", WORK_ID, file, "--rev", "0", "--data-dir", f.dataDir],
      f.env
    );
    expect(p).toEqual({ status: 1, stdout: "", stderr: expected });
    const d = runCli(["pdf-path", "pdf-x", "--data-dir", f.dataDir], f.env);
    expect(d).toEqual({ status: 1, stdout: "", stderr: expected });
    // the same sentence the existing `note` prints
    const note = runCli(["note", "list", WORK_ID, "--data-dir", f.dataDir], f.env);
    expect(note.stderr).toBe(expected);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a write that fails on a directory this very run created leaves no directory behind",
    () => {
      const f = makeDataDir();
      const file = f.file("g.json");
      writeFileSync(file, JSON.stringify(GRAPH));
      const before = snapshot(f.root);
      // a zero file-size limit makes every write fail (EFBIG) while the directory can still be made
      const r = spawnSync(
        "sh",
        [
          "-c",
          `ulimit -f 0; exec ${process.execPath} ${BIN} argument put ${WORK_ID} ${file} --rev 0 --data-dir ${f.dataDir}`,
        ],
        { env: f.env, encoding: "utf8", timeout: 30_000 }
      );
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(
        /^error: could not write the argument graph \([A-Z]+\); nothing was written\n$/
      );
      expect(r.status).toBe(1);
      expect(existsSync(join(f.dataDir, "argument-graphs"))).toBe(false);
      expect(snapshot(f.root)).toEqual(before);
    }
  );
});

describe("pdf-path: only a missing path means 'no such doc'", () => {
  const PDF_ID = "pdf-22222222-2222-4222-8222-222222222222";
  function addPdfDoc(dataDir: string, id: string) {
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
    writeFileSync(join(dir, "original.pdf"), "%PDF-1.7\n");
  }

  test("an empty doc id gets the available list, never 'closest matches'", () => {
    const f = makeDataDir();
    addPdfDoc(f.dataDir, PDF_ID);
    const r = runCli(["pdf-path", "", "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: unknown PDF doc "" — available: ${PDF_ID}\n`,
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    "output/ that cannot be searched or listed: a system error, not 'unknown PDF doc'",
    () => {
      const f = makeDataDir();
      addPdfDoc(f.dataDir, PDF_ID);
      const out = join(f.dataDir, "output");
      chmodSync(out, 0o000);
      try {
        for (const id of [PDF_ID, "nope"]) {
          const r = runCli(["pdf-path", id, "--data-dir", f.dataDir], f.env);
          expect(r).toEqual({
            status: 1,
            stdout: "",
            stderr: `error: the output directory "${out}" could not be read (EACCES)\n`,
          });
        }
      } finally {
        chmodSync(out, 0o755);
      }
    }
  );

  test.skipIf(process.getuid?.() === 0)(
    "output/ that can be searched but not listed: a known doc still resolves, an unknown one is a system error",
    () => {
      const f = makeDataDir();
      addPdfDoc(f.dataDir, PDF_ID);
      const out = join(f.dataDir, "output");
      chmodSync(out, 0o311);
      try {
        const ok = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
        expect(ok.status).toBe(0);
        const r = runCli(["pdf-path", "nope", "--data-dir", f.dataDir], f.env);
        expect(r).toEqual({
          status: 1,
          stdout: "",
          stderr: `error: the output directory "${out}" could not be read (EACCES)\n`,
        });
      } finally {
        chmodSync(out, 0o755);
      }
    }
  );

  test.skipIf(process.getuid?.() === 0)(
    "a Doc folder that cannot be searched: a system error naming the doc",
    () => {
      const f = makeDataDir();
      addPdfDoc(f.dataDir, PDF_ID);
      const dir = join(f.dataDir, "output", PDF_ID);
      chmodSync(dir, 0o000);
      try {
        const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
        expect(r).toEqual({
          status: 1,
          stdout: "",
          stderr: `error: doc "${PDF_ID}": its files could not be read (EACCES)\n`,
        });
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  );

  test("the output directory is a symlink to a directory: not a plain directory", () => {
    const f = makeDataDir();
    const real = f.file("real-output");
    mkdirSync(real);
    symlinkSync(real, join(f.dataDir, "output"));
    const r = runCli(["pdf-path", PDF_ID, "--data-dir", f.dataDir], f.env);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: doc "${PDF_ID}": the output directory is not a plain directory\n`,
    });
  });
});

describe("usage errors (not frozen: exit 1, stderr is commander's help/usage text)", () => {
  test.each([
    ["bare argument", ["argument"]],
    ["unknown subcommand", ["argument", "frobnicate"]],
    ["get without its argument", ["argument", "get"]],
    ["put without its file", ["argument", "put", WORK_ID, "--rev", "0"]],
    ["too many arguments", ["argument", "get", WORK_ID, "extra"]],
    ["an unknown option", ["argument", "get", WORK_ID, "--bogus"]],
    ["pdf-path without its argument", ["pdf-path"]],
    ["--rev without a value", ["argument", "put", WORK_ID, "f.json", "--rev"]],
  ])("%s: exit 1, nothing on stdout", (_n, args) => {
    const f = makeDataDir();
    const r = runCli([...args, "--data-dir", f.dataDir], f.env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
