/**
 * Zod schemas for the plan page (Stage 4) — the on-disk shape of
 * `<statusDir>/plans.json` and the `plan.changed` WebSocket message.
 *
 * Data model (locked 2026-09-02, see `.kimi-code/memory/2026-09-02-stage4-roadmap.md`):
 * - two levels: plans embed their tasks; the tasks array index IS the display
 *   order (no `order` field — drag-reorder persists the reordered array);
 * - `due` is deadline semantics (ISO date) on both Plan (required) and Task
 *   (optional);
 * - `PlansFile.rev` is persisted in the file and bumped by the server on every
 *   successful PUT (optimistic lock: a PUT whose body `rev` doesn't match the
 *   current one is rejected with 409);
 * - ids are agent-stable (`p_<8 hex>` / `t_<8 hex>`, crypto.randomBytes) so the
 *   Stage-4.1 agent surface can address plans/tasks directly.
 */

import { z } from "zod";

// ---- Task ------------------------------------------------------------------ //

export const TaskStatusSchema = z.enum(["todo", "doing", "blocked", "done"]);

/** A link from a task to a reader document (library `doc_id`). */
export const TaskLinkSchema = z.object({
  doc_id: z.string().min(1),
});

export const TaskSchema = z.object({
  /** `t_<8 hex>` (crypto.randomBytes). */
  id: z.string().regex(/^t_[0-9a-f]{8}$/),
  title: z.string().min(1),
  status: TaskStatusSchema,
  /** Optional deadline, ISO date (`YYYY-MM-DD`). */
  due: z.iso.date().optional(),
  /** Optional note (markdown, may carry `$…$`/`$$…$$` math). */
  note: z.string().optional(),
  links: z.array(TaskLinkSchema).default([]),
  /** Pinned into the 今日聚焦 view. */
  focused: z.boolean(),
  /** ISO-8601 timestamp. */
  created_at: z.iso.datetime(),
});

// ---- Plan ------------------------------------------------------------------ //

export const PlanSchema = z.object({
  /** `p_<8 hex>` (crypto.randomBytes). */
  id: z.string().regex(/^p_[0-9a-f]{8}$/),
  name: z.string().min(1),
  desc: z.string().optional(),
  /** Deadline, ISO date (`YYYY-MM-DD`). */
  due: z.iso.date(),
  /** Lucide icon name (one of the 8 the plan modal offers). */
  icon: z.string().min(1).default("target"),
  /** ISO-8601 timestamp. */
  created_at: z.iso.datetime(),
  /** Display order = array order. */
  tasks: z.array(TaskSchema).default([]),
});

// ---- PlansFile ------------------------------------------------------------- //

/**
 * The whole `plans.json` document. `rev` is the optimistic-lock version the
 * server checks on PUT and bumps on every accepted write.
 */
export const PlansFileSchema = z.object({
  version: z.literal(1),
  rev: z.number().int().nonnegative(),
  plans: z.array(PlanSchema),
});

// ---- WebSocket message (server → client) ----------------------------------- //

/**
 * Fired after a successful `PUT /api/plans` or when the status-dir poller
 * spotted an external write (agent CLI, Stage 4.1); `cause` names the trigger.
 * Same shape as `library.changed` but defined independently — its `cause` enum
 * is the plan domain's own and must NOT be folded into `WsLibraryChangedSchema`.
 */
export const WsPlanChangedSchema = z.object({
  type: z.literal("plan.changed"),
  cause: z.enum(["put", "external"]).optional(),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskLink = z.infer<typeof TaskLinkSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlansFile = z.infer<typeof PlansFileSchema>;
export type WsPlanChanged = z.infer<typeof WsPlanChangedSchema>;
