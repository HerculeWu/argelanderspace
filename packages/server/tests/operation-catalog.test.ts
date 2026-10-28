import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { expect, test } from "vitest";
import {
  createLocalOperationRuntime,
  OPERATION_HANDLERS,
  runCatalogOperation,
} from "../src/index.js";

function fixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-opcat-"));
  mkdirSync(join(dir, "library"), { recursive: true });
  cpSync(
    join(import.meta.dirname, "..", "..", "core", "tests", "fixtures", "library.json"),
    join(dir, "library", "library.json")
  );
  return dir;
}

test("every catalog entry has a handler and its result schema accepts the handler's answers", async () => {
  expect(Object.keys(OPERATION_HANDLERS).sort()).toEqual(
    OPERATION_CATALOG.map((op) => op.id).sort()
  );
  const dir = fixtureDataDir();
  const paths = libraryPaths(dir);
  const runtime = createLocalOperationRuntime(paths);
  const result = (id: string) => OPERATION_CATALOG.find((op) => op.id === id)?.result;
  const answers: [string, Record<string, unknown>][] = [
    ["library.read", {}],
    ["library.read", { query: "open clusters", links: true }],
    ["library.read", { refId: "arxiv:2603.03522" }],
    ["library.read", { refId: "no-such" }],
    ["library.set_main_doc", { refId: "no-such", docId: "d", expectedMainDocId: null }],
    [
      "library.set_main_doc",
      { refId: "arxiv:2603.03522", docId: "ghost", expectedMainDocId: "2603.03522" },
    ],
    [
      "library.set_main_doc",
      { refId: "arxiv:2603.03522", docId: "arxiv-2603.03522", expectedMainDocId: null },
    ],
    [
      "library.set_main_doc",
      { refId: "arxiv:2603.03522", docId: "arxiv-2603.03522", expectedMainDocId: "2603.03522" },
    ],
    [
      "library.set_main_doc",
      {
        refId: "arxiv:2603.03522",
        docId: "arxiv-2603.03522",
        expectedMainDocId: "arxiv-2603.03522",
      },
    ],
  ];
  const statuses: unknown[] = [];
  for (const [id, params] of answers) {
    const answer = await runCatalogOperation(runtime, id as never, params);
    expect(result(id)?.safeParse(answer).success, JSON.stringify(answer)).toBe(true);
    statuses.push((answer as { status?: string }).status ?? "read");
  }
  expect(statuses).toEqual([
    "read",
    "read",
    "read",
    "not_found",
    "not_found",
    "rejected",
    "conflict",
    "ok",
    "noop",
  ]);
  const saved = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as {
    works: { id: string; doc_ids: string[] }[];
  };
  expect(saved.works.find((w) => w.id === "arxiv:2603.03522")?.doc_ids[0]).toBe("arxiv-2603.03522");
});
