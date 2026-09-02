/**
 * The polling external-write watcher (Stage 3; plans sub-fingerprint in
 * Stage 4): the first poll only establishes a baseline, `library.json`
 * rewrites and doc-dir creates fire `onLibraryChange` exactly once,
 * doc-JSON rewrites inside an *existing* doc dir fire too (the upload layout
 * a non-recursive `fs.watch` would miss), and `status/plans.json` writes fire
 * `onPlansChange` — each side independently, so the rebroadcast names the
 * right domain. Unrelated writes / quiet periods stay silent. Real timers
 * with an injected 50ms interval against throwaway tmp dirs.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startWatcher, type Watcher } from "../src/watch.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds (the watcher's interval makes exact sleeps racy). */
async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await sleep(20);
  }
}

let watcher: Watcher | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
});

interface Fires {
  library: () => number;
  plans: () => number;
}

/** Watch the pair at the test interval; returns the per-domain fire counts. */
function start(dataDir: string, statusDir: string): Fires {
  let library = 0;
  let plans = 0;
  watcher = startWatcher({
    dataDir,
    statusDir,
    intervalMs: 50,
    onLibraryChange: () => library++,
    onPlansChange: () => plans++,
  });
  return { library: () => library, plans: () => plans };
}

/** `<tmp>/aspace-watch-XXX/{data,status}` — the server layout in miniature. */
function tmpDirs(): { dataDir: string; statusDir: string } {
  const root = mkdtempSync(join(tmpdir(), "aspace-watch-"));
  return { dataDir: join(root, "data"), statusDir: join(root, "status") };
}

describe("library watcher", () => {
  test("pre-existing content only baselines: a quiet tree never fires", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "plans.json"), "{}");
    const fires = start(dataDir, statusDir);
    await sleep(200); // several intervals
    expect(fires.library()).toBe(0);
    expect(fires.plans()).toBe(0);
  });

  test("a library.json rewrite fires once, then stays quiet", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    const fires = start(dataDir, statusDir);
    await sleep(150);
    expect(fires.library()).toBe(0); // the write above is the baseline, not a change
    writeFileSync(join(dataDir, "library", "library.json"), '{"works":[]}');
    await waitFor(() => fires.library() === 1);
    await sleep(150); // no further change → no repeat
    expect(fires.library()).toBe(1);
  });

  test("a new output/<docId>/<docId>.json fires; rewriting it in place fires again", async () => {
    const { dataDir, statusDir } = tmpDirs();
    const fires = start(dataDir, statusDir);
    await sleep(150);
    expect(fires.library()).toBe(0); // missing library/ and output/ are the baseline
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    await waitFor(() => fires.library() === 1);
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), '{"doc_id":"foo"}');
    await waitFor(() => fires.library() === 2);
  });

  test("unrelated writes (jobs/, stray files) never fire", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "output", "foo"), { recursive: true });
    writeFileSync(join(dataDir, "output", "foo", "foo.json"), "{}");
    const fires = start(dataDir, statusDir);
    await sleep(150);
    mkdirSync(join(dataDir, "jobs"), { recursive: true });
    writeFileSync(join(dataDir, "jobs", "job-1.json"), "{}");
    writeFileSync(join(dataDir, "output", "stray.txt"), "x"); // not a doc dir
    writeFileSync(join(dataDir, "output", "foo", "notes.txt"), "x"); // not the doc JSON
    await sleep(200);
    expect(fires.library()).toBe(0);
  });
});

describe("plans watcher (Stage 4)", () => {
  test("a status/plans.json write fires onPlansChange only — never onLibraryChange", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    const fires = start(dataDir, statusDir);
    await sleep(150); // missing plans.json is the baseline
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "plans.json"), '{"version":1,"rev":0,"plans":[]}');
    await waitFor(() => fires.plans() === 1);
    writeFileSync(join(statusDir, "plans.json"), '{"version":1,"rev":1,"plans":[]}');
    await waitFor(() => fires.plans() === 2);
    await sleep(150);
    expect(fires.library()).toBe(0); // plans writes never leak into the library domain
    expect(fires.plans()).toBe(2);
  });

  test("a library.json rewrite fires onLibraryChange only — never onPlansChange", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "plans.json"), '{"version":1,"rev":0,"plans":[]}');
    const fires = start(dataDir, statusDir);
    await sleep(150);
    writeFileSync(join(dataDir, "library", "library.json"), '{"works":[]}');
    await waitFor(() => fires.library() === 1);
    await sleep(150);
    expect(fires.plans()).toBe(0); // library writes never leak into the plans domain
  });

  test("both files changing inside one poll window fires both callbacks", async () => {
    const { dataDir, statusDir } = tmpDirs();
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(join(dataDir, "library", "library.json"), "{}");
    const fires = start(dataDir, statusDir);
    await sleep(150);
    writeFileSync(join(dataDir, "library", "library.json"), '{"works":[]}');
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, "plans.json"), '{"version":1,"rev":0,"plans":[]}');
    await waitFor(() => fires.library() === 1 && fires.plans() === 1);
  });
});
