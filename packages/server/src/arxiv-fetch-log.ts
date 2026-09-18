/**
 * Stage 15 (D12): the arXiv-fetch failure log — `<dataDir>/logs/
 * arxiv-fetch.jsonl`, one append-only JSON line per failed/interrupted
 * arXiv auto-ingest job.
 *
 * Why a dedicated plain-text log: the user iterates on arXiv-source failures
 * with HIGH priority (an arXiv LaTeX source should compile — a failure is our
 * pipeline's bug, unlike user-uploaded zips whose content may be broken), and
 * the v1 product ships as an npm package, so the log must stay a directly
 * readable file — not folded into some opaque store. Successes are not
 * logged (the library itself is the record); user uploads are not logged
 * here (this stage records arXiv sources only).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Pipeline stage at failure; `"interrupted"` = the boot-time job rewrite. */
export type ArxivFetchStage = "download" | "extract" | "compile" | "attach" | "interrupted";

export interface ArxivFetchLogEntry {
  /** ISO-8601 timestamp (the job's finishedAt when available). */
  time: string;
  jobId: string;
  workId: string | null;
  arxivId: string | null;
  stage: ArxivFetchStage;
  error: string;
}

export function arxivFetchLogPath(dataDir: string): string {
  return join(dataDir, "logs", "arxiv-fetch.jsonl");
}

/**
 * Append one entry (best-effort fs: a logging failure must never mask the
 * job's own outcome, so callers wrap this in try/catch + console.error).
 */
export function appendArxivFetchLog(dataDir: string, entry: ArxivFetchLogEntry): void {
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  appendFileSync(arxivFetchLogPath(dataDir), `${JSON.stringify(entry)}\n`, "utf8");
}
