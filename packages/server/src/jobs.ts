/**
 * The hand-rolled serial job runner (decisions 13/16: 内存队列 + JSON 落盘,
 * 串行). Long library mutations — upload OCR, refresh, acquisition ingest —
 * run one at a time, FIFO, each persisted as `<dataDir>/jobs/<id>.json` on
 * every transition so state survives a restart: on boot, jobs still
 * `queued`/`running` are rewritten to the terminal `interrupted` status
 * (they are never re-run; leftover upload spool files are cleaned up too).
 *
 * Why server-local and not `core/src/jobs/`: nothing here is domain logic —
 * it is execution orchestration for the HTTP/WS layer (queueing, progress
 * reporting, broadcast hooks), sitting next to the only consumer. Core stays
 * pure domain; if M5's CLI ever needs queued ingest it can depend on this
 * package (or we promote the module then).
 *
 * Concurrency split with `library/lock.ts`: the runner serializes whole jobs
 * (MinerU quota + local CPU, decision 16); the lock separately guards the
 * library.json load→save critical sections against the *immediate* PATCH/POST
 * endpoints — mirroring Python, where `_WRITE_LOCK` covers rebuild's
 * load→save but never the OCR itself.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, JobKind, WsJobEvent } from "@argelanderspace/contracts";

/** What a job does; `report` appends a progress entry (persisted + broadcast). */
export type JobHandler = (job: Job, report: (message: string) => void) => Promise<unknown>;

/** Every emitted transition maps 1:1 to a WS `job.*` message type. */
export type JobEventType = WsJobEvent["type"];

export interface JobRunnerOptions {
  /** `<dataDir>/jobs` — created on demand. */
  dir: string;
  /** Transition sink (the WS hub wires in here). */
  onEvent?: (type: JobEventType, job: Job) => void;
  /** Clock seam for tests. */
  now?: () => Date;
}

export class JobRunner {
  private readonly dir: string;
  /**
   * Transition sink (the WS hub wires in here). Public and reassignable:
   * `createServer` builds the hub *after* the runner (hub ← http server ←
   * app ← runner), so the listener is attached last.
   */
  onEvent?: (type: JobEventType, job: Job) => void;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, Job>();
  /** The serial FIFO: each job chains onto the previous one's completion. */
  private chain: Promise<void> = Promise.resolve();
  /** Several parties may await the same job (the endpoint + tests + hooks). */
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();

  constructor(opts: JobRunnerOptions) {
    this.dir = opts.dir;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
    this.recover();
  }

  /** Boot recovery: load persisted jobs; unfinished → `interrupted`. */
  private recover(): void {
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      let job: Job;
      try {
        job = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Job;
      } catch {
        continue; // corrupt file: skip (never produced by the atomic writer)
      }
      if (job.status === "queued" || job.status === "running") {
        job.status = "interrupted";
        job.finishedAt = this.now().toISOString();
        this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
    // Spooled PDFs of interrupted upload jobs are dead weight.
    rmSync(join(this.dir, "spool"), { recursive: true, force: true });
  }

  /** Newest-first job table (for the WS `hello` snapshot). */
  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Enqueue *handler*; returns the queued job immediately. */
  submit(kind: JobKind, handler: JobHandler, payload?: unknown): Job {
    const job: Job = {
      id: `${kind}-${randomUUID()}`,
      kind,
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
      ...(payload === undefined ? {} : { payload }),
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    this.emit("job.created", job);
    this.chain = this.chain.then(() => this.run(job, handler));
    return job;
  }

  /** Resolves when the job reaches a terminal status (tests + sync endpoints). */
  waitFor(id: string): Promise<Job> {
    const job = this.jobs.get(id);
    if (job === undefined) return Promise.reject(new Error(`unknown job ${id}`));
    if (job.status !== "queued" && job.status !== "running") return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** Where an upload job's PDF bytes wait for their turn. */
  spoolPath(jobId: string): string {
    const dir = join(this.dir, "spool");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${jobId}.pdf`);
  }

  private async run(job: Job, handler: JobHandler): Promise<void> {
    job.status = "running";
    job.startedAt = this.now().toISOString();
    this.persist(job);
    const report = (message: string): void => {
      job.progress.push({ at: this.now().toISOString(), message });
      this.persist(job);
      this.emit("job.progress", job);
    };
    try {
      job.result = (await handler(job, report)) ?? null;
      job.status = "done";
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      job.status = "failed";
    }
    job.finishedAt = this.now().toISOString();
    this.persist(job);
    this.emit(job.status === "done" ? "job.done" : "job.failed", job);
    const list = this.waiters.get(job.id);
    if (list) {
      this.waiters.delete(job.id);
      for (const waiter of list) waiter(job);
    }
  }

  private emit(type: JobEventType, job: Job): void {
    this.onEvent?.(type, structuredClone(job));
  }

  /** Atomic write (`*.tmp` + rename) so a crash never leaves half a record. */
  private persist(job: Job): void {
    const path = join(this.dir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), "utf8");
    renameSync(`${path}.tmp`, path);
  }
}
