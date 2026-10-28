/**
 * Catalog-derived CLI commands (release-0.2 ticket 01): `library read` and `library set-main-doc`, run as the built
 * CLI against a throwaway copy of the fixture library. Their stdout is the catalog operation's result (the object the
 * Copilot `library` tool returns), asserted against the entry's result schema and against the handler's own answer.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
import { fileURLToPath } from "node:url";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { createLocalOperationRuntime, runCatalogOperation } from "@argelanderspace/server";
import { expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const WORK = "arxiv:2603.03522";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-ops-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--data-dir", dataDir], {
      env,
      encoding: "utf8",
      timeout: 60_000,
      ...(input !== undefined ? { input } : {}),
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { root, dataDir, run };
}

const resultOf = (id: string) => OPERATION_CATALOG.find((op) => op.id === id)?.result;

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      out.push(`${p} ${statSync(p).mtimeMs} ${statSync(p).size}`);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("library read: list, one work, and an unknown work, same shape as the handler's answer; writes nothing", async () => {
  const { dataDir, run } = setup();
  const before = snapshot(dataDir);
  const runtime = createLocalOperationRuntime(libraryPaths(dataDir));

  const list = run(["library", "read", "--query", "open clusters", "--limit", "1", "--links"]);
  expect(list.status).toBe(0);
  const listed = JSON.parse(list.stdout);
  expect(resultOf("library.read")?.safeParse(listed).success).toBe(true);
  expect(listed).toEqual(
    await runCatalogOperation(runtime, "library.read", {
      query: "open clusters",
      limit: 1,
      links: true,
    })
  );
  expect(listed.refs).toHaveLength(1);

  const one = run(["library", "read", "--ref-id", WORK]);
  expect(one.status).toBe(0);
  expect(JSON.parse(one.stdout)).toEqual(
    await runCatalogOperation(runtime, "library.read", { refId: WORK })
  );
  expect(JSON.parse(one.stdout).ref.id).toBe(WORK);

  const missing = run(["library", "read", "--ref-id", "nope"]);
  expect(missing.status).toBe(1);
  expect(JSON.parse(missing.stdout)).toEqual({ ok: false, status: "not_found" });
  expect(snapshot(dataDir)).toEqual(before);
});

test("library read: --json from a file and from stdin; a bad parameter is exit 2 with nothing run", () => {
  const { root, run } = setup();
  const file = join(root, "p.json");
  writeFileSync(file, JSON.stringify({ query: "open clusters", limit: 1 }));
  const fromFile = run(["library", "read", "--json", file]);
  const fromStdin = run(
    ["library", "read", "--json", "-"],
    JSON.stringify({ query: "open clusters", limit: 1 })
  );
  expect(fromFile.status).toBe(0);
  expect(fromStdin.stdout).toBe(fromFile.stdout);

  for (const args of [
    ["--limit", "abc"],
    ["--limit", "0"],
    ["--limit", "1.5"],
    ["--json", file, "--query", "x"],
    ["--json", join(root, "missing.json")],
  ]) {
    const r = run(["library", "read", ...args]);
    expect(r.status, args.join(" ")).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, status: "unsupported" });
  }
  writeFileSync(file, "{not json");
  expect(run(["library", "read", "--json", file]).status).toBe(2);
  writeFileSync(file, JSON.stringify({ action: "read" }));
  expect(run(["library", "read", "--json", file]).status).toBe(2);
});

test("library set-main-doc: ok, noop, conflict, rejected, not found, and missing parameters", async () => {
  const { dataDir, run } = setup();
  const set = (doc: string, expected: string) =>
    run([
      "library",
      "set-main-doc",
      "--ref-id",
      WORK,
      "--doc-id",
      doc,
      "--expected-main-doc-id",
      expected,
    ]);

  const ok = set("arxiv-2603.03522", "2603.03522");
  expect(ok.status).toBe(0);
  const okJson = JSON.parse(ok.stdout);
  expect(resultOf("library.set_main_doc")?.safeParse(okJson).success).toBe(true);
  expect(okJson).toMatchObject({
    ok: true,
    status: "ok",
    object: { kind: "work", id: WORK },
    mainDocId: "arxiv-2603.03522",
  });
  const saved = JSON.parse(readFileSync(libraryPaths(dataDir).libraryJson, "utf8"));
  expect(saved.works.find((w: { id: string }) => w.id === WORK).doc_ids[0]).toBe(
    "arxiv-2603.03522"
  );

  const noop = set("arxiv-2603.03522", "arxiv-2603.03522");
  expect(noop.status).toBe(0);
  expect(JSON.parse(noop.stdout)).toMatchObject({ ok: true, status: "noop" });

  const conflict = set("2603.03522", "2603.03522");
  expect(conflict.status).toBe(1);
  expect(JSON.parse(conflict.stdout)).toMatchObject({
    ok: false,
    status: "conflict",
    current: { mainDocId: "arxiv-2603.03522" },
  });
  const nullExpected = run([
    "library",
    "set-main-doc",
    "--ref-id",
    WORK,
    "--doc-id",
    "2603.03522",
    "--expected-main-doc-id",
    "null",
  ]);
  expect(JSON.parse(nullExpected.stdout).status).toBe("conflict");

  expect(JSON.parse(set("ghost-doc", "arxiv-2603.03522").stdout)).toMatchObject({
    ok: false,
    status: "rejected",
  });
  const noWork = run([
    "library",
    "set-main-doc",
    "--ref-id",
    "nope",
    "--doc-id",
    "d",
    "--expected-main-doc-id",
    "null",
  ]);
  expect(noWork.status).toBe(1);
  expect(JSON.parse(noWork.stdout)).toMatchObject({ ok: false, status: "not_found" });

  const missing = run(["library", "set-main-doc", "--ref-id", WORK]);
  expect(missing.status).toBe(2);
  expect(JSON.parse(missing.stdout).detail).toContain("docId");
  // the saved file is what the last successful write left
  expect(existsSync(libraryPaths(dataDir).libraryJson)).toBe(true);
});

test("the older library command is still there next to the derived ones", () => {
  const { run } = setup();
  const help = run(["library", "--help"]);
  expect(help.stdout).toMatch(/\n\s+build \[options\]/);
  expect(help.stdout).toMatch(/\n\s+read \[options\]/);
  expect(help.stdout).toMatch(/\n\s+set-main-doc \[options\]/);
});
