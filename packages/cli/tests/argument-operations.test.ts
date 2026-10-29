/**
 * `argelanderspace argument read|create|update|delete|undo-delete|add-edge|remove-edge|replace|clear` (release-0.2
 * ticket 08): the real `bin.js` as a child process. The catalog commands share the `argument` group with the frozen
 * `argument get` / `argument put`, whose help is pinned here byte for byte (their behaviour is `argument.test.ts`'s
 * golden). Covers the two paths (no workbench: in this process; a running workbench: its route) and the user's card on a
 * replace or clear of a graph that has arguments - approved (0), denied (3), no workbench (1, nothing written).
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { argumentGraphPath } from "@argelanderspace/core";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  type RunningServer,
  registerWorkbench,
} from "@argelanderspace/server";
import { afterEach, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const closers: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-argops-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  let n = 0;
  /** The parameters as a --json file (the only way to give an object). */
  const json = (value: unknown) => {
    const file = join(root, `params-${n++}.json`);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--data-dir", dataDir], {
      env,
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cliAsync = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args, "--data-dir", dataDir], { env });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const file = () => {
    try {
      return readFileSync(argumentGraphPath(dataDir, WORK), "utf8");
    } catch {
      return "";
    }
  };
  return { dataDir, cli, cliAsync, json, file };
}

async function startWorkbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv: RunningServer = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken: token,
  });
  closers.push(() => srv.close().catch(() => {}));
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token });
  closers.push(() => registration.revoke());
  const api = `http://127.0.0.1:${port}/api/external-requests`;
  const waitForCard = async () => {
    for (let i = 0; i < 400; i++) {
      const list = (await (await fetch(api)).json()) as {
        requests: { id: string; card: Record<string, unknown> }[];
      };
      if (list.requests[0]) return list.requests[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no card was shown");
  };
  const decide = (id: string, decision: "approve" | "deny") =>
    fetch(`${api}/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ decision }),
    });
  return { waitForCard, decide, close: () => srv.close() };
}

const draft = (title: string) => ({
  title,
  claim: `claim of ${title}`,
  grounds: "g",
  warrant: "w",
});
const body = (...ids: string[]) => ({
  arguments: ids.map((id) => ({ id, ...draft(id) })),
  edges: ids.slice(1).map((id, i) => ({ from: id, to: ids[i], role: "grounds" })),
});

const FROZEN_GET_HELP = `Usage: argelanderspace argument get [options] <workId>

Print the work's whole argument graph as JSON (version 1, with rev); a work
without a graph prints the empty graph at rev 0.

Arguments:
  workId            library work id (see \`search\`)

Options:
  --data-dir <dir>  data directory (default ./literatures, or data_dir in
                    config.toml)
  -h, --help        display help for command
`;
const FROZEN_PUT_HELP = `Usage: argelanderspace argument put [options] <workId> <file>

Replace the work's whole argument graph from a JSON file ("-" reads stdin).
--rev must be the rev \`argument get\` printed; a work that already has arguments
also needs --replace. The file's own rev is ignored; its work_id may be left out
but must match if present. On success prints {work_id, rev, link}.

Arguments:
  workId            library work id (see \`search\`)
  file              JSON file with the whole graph, or "-" for stdin

Options:
  --data-dir <dir>  data directory (default ./literatures, or data_dir in
                    config.toml)
  --rev <n>         the rev of the graph you read (0 when the work has none);
                    required
  --replace         allow replacing a graph that already has arguments
  -h, --help        display help for command
`;

test("the group gains the catalog commands next to get and put, whose help is byte for byte as before", () => {
  const { cli } = setup();
  const group = cli(["argument", "--help"]);
  expect(group.status).toBe(0);
  const commands = group.stdout.slice(group.stdout.indexOf("Commands:"));
  const listed = [...commands.matchAll(/^ {2}([a-z-]+)(?: \[options\])?/gm)].map((m) => m[1]);
  expect(listed).toEqual([
    "get",
    "put",
    "read",
    "create",
    "update",
    "delete",
    "undo-delete",
    "add-edge",
    "remove-edge",
    "replace",
    "clear",
    "help",
  ]);
  expect(cli(["argument", "get", "--help"]).stdout).toBe(FROZEN_GET_HELP);
  expect(cli(["argument", "put", "--help"]).stdout).toBe(FROZEN_PUT_HELP);
  // object parameters are options that take JSON text (ticket 07), and --json still takes the whole object
  const create = cli(["argument", "create", "--help"]).stdout;
  expect(create).toContain("--work-id <string>");
  expect(create).toContain("--expected-rev <integer>");
  expect(create).toContain("--argument <json>");
  expect(create).toContain("--json <file|->");
});

test("without a workbench: create, read, update, edges and delete run in this process and agree with the frozen `argument get`", () => {
  const { cli, json, file } = setup();
  const created = cli([
    "argument",
    "create",
    "--json",
    json({ workId: WORK, expectedRev: 0, id: "a", argument: draft("A") }),
  ]);
  expect(created.status).toBe(0);
  expect(JSON.parse(created.stdout)).toEqual({
    ok: true,
    status: "ok",
    rev: 1,
    counts: { arguments: 1, edges: 0 },
    id: "a",
  });
  expect(
    JSON.parse(
      cli([
        "argument",
        "create",
        "--json",
        json({ workId: WORK, expectedRev: 1, id: "b", argument: draft("B") }),
      ]).stdout
    ).rev
  ).toBe(2);
  const edge = cli([
    "argument",
    "add-edge",
    "--work-id",
    WORK,
    "--expected-rev",
    "2",
    "--from",
    "a",
    "--to",
    "b",
    "--role",
    "grounds",
  ]);
  expect(JSON.parse(edge.stdout)).toMatchObject({
    ok: true,
    rev: 3,
    counts: { arguments: 2, edges: 1 },
  });
  expect(
    JSON.parse(
      cli([
        "argument",
        "update",
        "--json",
        json({ workId: WORK, expectedRev: 3, id: "a", patch: { claim: "new" } }),
      ]).stdout
    )
  ).toMatchObject({ ok: true, rev: 4 });
  const read = cli(["argument", "read", "--work-id", WORK]);
  expect(read.status).toBe(0);
  const answer = JSON.parse(read.stdout);
  expect(answer).toMatchObject({ ok: true, rev: 4, counts: { arguments: 2, edges: 1 } });
  // the frozen command reads what the catalog wrote
  const got = cli(["argument", "get", WORK]);
  expect(got.status).toBe(0);
  const stored = JSON.parse(got.stdout);
  expect(stored.rev).toBe(4);
  expect(stored.arguments.map((a: { id: string; claim: string }) => [a.id, a.claim])).toEqual([
    ["a", "new"],
    ["b", "claim of B"],
  ]);
  expect(Object.keys(stored)).toEqual(["version", "rev", "work_id", "arguments", "edges"]);
  const removed = cli([
    "argument",
    "remove-edge",
    "--work-id",
    WORK,
    "--expected-rev",
    "4",
    "--from",
    "a",
    "--to",
    "b",
    "--role",
    "grounds",
  ]);
  expect(JSON.parse(removed.stdout)).toMatchObject({
    ok: true,
    rev: 5,
    counts: { arguments: 2, edges: 0 },
  });
  const deleted = cli([
    "argument",
    "delete",
    "--work-id",
    WORK,
    "--expected-rev",
    "5",
    "--id",
    "b",
  ]);
  expect(JSON.parse(deleted.stdout)).toMatchObject({ ok: true, rev: 6, removed: { id: "b" } });
  // and the frozen put still replaces a graph the catalog wrote
  const file2 = json(body("p"));
  const put = cli(["argument", "put", WORK, file2, "--rev", "6", "--replace"]);
  expect(put.status).toBe(0);
  expect(JSON.parse(put.stdout)).toMatchObject({ work_id: WORK, rev: 7 });
  expect(JSON.parse(file()).arguments.map((a: { id: string }) => a.id)).toEqual(["p"]);
});

test("a stale rev is exit 1 with the latest graph, a bad parameter is exit 2, and neither writes", () => {
  const { cli, json, file } = setup();
  cli([
    "argument",
    "create",
    "--json",
    json({ workId: WORK, expectedRev: 0, id: "a", argument: draft("A") }),
  ]);
  const before = file();
  const stale = cli([
    "argument",
    "update",
    "--json",
    json({ workId: WORK, expectedRev: 0, id: "a", patch: { claim: "x" } }),
  ]);
  expect(stale.status).toBe(1);
  const conflict = JSON.parse(stale.stdout);
  expect(conflict).toMatchObject({ ok: false, status: "conflict", currentRev: 1 });
  expect(conflict.latest.arguments[0].id).toBe("a");
  expect(file()).toBe(before);
  const bad = cli(["argument", "delete", "--work-id", WORK, "--expected-rev", "x", "--id", "a"]);
  expect(bad.status).toBe(2);
  expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, status: "unsupported" });
  const mixed = cli(["argument", "delete", "--work-id", WORK, "--json", json({})]);
  expect(mixed.status).toBe(2);
  const unknownWork = cli(["argument", "read", "--work-id", "no-such"]);
  expect(unknownWork.status).toBe(1);
  expect(JSON.parse(unknownWork.stdout)).toMatchObject({ ok: false, status: "not_found" });
  expect(file()).toBe(before);
});

test("replace into a graph without arguments needs no card; with arguments and no workbench it is refused and nothing is written", () => {
  const { cli, json, file } = setup();
  const first = cli([
    "argument",
    "replace",
    "--json",
    json({ workId: WORK, expectedRev: 0, graph: body("a", "b") }),
  ]);
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    ok: true,
    rev: 1,
    counts: { arguments: 2, edges: 1 },
  });
  const before = file();
  for (const args of [
    ["argument", "replace", "--json", json({ workId: WORK, expectedRev: 1, graph: body("z") })],
    ["argument", "clear", "--work-id", WORK, "--expected-rev", "1"],
  ]) {
    const refused = cli(args);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, status: "workbench_required" });
    expect(file()).toBe(before);
  }
});

test("with a workbench: reads and writes go through it and answer as the process alone does", async () => {
  const alone = setup();
  const via = setup();
  const wb = await startWorkbench(via.dataDir);
  void wb;
  const steps = (s: ReturnType<typeof setup>) => [
    ["argument", "read", "--work-id", WORK],
    [
      "argument",
      "create",
      "--json",
      s.json({ workId: WORK, expectedRev: 0, id: "a", argument: draft("A") }),
    ],
    [
      "argument",
      "update",
      "--json",
      s.json({ workId: WORK, expectedRev: 0, id: "a", patch: { claim: "x" } }),
    ],
    ["argument", "read", "--work-id", WORK],
  ];
  const left = steps(alone);
  const right = steps(via);
  for (let i = 0; i < left.length; i++) {
    const a = alone.cli(left[i] as string[]);
    const b = await via.cliAsync(right[i] as string[]);
    expect(b.status, String(i)).toBe(a.status);
    expect(JSON.parse(b.stdout), String(i)).toEqual(JSON.parse(a.stdout));
  }
});

test("replace of a graph that has arguments: the card, then approved writes (0) or denied leaves it (3)", {
  timeout: 90_000,
}, async () => {
  const s = setup();
  s.cli([
    "argument",
    "replace",
    "--json",
    s.json({ workId: WORK, expectedRev: 0, graph: body("a", "b") }),
  ]);
  const before = s.file();
  const wb = await startWorkbench(s.dataDir);

  const denied = s.cliAsync([
    "argument",
    "replace",
    "--json",
    s.json({ workId: WORK, expectedRev: 1, graph: body("x") }),
  ]);
  const first = await wb.waitForCard();
  expect(first.card).toMatchObject({
    action: "replace_argument_graph",
    mode: "replace",
    current: { arguments: 2, edges: 1 },
    next: { arguments: 1, edges: 0 },
  });
  await wb.decide(first.id, "deny");
  const refused = await denied;
  expect(refused.status).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, status: "denied" });
  expect(s.file()).toBe(before);

  const approved = s.cliAsync(["argument", "clear", "--work-id", WORK, "--expected-rev", "1"]);
  const second = await wb.waitForCard();
  expect(second.card).toMatchObject({ mode: "clear", next: { arguments: 0, edges: 0 } });
  await wb.decide(second.id, "approve");
  const done = await approved;
  expect(done.status).toBe(0);
  expect(JSON.parse(done.stdout)).toMatchObject({
    ok: true,
    rev: 2,
    counts: { arguments: 0, edges: 0 },
  });
  expect(JSON.parse(s.file()).arguments).toEqual([]);
});

test("a conditional operation losing the workbench: exit 1 saying it may have run (not the card-pending exit 4)", {
  timeout: 90_000,
}, async () => {
  const s = setup();
  s.cli([
    "argument",
    "replace",
    "--json",
    s.json({ workId: WORK, expectedRev: 0, graph: body("a", "b") }),
  ]);
  const wb = await startWorkbench(s.dataDir);
  const waiting = s.cliAsync(["argument", "clear", "--work-id", WORK, "--expected-rev", "1"]);
  await wb.waitForCard();
  await wb.close();
  const result = await waiting;
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/may or may not have run/);
  expect(result.stderr).toMatch(/library read-jobs/);
  expect(result.stderr).not.toMatch(/Nothing was done/);
});
