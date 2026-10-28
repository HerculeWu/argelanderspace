/**
 * The instance record of a running workbench (ADR 0015 "single writer"; release-0.2 ticket 02;
 * `docs/operation-catalog.md` "Running workbench"): how a CLI process finds out that a workbench (`serve` or the
 * desktop host) is running for a data directory, and how it reaches it.
 *
 * The record is `<dataDir>/workbench.json`, mode 0600: `{ v, pid, port, token, startedAt }`. `token` is random per
 * run; it is the credential of the operation route (operation-routes.ts) and is never logged or printed. The record is
 * published atomically (a temp file hard-linked into place, which fails when a record exists), so a reader never sees
 * half a file and two starts never both win. A normal exit revokes it; a crash leaves it behind, which is recognised:
 * a record is only trusted after its pid exists AND the token handshake with its port succeeds.
 *
 * Three verdicts on a record: `live` (handshake answered with this pid), `stale` (pid gone, nothing listening, or the
 * port answers but not to this token or pid - another program or another run), `unresponsive` (pid exists but the
 * handshake timed out: busy, not dead). Stale records are removed (only if still the same record); an unresponsive one
 * is neither removed nor bypassed - the CLI reports it rather than writing around a workbench that may still be there.
 */
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKBENCH_RECORD_FILE = "workbench.json";
export const WORKBENCH_HANDSHAKE_PATH = "/api/operations/handshake";
export const WORKBENCH_RUN_PATH = "/api/operations/run";
/** How long a handshake may take before the workbench counts as unresponsive. */
export const WORKBENCH_HANDSHAKE_TIMEOUT_MS = 3000;

export interface WorkbenchRecord {
  v: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export type WorkbenchVerdict = "live" | "stale" | "unresponsive";

export class WorkbenchConflictError extends Error {
  constructor(
    readonly record: Pick<WorkbenchRecord, "pid" | "port">,
    readonly verdict: "live" | "unresponsive"
  ) {
    super(
      `another ArgelanderSpace workbench is already running for this data directory (pid ${record.pid}, port ${record.port})` +
        (verdict === "unresponsive" ? " and is not answering right now" : "")
    );
  }
}

/** Raised for the CLI when the record exists, its process exists, but the workbench does not answer. */
export class WorkbenchUnresponsiveError extends Error {
  constructor(readonly record: Pick<WorkbenchRecord, "pid" | "port">) {
    super(
      `the workbench for this data directory (pid ${record.pid}, port ${record.port}) is running but did not answer; try again, or close it first`
    );
  }
}

export function newWorkbenchToken(): string {
  return randomBytes(32).toString("hex");
}

export function workbenchRecordPath(dataDir: string): string {
  return join(dataDir, WORKBENCH_RECORD_FILE);
}

function isRecord(value: unknown): value is WorkbenchRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    typeof r.token === "string" &&
    r.token.length > 0 &&
    typeof r.startedAt === "string"
  );
}

/** The record on disk; null when absent or not a record (an unreadable file is as good as none). */
export function readWorkbenchRecord(dataDir: string): WorkbenchRecord | null {
  let text: string;
  try {
    text = readFileSync(workbenchRecordPath(dataDir), "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but is not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Judge a record: the process, then the token handshake. Never throws. */
export async function judgeWorkbench(
  record: WorkbenchRecord,
  timeoutMs: number = WORKBENCH_HANDSHAKE_TIMEOUT_MS
): Promise<WorkbenchVerdict> {
  if (!pidExists(record.pid)) return "stale";
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${WORKBENCH_HANDSHAKE_PATH}`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return "stale";
    const body = (await response.json()) as { ok?: unknown; pid?: unknown };
    return body.ok === true && body.pid === record.pid ? "live" : "stale";
  } catch (e) {
    const name = (e as { name?: string }).name;
    // A timeout while the process exists: busy, not dead. Refused / reset / garbage: nothing of ours is there.
    return name === "TimeoutError" || name === "AbortError" ? "unresponsive" : "stale";
  }
}

/** Remove the record at `dataDir` only if it is still exactly `record` (a fresh start may have replaced it). */
function removeIfSame(dataDir: string, record: WorkbenchRecord | null): void {
  const now = readWorkbenchRecord(dataDir);
  if (record !== null && (now === null || now.token !== record.token)) return;
  try {
    unlinkSync(workbenchRecordPath(dataDir));
  } catch {
    /* already gone */
  }
}

/**
 * The live workbench of `dataDir`, or null when none runs (a stale record is removed on the way). Throws
 * {@link WorkbenchUnresponsiveError} when a process holds the record but does not answer.
 */
export async function findRunningWorkbench(
  dataDir: string,
  timeoutMs?: number
): Promise<WorkbenchRecord | null> {
  const record = readWorkbenchRecord(dataDir);
  if (record === null) {
    // A file that is not a record (corrupt) is stale too, whatever wrote it.
    removeCorrupt(dataDir);
    return null;
  }
  const verdict = await judgeWorkbench(record, timeoutMs);
  if (verdict === "live") return record;
  if (verdict === "unresponsive") throw new WorkbenchUnresponsiveError(record);
  removeIfSame(dataDir, record);
  return null;
}

function removeCorrupt(dataDir: string): void {
  try {
    readFileSync(workbenchRecordPath(dataDir));
  } catch {
    return; // absent
  }
  if (readWorkbenchRecord(dataDir) === null) removeIfSame(dataDir, null);
}

export interface WorkbenchRegistration {
  record: WorkbenchRecord;
  /** Remove the record if it is still this run's; safe to call twice. */
  revoke(): void;
}

/**
 * Register this process as the workbench of `dataDir`. A record whose workbench is live or unresponsive refuses the
 * start ({@link WorkbenchConflictError}: one workbench per data directory); a stale one is replaced.
 */
export async function registerWorkbench(
  dataDir: string,
  own: { port: number; token: string; pid?: number }
): Promise<WorkbenchRegistration> {
  mkdirSync(dataDir, { recursive: true });
  const record: WorkbenchRecord = {
    v: 1,
    pid: own.pid ?? process.pid,
    port: own.port,
    token: own.token,
    startedAt: new Date().toISOString(),
  };
  const final = workbenchRecordPath(dataDir);
  const temp = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(temp, final);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const existing = readWorkbenchRecord(dataDir);
      if (existing !== null) {
        const verdict = await judgeWorkbench(existing);
        if (verdict !== "stale") throw new WorkbenchConflictError(existing, verdict);
      }
      removeIfSame(dataDir, existing);
      if (attempt === 4) throw new Error("could not register the workbench record");
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
  let revoked = false;
  return {
    record,
    revoke() {
      if (revoked) return;
      revoked = true;
      const now = readWorkbenchRecord(dataDir);
      if (now?.token === record.token) removeIfSame(dataDir, record);
    },
  };
}

/** What the CLI tells the workbench about itself (the confirmation card of ticket 04 shows the command line). */
export interface OperationClient {
  pid?: number;
  commandLine?: string;
}

export interface WorkbenchAnswer {
  status: number;
  body: unknown;
}

/**
 * Send one operation to a live workbench. Resolves with the HTTP status and parsed body; rejects when the connection
 * fails or breaks (the operation may or may not have run). `signal` aborts the request: the server sees it as the
 * client leaving (ticket 04: the pending card is withdrawn).
 */
export async function runOnWorkbench(
  workbench: Pick<WorkbenchRecord, "port" | "token">,
  request: { id: string; params: Record<string, unknown>; client?: OperationClient },
  signal?: AbortSignal
): Promise<WorkbenchAnswer> {
  const response = await fetch(`http://127.0.0.1:${workbench.port}${WORKBENCH_RUN_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workbench.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
