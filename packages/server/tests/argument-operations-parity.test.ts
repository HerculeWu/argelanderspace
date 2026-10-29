/**
 * The Copilot `argument` tool and `argelanderspace argument <op>` give the same answers (release-0.2 ticket 08): the
 * same sequence of operations runs once through the real Copilot host (scripted model, real Pi session and routes) and
 * once through the catalog on a second data directory prepared the same way; every answer and the stored graph agree,
 * and a replace asks the same card.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { argumentGraphPath, libraryPaths, replaceArgumentGraph } from "@argelanderspace/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ExternalRequestQueue } from "../src/external-requests.js";
import { createLocalOperationRuntime, runCatalogOperation } from "../src/index.js";
import {
  answer,
  call,
  card,
  disk,
  graph,
  H,
  run,
  setup,
  start,
  teardown,
  until,
  userPuts,
  viewing,
  WORK,
} from "./argument-host-harness.js";

let mirror: string;
afterEach(async () => {
  await teardown();
  rmSync(mirror, { recursive: true, force: true });
});

/** The second data directory: the same library, the same graph at the same rev. */
beforeEach(async () => {
  await setup();
  mirror = mkdtempSync(join(tmpdir(), "aspace-argparity-"));
  mkdirSync(join(mirror, "library"), { recursive: true });
  cpSync(H.paths.libraryJson, join(mirror, "library", "library.json"));
});

const inProcess = () => createLocalOperationRuntime(libraryPaths(mirror));
const stored = (dir: string) => {
  try {
    return readFileSync(argumentGraphPath(dir, WORK), "utf8");
  } catch {
    return "";
  }
};
const entry = (action: string) => OPERATION_CATALOG.find((op) => op.id === `argument.${action}`);

describe("Copilot and catalog answer alike", () => {
  test("reads and edits, refusals and conflicts: same JSON, same file", async () => {
    const seeded = await userPuts(graph(["a1", "a2"]));
    replaceArgumentGraph(mirror, graph(["a1", "a2"]));
    const rev = seeded.rev;
    const ops: [string, Record<string, unknown>][] = [
      ["read", {}],
      ["create", { expectedRev: rev, id: "n1", argument: { title: "New one", claim: "c" } }],
      ["update", { expectedRev: rev + 1, id: "a1", patch: { claim: "changed", kind: "end" } }],
      ["add_edge", { expectedRev: rev + 2, from: "n1", to: "a1", role: "warrant" }],
      ["add_edge", { expectedRev: rev + 3, from: "n1", to: "a1", role: "warrant" }],
      ["add_edge", { expectedRev: rev + 3, from: "a1", to: "a1", role: "grounds" }],
      ["update", { expectedRev: rev, id: "a1", patch: { claim: "stale" } }],
      ["update", { expectedRev: rev + 3, id: "a1", patch: { title: " " } }],
      ["update", { expectedRev: rev + 3, id: "ghost", patch: { claim: "x" } }],
      ["delete", { expectedRev: rev + 3, id: "a2" }],
      ["remove_edge", { expectedRev: rev + 4, from: "a2", to: "a1", role: "grounds" }],
      ["read", { ids: ["a1", "ghost"] }],
      ["read", { ids: ["a1"], field: "claim", offset: 2 }],
      ["read", { workId: "doi:10.1000/none" }],
      ["create", { workId: "doi:10.1000/none", expectedRev: 0, argument: { title: "x" } }],
      ["clear", { workId: "doi:10.1000/w2", expectedRev: 0 }],
    ];
    const { results } = await run(
      ops.map(
        ([action, over]) =>
          () =>
            call(action, over)
      )
    );
    expect(results).toHaveLength(ops.length);
    for (const [i, [action, over]] of ops.entries()) {
      const params = { workId: WORK, ...over };
      const answered = await runCatalogOperation(
        inProcess(),
        `argument.${action}` as never,
        params
      );
      expect(results[i], `${i} ${action}`).toEqual(JSON.parse(JSON.stringify(answered)));
      expect(entry(action)?.result.safeParse(answered).success, `${i} ${action}`).toBe(true);
    }
    expect(stored(mirror)).toBe(stored(H.dataDir));
  });

  test("a replace of a non-empty graph asks the same card and ends the same way when approved", async () => {
    const seeded = await userPuts(graph(["a1", "a2", "a3"]));
    replaceArgumentGraph(mirror, graph(["a1", "a2", "a3"]));
    const next = {
      arguments: [
        { id: "n1", title: "N1" },
        { id: "n2", title: "N2" },
      ],
      edges: [{ from: "n2", to: "n1", role: "grounds" }],
    };
    // The Copilot's card.
    H.script = [
      () => call("replace", { expectedRev: seeded.rev, graph: next }),
      () => ({ text: "done" }),
    ];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    // The external card for the same request.
    const queue = new ExternalRequestQueue({ onChanged: () => {} });
    const waiting = runCatalogOperation({ ...inProcess(), confirm: queue }, "argument.replace", {
      workId: WORK,
      expectedRev: seeded.rev,
      graph: next,
    });
    let external = queue.list()[0];
    for (let i = 0; i < 200 && !external; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      external = queue.list()[0];
    }
    const fields = [
      "action",
      "object",
      "label",
      "mode",
      "current",
      "next",
      "baseRev",
      "objectDigest",
    ] as const;
    for (const field of fields)
      expect(external?.card[field as keyof typeof external.card], field).toEqual(
        shown[field as keyof typeof shown]
      );
    expect((await answer(shown, view, "approve")).status).toBe(200);
    await until(id, ["completed"]);
    await queue.decide(external?.id as string, "approve");
    const done = (await waiting) as Record<string, unknown>;
    expect(done).toMatchObject({ ok: true, status: "ok", rev: seeded.rev + 1 });
    expect(disk().arguments.map((a) => a.id)).toEqual(["n1", "n2"]);
    expect(stored(mirror)).toBe(stored(H.dataDir));
  });
});
