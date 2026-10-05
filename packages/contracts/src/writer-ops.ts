/**
 * Writer manuscript operations and page context shared by the Copilot `writer` tool and the Writer UI
 * (copilot ticket 22).
 *
 * A manuscript is its own identity (never a Work or Doc). Only what the Writer's own list/editor already lets a
 * user do is listed: create (template + title), edit the Info modal's fields, the user preamble and the template
 * select, delete (which the real UI confirms) and open/close an editor. Cells, comments, assets, citation/label
 * insertion, Render and export belong to the next ticket. Every write names its manuscript and carries the `rev` of
 * the reading it was planned from; the template catalog stays read-only (no template management exists).
 */
import { z } from "zod";
import {
  AuthorSchema,
  CellIdSchema,
  CellSchema,
  CommentIdSchema,
  CommentSchema,
  ManuscriptIdSchema,
  ManuscriptSchema,
  ManuscriptSummarySchema,
  WriterTemplateIdSchema,
} from "./writer.js";

const Rev = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

// ---- Page context ------------------------------------------------------------------------------------ //

/** Keys of a manuscript that are bookkeeping, not user content: never part of a draft or its merge. */
const META_KEYS = new Set([
  "id",
  "rev",
  "version",
  "created_at",
  "updated_at",
  "cells",
  "comments",
]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)])
    );
  return value;
}
/** Structural equality, independent of key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** The user's local edits that are not on disk yet, as what differs from the saved manuscript. */
export const WriterDraftSchema = z
  .object({
    unsaved: z.literal(true),
    /** Top-level values (title, template, authors, userPreamble, infoValues, unknown keys...) that differ. */
    fields: z.record(z.string(), z.unknown()),
    cells: z
      .object({
        /** Cells that are new or whose content differs, in full as the draft has them. */
        changed: z.array(CellSchema),
        removed: z.array(CellIdSchema),
        /** The draft's whole cell order when it is not the saved order. */
        order: z.array(CellIdSchema).nullable(),
      })
      .strict(),
    comments: z
      .object({ added: z.array(CommentSchema), removed: z.array(CommentIdSchema) })
      .strict(),
  })
  .strict();
export type WriterDraft = z.infer<typeof WriterDraftSchema>;

type Manuscript = z.infer<typeof ManuscriptSchema>;

/**
 * What the local manuscript differs by from the saved one, or null when they hold the same content. Never copies the
 * unchanged cells, so a draft is as small as the edit.
 */
export function diffManuscriptDraft(saved: Manuscript, local: Manuscript): WriterDraft | null {
  const fields: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(saved), ...Object.keys(local)])) {
    if (META_KEYS.has(key)) continue;
    if (!sameJson(saved[key], local[key])) fields[key] = local[key] ?? null;
  }
  const savedCells = new Map(saved.cells.map((cell) => [cell.id, cell]));
  const localIds = new Set(local.cells.map((cell) => cell.id));
  const changed = local.cells.filter((cell) => !sameJson(savedCells.get(cell.id), cell));
  const removed = saved.cells.filter((cell) => !localIds.has(cell.id)).map((cell) => cell.id);
  const order = sameJson(
    saved.cells.map((cell) => cell.id),
    local.cells.map((cell) => cell.id)
  )
    ? null
    : local.cells.map((cell) => cell.id);
  const savedComments = new Map(saved.comments.map((comment) => [comment.id, comment]));
  const localComments = new Set(local.comments.map((comment) => comment.id));
  const added = local.comments.filter(
    (comment) => !sameJson(savedComments.get(comment.id), comment)
  );
  const removedComments = saved.comments
    .filter((comment) => !localComments.has(comment.id))
    .map((comment) => comment.id);
  if (
    !Object.keys(fields).length &&
    !changed.length &&
    !removed.length &&
    !order &&
    !added.length &&
    !removedComments.length
  )
    return null;
  return {
    unsaved: true,
    fields,
    cells: { changed, removed, order },
    comments: { added, removed: removedComments },
  };
}

/**
 * The editor met a newer saved manuscript (an agent or another pane saved first) while it held unsaved edits. Keeps
 * those edits on top of `current` instead of discarding them: every value the draft changed against `base` (what the
 * editor last had from disk) is kept, everything it did not touch comes from `current`. Where both sides changed the
 * same value the user's typing wins, and `contested` names it so the page can say so. `rev` is current's.
 */
export function rebaseManuscriptDraft(
  base: Manuscript,
  local: Manuscript,
  current: Manuscript
): { merged: Manuscript; contested: string[] } {
  const contested: string[] = [];
  const merged: Record<string, unknown> = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (META_KEYS.has(key) || sameJson(base[key], local[key])) continue;
    if (!sameJson(base[key], current[key]) && !sameJson(local[key], current[key]))
      contested.push(key);
    if (local[key] === undefined) delete merged[key];
    else merged[key] = structuredClone(local[key]);
  }
  const baseCells = new Map(base.cells.map((cell) => [cell.id, cell]));
  const currentCells = new Map(current.cells.map((cell) => [cell.id, cell]));
  const localIds = new Set(local.cells.map((cell) => cell.id));
  let cells = [...current.cells];
  for (const cell of base.cells) {
    if (localIds.has(cell.id) || !currentCells.has(cell.id)) continue;
    // The user deleted it; a newer change to the same cell is lost with it.
    if (!sameJson(currentCells.get(cell.id), cell)) contested.push(`cell ${cell.id}`);
    cells = cells.filter((item) => item.id !== cell.id);
  }
  local.cells.forEach((cell, index) => {
    if (sameJson(baseCells.get(cell.id), cell)) return;
    const copy = structuredClone(cell);
    const at = cells.findIndex((item) => item.id === cell.id);
    if (at >= 0) {
      if (!sameJson(baseCells.get(cell.id), currentCells.get(cell.id)))
        contested.push(`cell ${cell.id}`);
      cells[at] = copy;
      return;
    }
    // A new cell goes after the cell the user put it behind, when that cell is still there.
    let after = -1;
    for (let back = index - 1; back >= 0 && after < 0; back--) {
      const anchor = local.cells[back];
      if (anchor) after = cells.findIndex((item) => item.id === anchor.id);
    }
    cells.splice(after + 1, 0, copy);
  });
  merged.cells = cells;
  const baseComments = new Map(base.comments.map((comment) => [comment.id, comment]));
  const localCommentIds = new Set(local.comments.map((comment) => comment.id));
  let comments = current.comments.filter(
    (comment) => !(baseComments.has(comment.id) && !localCommentIds.has(comment.id))
  );
  for (const comment of local.comments)
    if (
      !sameJson(baseComments.get(comment.id), comment) &&
      !comments.some((c) => c.id === comment.id)
    )
      comments = [...comments, structuredClone(comment)];
  merged.comments = comments;
  return { merged: merged as Manuscript, contested };
}

export const WriterTemplateBriefSchema = z
  .object({
    id: WriterTemplateIdSchema,
    label: z.string(),
    /** The cell types the template supports (an existing cell of another type is kept and flagged). */
    types: z.array(z.string()),
  })
  .strict();

const WriterEditorPageSchema = z
  .object({
    manuscriptId: ManuscriptIdSchema,
    phase: z.enum(["loading", "ready", "missing"]),
    /** The manuscript as the server last confirmed it: complete (every cell and comment), never the draft. */
    saved: ManuscriptSchema.nullable(),
    /**
     * Only in a later observation (service-written, never accepted from a view): the saved manuscript was left out
     * because the task's context already holds this revision.
     */
    savedOmitted: z.object({ rev: Rev, note: z.string() }).strict().optional(),
    saveState: z.enum(["saved", "saving", "error"]),
    /** What the user has typed and not saved. Present only when it differs from `saved`; never on disk. */
    draft: WriterDraftSchema.nullable(),
    template: z
      .object({ id: z.string(), label: z.string(), found: z.boolean(), types: z.array(z.string()) })
      .strict()
      .nullable(),
    /** Cells whose type the bound template does not list (kept losslessly). */
    unsupportedCellIds: z.array(CellIdSchema),
    activeCellId: z.string().nullable(),
    editingCellId: z.string().nullable(),
    /** The text caret of the editing cell, a position hint (UTF-16 offsets into that cell field). */
    caret: z
      .object({ cellId: z.string(), field: z.string(), start: Count, end: Count })
      .strict()
      .nullable(),
    modal: z.enum(["info", "preamble"]).nullable(),
    preview: z
      .object({
        status: z.enum(["never", "ok", "stale", "unknown"]),
        failed: z.boolean(),
        warnings: Count,
        rendering: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const WriterPageSchema = z
  .object({
    mode: z.enum(["list", "editor"]),
    list: z
      .object({
        phase: z.enum(["loading", "ready", "error"]),
        manuscripts: z.array(ManuscriptSummarySchema),
        templates: z.array(WriterTemplateBriefSchema),
      })
      .strict()
      .nullable(),
    editor: WriterEditorPageSchema.nullable(),
  })
  .strict()
  .superRefine((page, ctx) => {
    if (
      (page.mode === "list") !== (page.list !== null) ||
      (page.mode === "editor") !== (page.editor !== null)
    )
      ctx.addIssue({ code: "custom", message: "page must hold exactly its own mode" });
  });
export type WriterPage = z.infer<typeof WriterPageSchema>;

/** What a message records of the Writer it carried (identity and sizes; the content itself is in the history). */
export const WriterContextSummarySchema = z
  .object({
    mode: z.enum(["list", "editor"]),
    manuscriptId: z.string().nullable(),
    title: z.string().nullable(),
    phase: z.enum(["loading", "ready", "missing", "error"]),
    rev: Rev.nullable(),
    cells: Count,
    comments: Count,
    manuscripts: Count,
    draft: z.boolean(),
    saveState: z.enum(["saved", "saving", "error"]).nullable(),
    unsupportedCells: Count,
  })
  .strict();
export type WriterContextSummary = z.infer<typeof WriterContextSummarySchema>;

export function summarizeWriterPage(page: WriterPage): WriterContextSummary {
  const editor = page.editor;
  return {
    mode: page.mode,
    manuscriptId: editor?.manuscriptId ?? null,
    title: editor?.saved?.title ?? null,
    phase: editor
      ? editor.phase
      : page.list?.phase === "error"
        ? "error"
        : (page.list?.phase ?? "loading"),
    rev: editor?.saved?.rev ?? null,
    cells: editor?.saved?.cells.length ?? 0,
    comments: editor?.saved?.comments.length ?? 0,
    manuscripts: page.list?.manuscripts.length ?? 0,
    draft: !!editor?.draft,
    saveState: editor?.saveState ?? null,
    unsupportedCells: editor?.unsupportedCellIds.length ?? 0,
  };
}

/** Held readings are keyed by manuscript and revision so a later observation can leave a held manuscript out. */
export function writerKey(manuscriptId: string, rev: number): string {
  return `writer:${manuscriptId}:${rev}`;
}
/**
 * A page as a later observation shows it to the model. A manuscript the task's context already holds (same id and
 * revision) is left out with a note to call `writer.read`: repeating a whole manuscript at every autosave would fill
 * the window. The draft is small and always stays.
 */
export function observationWriterPage<T extends { writer?: WriterPage | null }>(
  page: T,
  held: ReadonlySet<string> = new Set()
): T {
  const editor = page.writer?.editor;
  if (!page.writer || !editor?.saved) return page;
  const { saved, ...rest } = editor;
  const known = held.has(writerKey(saved.id, saved.rev));
  return {
    ...page,
    writer: {
      ...page.writer,
      editor: {
        ...rest,
        saved: null,
        savedOmitted: {
          rev: saved.rev,
          note: known
            ? "the full manuscript is in the task's context at this revision; call writer.read for the current one"
            : "this manuscript revision is not in the task's context (another manuscript or a newer revision); call writer.read for it",
        },
      },
    },
  } as unknown as T;
}

// ---- Tool operations --------------------------------------------------------------------------------- //

const Id = ManuscriptIdSchema;
const Title = z.string().trim().min(1).max(500);

/** Without `manuscriptId` the list (summaries and the template catalog), with it the whole saved manuscript. */
export const WriterReadOperationSchema = z
  .object({ action: z.literal("read"), manuscriptId: Id.optional() })
  .strict();
export type WriterReadOperation = z.infer<typeof WriterReadOperationSchema>;

export const WriterWriteOperationSchema = z.discriminatedUnion("action", [
  /** The New dialog: a known template and an optional name (blank means the default name). */
  z
    .object({
      action: z.literal("create_manuscript"),
      template: WriterTemplateIdSchema,
      title: Title.optional(),
    })
    .strict(),
  /**
   * The editor's Info modal (title, authors, affiliations, extension fields), Preamble modal (user preamble) and
   * template select. Only the fields given change; everything else, unknown keys included, stays.
   */
  z
    .object({
      action: z.literal("update_manuscript"),
      manuscriptId: Id,
      expectedRev: Rev,
      title: Title.optional(),
      authors: z.array(AuthorSchema).max(200).optional(),
      affiliations: z.array(z.string().max(2000)).max(200).optional(),
      userPreamble: z.string().max(1_000_000).optional(),
      /** Set these extension fields; the others keep their values. */
      infoValues: z.record(z.string().min(1).max(100), z.string().max(100_000)).optional(),
      template: WriterTemplateIdSchema.optional(),
    })
    .strict()
    .refine(
      (op) =>
        op.title !== undefined ||
        op.authors !== undefined ||
        op.affiliations !== undefined ||
        op.userPreamble !== undefined ||
        op.infoValues !== undefined ||
        op.template !== undefined,
      { message: "nothing to change" }
    ),
]);
export type WriterWriteOperation = z.infer<typeof WriterWriteOperationSchema>;

/** A delete is requested, never executed, by the model: the real UI confirms it (deliberately not a write op). */
export const WriterDeleteOperationSchema = z
  .object({ action: z.literal("delete_manuscript"), manuscriptId: Id, expectedRev: Rev })
  .strict();
export type WriterDeleteOperation = z.infer<typeof WriterDeleteOperationSchema>;

/** View operations run in the bound browser's Writer page, through its own controls. */
export const WriterViewActionSchema = z.discriminatedUnion("action", [
  /** A row of the manuscript list (or the editor of another manuscript, through its back button first). */
  z.object({ action: z.literal("open_manuscript"), manuscriptId: Id }).strict(),
  /** The editor's back button (saves first); a no-op when the list is showing. */
  z.object({ action: z.literal("close_manuscript") }).strict(),
]);
export type WriterViewAction = z.infer<typeof WriterViewActionSchema>;

export const WRITER_VIEW_ACTIONS = ["open_manuscript", "close_manuscript"] as const;
export const WRITER_WRITE_ACTIONS = ["create_manuscript", "update_manuscript"] as const;
export const WRITER_OPERATION_ACTIONS = [
  "read",
  ...WRITER_WRITE_ACTIONS,
  "delete_manuscript",
  ...WRITER_VIEW_ACTIONS,
] as const;

/** What a delete card shows about the manuscript, and what binds the user's click to it. */
export const WriterDeleteImpactSchema = z
  .object({
    cells: Count,
    comments: Count,
    /** Uploaded figure files that are deleted with the manuscript. */
    assets: Count,
  })
  .strict();
export type WriterDeleteImpact = z.infer<typeof WriterDeleteImpactSchema>;
