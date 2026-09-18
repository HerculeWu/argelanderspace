/**
 * The serial job runner: FIFO execution, JSON persistence across a "restart",
 * interrupted-state recovery, and the ordered event stream.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { JobRunner } from "../src/jobs.js";

const makeDir = () => mkdtempSync(join(tmpdir(), "aspace-jobs-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("JobRunner execution", () => {
  test("jobs run one at a time, in FIFO order", async () => {
    const runner = new JobRunner({ dir: makeDir() });
    const trace: string[] = [];
    const mk = (name: string) => async () => {
      trace.push(`start:${name}`);
      await sleep(15);
      trace.push(`end:${name}`);
      return name;
    };
    const a = runner.submit("ingest", mk("a"));
    const b = runner.submit("refresh", mk("b"));
    const c = runner.submit("upload", mk("c"));
    await Promise.all([runner.waitFor(a.id), runner.waitFor(b.id), runner.waitFor(c.id)]);
    // strictly sequential: no interleaving of any two jobs
    expect(trace).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(runner.get(c.id)?.result).toBe("c");
  });

  test("progress entries accumulate; failure lands in job.error", async () => {
    const runner = new JobRunner({ dir: makeDir() });
    const ok = runner.submit("ingest", async (_job, report) => {
      report("step 1");
      report("step 2");
      return { n: 2 };
    });
    const bad = runner.submit("ingest", async () => {
      throw new Error("boom");
    });
    const okDone = await runner.waitFor(ok.id);
    expect(okDone.status).toBe("done");
    expect(okDone.progress.map((p) => p.message)).toEqual(["step 1", "step 2"]);
    expect(okDone.result).toEqual({ n: 2 });
    const badDone = await runner.waitFor(bad.id);
    expect(badDone.status).toBe("failed");
    expect(badDone.error).toBe("boom");
    expect(badDone.startedAt).not.toBeNull();
    expect(badDone.finishedAt).not.toBeNull();
  });

  test("onEvent fires created → progress → done in order", async () => {
    const events: string[] = [];
    const runner = new JobRunner({
      dir: makeDir(),
      onEvent: (type, job) => events.push(`${type}:${job.status}`),
    });
    const job = runner.submit("refresh", async (_j, report) => {
      report("halfway");
    });
    await runner.waitFor(job.id);
    expect(events).toEqual(["job.created:queued", "job.progress:running", "job.done:done"]);
  });
});

describe("JobRunner persistence", () => {
  test("job records land as JSON on disk on every transition", async () => {
    const dir = makeDir();
    const runner = new JobRunner({ dir });
    const job = runner.submit("ingest", async () => 42);
    await runner.waitFor(job.id);
    const onDisk = JSON.parse(readFileSync(join(dir, `${job.id}.json`), "utf8")) as Job;
    expect(onDisk).toMatchObject({ id: job.id, kind: "ingest", status: "done", result: 42 });
  });

  test("a new runner on the same dir sees finished jobs unchanged", async () => {
    const dir = makeDir();
    const a = new JobRunner({ dir });
    const job = a.submit("refresh", async () => ({ works: 3 }));
    await a.waitFor(job.id);
    const b = new JobRunner({ dir }); // "restart"
    expect(b.get(job.id)).toMatchObject({ status: "done", result: { works: 3 } });
    expect(b.list()).toHaveLength(1);
  });

  test("unfinished jobs boot as interrupted; leftover spool is cleaned", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "spool"), { recursive: true });
    writeFileSync(join(dir, "spool", "dead.pdf"), "%PDF-1.4");
    const stale: Job = {
      id: "upload-stale",
      kind: "upload",
      status: "running",
      createdAt: "2026-08-26T00:00:00.000Z",
      startedAt: "2026-08-26T00:00:01.000Z",
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
    };
    writeFileSync(join(dir, "upload-stale.json"), JSON.stringify(stale));
    const runner = new JobRunner({ dir }); // "restart" while it was running
    const recovered = runner.get("upload-stale");
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.finishedAt).not.toBeNull();
    expect(existsSync(join(dir, "spool", "dead.pdf"))).toBe(false);
    // and the interrupted marker itself is persisted
    const onDisk = JSON.parse(readFileSync(join(dir, "upload-stale.json"), "utf8")) as Job;
    expect(onDisk.status).toBe("interrupted");
  });

  test("a queued-at-shutdown job is also interrupted, and never re-runs", async () => {
    const dir = makeDir();
    const stale: Job = {
      id: "refresh-queued",
      kind: "refresh",
      status: "queued",
      createdAt: "2026-08-26T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
    };
    writeFileSync(join(dir, "refresh-queued.json"), JSON.stringify(stale));
    const runner = new JobRunner({ dir });
    expect(runner.get("refresh-queued")?.status).toBe("interrupted");
    await sleep(20); // give a hypothetical rogue execution a chance
    expect(runner.get("refresh-queued")?.status).toBe("interrupted");
  });

  test("onInterrupted fires once per boot-interrupted job (Stage 15 log hook)", () => {
    const dir = makeDir();
    const mk = (id: string, kind: Job["kind"], status: Job["status"]): Job => ({
      id,
      kind,
      status,
      createdAt: "2026-09-17T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
    });
    writeFileSync(join(dir, "ingest-a.json"), JSON.stringify(mk("ingest-a", "ingest", "running")));
    writeFileSync(join(dir, "upload-b.json"), JSON.stringify(mk("upload-b", "upload", "queued")));
    writeFileSync(join(dir, "refresh-c.json"), JSON.stringify(mk("refresh-c", "refresh", "done")));
    const interrupted: Job[] = [];
    const runner = new JobRunner({ dir, onInterrupted: (j) => interrupted.push(j) });
    expect(interrupted.map((j) => j.id).sort()).toEqual(["ingest-a", "upload-b"]);
    expect(interrupted.every((j) => j.status === "interrupted")).toBe(true);
    expect(runner.get("refresh-c")?.status).toBe("done"); // finished jobs don't fire
  });
});
