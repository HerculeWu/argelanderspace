/**
 * The Copilot `shelf` tool (shelf ticket 07; contracts「文献仓」, docs/library.md「文献仓」): what the model may ask.
 * Reading lists and searches the Shelf (bibliography, Doc kinds, annotation counts; never an annotation body, a note
 * or an argument graph). The four writes — add, replace (an add of a paper the Shelf already has), delete and take —
 * only REQUEST: each one waits for the user's confirmation card, and no schema here has a confirm, approve, impact or
 * plan digest field (every schema is strict, so such a key is refused before the tool runs).
 */

import { z } from "zod";
import { SHELF_DOC_ID_RE, SHELF_ENTRY_ID_RE } from "./shelf.js";
import { SHELF_ADD_MAX_ANNOTATIONS, SHELF_ADD_MAX_DOCS } from "./shelf-write.js";

export const SHELF_OPERATION_ACTIONS = ["list", "add", "delete", "take"] as const;
export type ShelfOperationAction = (typeof SHELF_OPERATION_ACTIONS)[number];

const EntryId = z.string().regex(SHELF_ENTRY_ID_RE);
const DocId = z.string().regex(SHELF_DOC_ID_RE);
const Rev = z.number().int().min(1);
const AnnotationIds = z.array(z.string().min(1).max(200)).max(SHELF_ADD_MAX_ANNOTATIONS);

/** List the Shelf, or search it (`query`: title, authors, year, DOI, arXiv or OpenAlex id, entry id). */
export const ShelfListOperationSchema = z.strictObject({
  action: z.literal("list"),
  query: z.string().max(500).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ShelfListOperation = z.infer<typeof ShelfListOperationSchema>;

/**
 * Add a Work of this project to the Shelf (or replace the entries of the same paper): the Add dialog's choices. `docIds`
 * defaults to every Doc of the Work; `annotations` names, per chosen Doc, the annotation ids to carry (none by
 * default); the argument graph and the note are not carried unless asked (spec Q3, Q14).
 */
export const ShelfAddOperationSchema = z.strictObject({
  action: z.literal("add"),
  workId: z.string().min(1).max(500),
  docIds: z.array(DocId).max(SHELF_ADD_MAX_DOCS).optional(),
  annotations: z.record(DocId, AnnotationIds).optional(),
  argumentGraph: z.boolean().optional(),
  note: z.boolean().optional(),
});
export type ShelfAddOperation = z.infer<typeof ShelfAddOperationSchema>;

/** Delete one Shelf entry at the rev the list showed (only the Shelf's copy; no project is touched). */
export const ShelfDeleteOperationSchema = z.strictObject({
  action: z.literal("delete"),
  entryId: EntryId,
  rev: Rev,
});
export type ShelfDeleteOperation = z.infer<typeof ShelfDeleteOperationSchema>;

/**
 * Take an entry into this project: the take dialog's choices. Every annotation is taken unless `excludeAnnotations`
 * names it (per Doc, the ids or `"all"`); the argument graph and the note are taken unless set false (spec Q6, Q14).
 */
export const ShelfTakeOperationSchema = z.strictObject({
  action: z.literal("take"),
  entryId: EntryId,
  rev: Rev,
  excludeAnnotations: z
    .record(z.string().min(1).max(128), z.union([z.literal("all"), AnnotationIds]))
    .optional(),
  argumentGraph: z.boolean().optional(),
  note: z.boolean().optional(),
});
export type ShelfTakeOperation = z.infer<typeof ShelfTakeOperationSchema>;
