/**
 * Zod schemas for the M4 job runner and the `/ws` WebSocket channel.
 *
 * The job runner (decisions 13/16: hand-rolled, serial, JSON state under
 * `<dataDir>/jobs/`) executes the long library mutations — upload OCR,
 * refresh, acquisition ingest — one at a time and persists each job as JSON
 * so state survives restarts (unfinished jobs boot as `interrupted`).
 *
 * The WebSocket channel (decision 14: full-duplex WS, not SSE) broadcasts
 * every job transition plus `library.changed` so the web client can
 * live-reload. Messages are JSON, one object per frame, all server → client
 * for now (the duplex half is reserved for Stage-2 agent interaction).
 */

import { z } from "zod";

// ---- jobs ------------------------------------------------------------------ //

/** The long operations the runner executes (`upload` = user LaTeX-zip attach, MS2). */
export const JobKindSchema = z.enum(["upload", "refresh", "ingest"]);

/**
 * `interrupted`: the job was `queued`/`running` when the server stopped; the
 * runner rewrites it to this terminal state on boot (it is never re-run —
 * upload spool files are cleaned up with it).
 */
export const JobStatusSchema = z.enum(["queued", "running", "done", "failed", "interrupted"]);

/** One progress entry; jobs with no intermediate milestones only have few. */
export const JobProgressSchema = z.object({
  /** ISO-8601 timestamp. */
  at: z.string(),
  message: z.string(),
});

/**
 * A job record — the on-disk JSON shape under `<dataDir>/jobs/<id>.json`,
 * the `{"job": ...}` body of the async-upload `202`, and the payload of every
 * `job.*` WS message (one shape everywhere).
 */
export const JobSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  /** ISO-8601 timestamps; null while not reached yet. */
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  progress: z.array(JobProgressSchema),
  /** Handler return value once `done` (e.g. `{"ref": ...}` for upload). */
  result: z.unknown().nullable(),
  /** `str(exc)` once `failed`; null otherwise. */
  error: z.string().nullable(),
  /** Submission context (e.g. the upload query params); for forensics only. */
  payload: z.unknown().optional(),
});

// ---- WebSocket messages (server → client) ---------------------------------- //

/** Sent immediately on connect: the current job table (late-joiner catch-up). */
export const WsHelloSchema = z.object({
  type: z.literal("hello"),
  jobs: z.array(JobSchema),
});

/** Fired on every job transition / progress tick; carries the full job. */
export const WsJobEventSchema = z.object({
  type: z.enum(["job.created", "job.progress", "job.done", "job.failed"]),
  job: JobSchema,
});

/**
 * Fired after any mutation that rewrote the library (refresh / patch /
 * add-ref / upload-done) or when the library poller spotted an external
 * write (agent CLI, Stage 3); `cause` names the trigger. M5's frontend
 * reloads `/api/library` on this.
 */
export const WsLibraryChangedSchema = z.object({
  type: z.literal("library.changed"),
  cause: z.enum(["refresh", "patch", "add", "upload", "external"]),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  WsHelloSchema,
  WsJobEventSchema,
  WsLibraryChangedSchema,
]);

// ---- async upload (202) ------------------------------------------------------ //

/**
 * `POST /api/library/upload` (rebuilt in MS2 for LaTeX zips) answers `202`
 * immediately with the queued job; watch `/ws` for the outcome. The legacy
 * synchronous response stays {@link UploadResponseSchema}.
 */
export const UploadAcceptedResponseSchema = z.object({
  job: JobSchema,
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type JobKind = z.infer<typeof JobKindSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobProgress = z.infer<typeof JobProgressSchema>;
export type Job = z.infer<typeof JobSchema>;
export type WsHello = z.infer<typeof WsHelloSchema>;
export type WsJobEvent = z.infer<typeof WsJobEventSchema>;
export type WsLibraryChanged = z.infer<typeof WsLibraryChangedSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
export type UploadAcceptedResponse = z.infer<typeof UploadAcceptedResponseSchema>;
