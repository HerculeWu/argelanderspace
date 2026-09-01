/**
 * The polling library watcher (Stage 3): the first poll only establishes a
 * baseline, `library.json` rewrites and doc-dir creates fire exactly once,
 * doc-JSON rewrites inside an *existing* doc dir fire too (the upload layout
 * a non-recursive `fs.watch` would miss), and unrelated writes / quiet
 * periods stay silent. Real timers with an injected 50ms interval against
 * throwaway tmp data dirs.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type LibraryWatcher, startLibraryWatcher } from "../src/watch.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds (the watcher's interval makes exact sleeps racy). */
async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await sleep(20);
  }
}

let watcher: LibraryWatcher | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
});

/** Watch *dataDir* at the test interval; returns the current fire count. */
function start(dataDir: string): () => number {
  let count = 0;
  watcher = startLibraryWatcher({ dataDir, intervalMs: 50, onChange: () => count++ });
  return () => count;
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "aspace-watch-"));
}

describe("library watcher", () => {
  test("pre-existing content only baselines: a quiet tree never fires", async () => {
    const dataDir = tmpDataDir();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    const fires = start(dataDir);
    await sleep(200); // several intervals
    expect(fires()).toBe(0);
  });

  test("a library.json rewrite fires once, then stays quiet", async () => {
    const dataDir = tmpDataDir();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    const fires = start(dataDir);
    await sleep(150);
    expect(fires()).toBe(0); // the write above is the baseline, not a change
    writeFileSync(join(dataDir, "library", "library.json"), '{"works":[]}');
    await waitFor(() => fires() === 1);
    await sleep(150); // no further change → no repeat
    expect(fires()).toBe(1);
  });

  test("a new output/<docId>/<docId>.json fires; rewriting it in place fires again", async () => {
    const dataDir = tmpDataDir();
    const fires = start(dataDir);
    await sleep(150);
    expect(fires()).toBe(0); // missing library/ and output/ are the baseline
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    await waitFor(() => fires() === 1);
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), '{"doc_id":"foo"}');
    await waitFor(() => fires() === 2);
  });

  test("unrelated writes (jobs/, stray files) never fire", async () => {
    const dataDir = tmpDataDir();
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    const fires = start(dataDir);
    await sleep(150);
    mkdirSync(join(dataDir, "jobs"), { recursive: true });
    writeFileSync(join(dataDir, "jobs", "job-1.json"), "{}");
    writeFileSync(join(dataDir, "output", "stray.txt"), "x"); // not a doc dir
    writeFileSync(join(dataDir, "output", "foo", "notes.txt"), "x"); // not the doc JSON
    await sleep(200);
    expect(fires()).toBe(0);
  });
});
