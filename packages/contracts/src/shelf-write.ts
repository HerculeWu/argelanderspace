/**
 * The Shelf (文献仓) write interface of the server (shelf ticket 03; contracts「文献仓」; docs/library.md「文献仓」):
 * adding a Work to the Shelf, replacing an entry of the same paper after the person confirmed it, and deleting an entry.
 * The entry format itself is `shelf.ts`.
 *
 *   POST   /api/shelf/entries                    add (or, with `confirm`, replace)  — ShelfAddRequest
 *   POST   /api/shelf/entries/preview            what an add would do now, read only — ShelfAddPreviewRequest
 *   DELETE /api/shelf/entries/:entryId?rev=<n>    delete one entry at the rev the page showed
 *
 * Every refusal is `{ detail, code, … }`: `detail` is a sentence for people, `code` (one of
 * {@link SHELF_WRITE_REFUSALS}) is what the page and the Copilot compare. A refusal names the object it is about (a Doc
 * id, an entry id) and a reason category, never content.
 */

import { z } from "zod";
import { SHELF_DOC_ID_RE, SHELF_DOC_KINDS, SHELF_ENTRY_ID_RE } from "./shelf.js";

const EntryId = z.string().regex(SHELF_ENTRY_ID_RE);
const Rev = z.number().int().min(1);

export const ShelfEntryRefSchema = z.strictObject({ entryId: EntryId, rev: Rev });
export type ShelfEntryRefDto = z.infer<typeof ShelfEntryRefSchema>;

/**
 * One entry a replacement would remove, as the confirmation card shows it. All of it is a function of the entry at
 * `rev` (an entry never changes in place), so a confirmation that echoes it back is checked by the rev under the
 * Shelf's lock.
 */
export const ShelfReplacedEntrySchema = z.strictObject({
  entryId: EntryId,
  rev: Rev,
  title: z.string(),
  /** When that content was added (ISO-8601). */
  addedAt: z.string(),
  /** The project folder it was added from (this machine's path, as the entry records it). */
  sourceProject: z.string(),
  /** Its Docs, in the entry's order, with their size in bytes (the annotation copy not included). */
  docs: z.array(
    z.strictObject({
      docId: z.string(),
      kind: z.enum(SHELF_DOC_KINDS),
      bytes: z.number().int().min(0),
    })
  ),
  annotations: z.number().int().min(0),
  argumentGraph: z.boolean(),
  note: z.boolean(),
});
export type ShelfReplacedEntry = z.infer<typeof ShelfReplacedEntrySchema>;

/**
 * What a replacement would remove: every entry that is the same paper (DOI, arXiv or OpenAlex id). There can be more
 * than one, e.g. one added by its DOI and another by its arXiv id before the Work knew both. Order: as the Shelf
 * reported them.
 */
export const ShelfReplaceImpactSchema = z.strictObject({
  entries: z.array(ShelfReplacedEntrySchema).min(1),
});
export type ShelfReplaceImpact = z.infer<typeof ShelfReplaceImpactSchema>;

/** At most this many Docs and annotation ids in one request. */
export const SHELF_ADD_MAX_DOCS = 200;
export const SHELF_ADD_MAX_ANNOTATIONS = 20_000;

export const ShelfAddRequestSchema = z.strictObject({
  /** The Work in the current project. */
  workId: z.string().min(1),
  /** The chosen Docs of that Work (any order; the entry keeps the Work's order) and, per Doc, the chosen annotations. */
  docs: z
    .array(
      z.strictObject({
        docId: z.string().regex(SHELF_DOC_ID_RE),
        annotationIds: z.array(z.string().min(1)).max(SHELF_ADD_MAX_ANNOTATIONS),
      })
    )
    .max(SHELF_ADD_MAX_DOCS),
  /** Carry the Work's argument graph (when it has a non-empty one). */
  argumentGraph: z.boolean(),
  /** Carry the Work's note (when it has one). */
  note: z.boolean(),
  /**
   * Only after the person confirmed a replacement: the `impact` of the `confirmation_required` answer, unchanged. The
   * server compares it with the Shelf as it is now and, under the Shelf's lock, the revs; anything different is
   * `confirmation_changed` and nothing is written.
   */
  confirm: ShelfReplaceImpactSchema.optional(),
});
export type ShelfAddRequest = z.infer<typeof ShelfAddRequestSchema>;

/**
 * What the annotations access path archived during an add (its ensure found annotations of older content): one row
 * per Doc. `count` is how many annotations went into the archive, null when it cannot be told (the archive was made
 * but the new empty file was not, `annotations_new_current_failed`). Every answer of an add that got as far as reading
 * annotations carries it — the success and every refusal after it — so an add that stopped says what it did change
 * (contracts「文献仓」, revision of 2026-10-23).
 */
export const ShelfArchivedSchema = z.array(
  z.strictObject({ docId: z.string(), count: z.number().int().min(0).nullable() })
);
export type ShelfArchived = z.infer<typeof ShelfArchivedSchema>;

/** 200 of `POST /api/shelf/entries`. */
export const ShelfAddResponseSchema = z.strictObject({
  entry: ShelfEntryRefSchema,
  /** The entries this replaced (empty for a new entry); the new entry keeps the first one's id. */
  replaced: z.array(ShelfEntryRefSchema),
  /** What went in. */
  carried: z.strictObject({
    docs: z.array(
      z.strictObject({
        docId: z.string(),
        kind: z.enum(SHELF_DOC_KINDS),
        annotations: z.number().int().min(0),
      })
    ),
    argumentGraph: z.boolean(),
    note: z.boolean(),
  }),
  /**
   * Chosen annotations that were not current any more and so did not go in (deleted meanwhile, or archived because
   * the Doc's content changed — the access path archives them as it always does). Only Docs with such ids are listed.
   */
  notCarried: z.array(
    z.strictObject({ docId: z.string(), annotationIds: z.array(z.string()).min(1) })
  ),
  /** What the access path archived on the way (see {@link ShelfArchivedSchema}); usually empty. */
  archived: ShelfArchivedSchema,
});
export type ShelfAddResponse = z.infer<typeof ShelfAddResponseSchema>;

/** `POST /api/shelf/entries/preview`: the same request without `confirm`. */
export const ShelfAddPreviewRequestSchema = ShelfAddRequestSchema.omit({ confirm: true });
export type ShelfAddPreviewRequest = z.infer<typeof ShelfAddPreviewRequestSchema>;

/**
 * 200 of `POST /api/shelf/entries/preview`: what an add made now would do, read only (no ensure, no archive, nothing
 * written anywhere). `impact` is what it would ask to replace (null: nothing, it would be a new entry). `notCarried`
 * is an estimate: chosen annotations that are not in the current file, or whose file is of older content (the access
 * path would archive it at the add). `wouldArchive` (shelf ticket 07) names those Docs: chosen annotations were asked
 * for and the current file is of older content, so the add's access path will move that batch (`count` annotations)
 * to the project's archive, as any access would. A Doc with no annotations file is not in it (nothing to archive),
 * nor one with no annotation chosen (the add does not ensure it). Empty: the add changes nothing in the project.
 */
export const ShelfAddPreviewResponseSchema = z.strictObject({
  impact: ShelfReplaceImpactSchema.nullable(),
  carried: ShelfAddResponseSchema.shape.carried,
  notCarried: ShelfAddResponseSchema.shape.notCarried,
  wouldArchive: z.array(z.strictObject({ docId: z.string(), count: z.number().int().min(0) })),
});
export type ShelfAddPreviewResponse = z.infer<typeof ShelfAddPreviewResponseSchema>;

/**
 * `GET /api/shelf/add-candidates/:workId` (shelf ticket 05 fix round): what the add dialog lists, READ ONLY — each Doc
 * of the Work in its order with its kind, the bytes the Shelf would carry (null when they could not be counted), and
 * its current annotations through the access path's `peek`: no ensure, no archive, no notification. `stale`: the saved
 * annotations belong to older content (an add neither carries nor archives them: a Doc with no annotations chosen never goes through the access path; the next ordinary access archives them); `pdf`:
 * the page reads the PDF sidecar itself (the PDF snapshot, which never archives); `none`: nothing to list (a text Doc
 * that was never generated); `busy`: the Doc is being written or deleted; `unreadable`: a system error (`code`), never
 * a mismatch. Refusals: 404 `work_not_found`; 500 `library_unreadable`.
 */
export interface ShelfAddCandidateDoc {
  docId: string;
  kind: (typeof SHELF_DOC_KINDS)[number];
  bytes: number | null;
  annotations:
    | { state: "current"; list: unknown[] }
    | { state: "stale" }
    | { state: "pdf" }
    | { state: "none" }
    | { state: "busy" }
    | { state: "unreadable"; code: string };
}
export interface ShelfAddCandidates {
  workId: string;
  docs: ShelfAddCandidateDoc[];
}

/** 200 of `DELETE /api/shelf/entries/:entryId`. */
export const ShelfDeleteResponseSchema = z.strictObject({ deleted: ShelfEntryRefSchema });
export type ShelfDeleteResponse = z.infer<typeof ShelfDeleteResponseSchema>;

/**
 * Why something of an add could not be read or did not verify (with the object: a Doc id, or the Work's argument
 * graph / note / the library). A category, never content.
 */
export const SHELF_ITEM_PROBLEMS = [
  /** The Doc's folder is not there. */
  "missing",
  /** A file the Doc needs is not there. */
  "incomplete",
  /** A file or folder of the Doc is a link or something else than a plain file / folder. */
  "not_a_regular_file",
  /** A file could not be read (permissions, I/O). */
  "unreadable",
  /** The stored reading text, metadata or source is damaged or of a later version. */
  "invalid",
  /** An image or other asset the Doc declares is missing or does not match its recorded hash. */
  "asset_mismatch",
  /** The reading text declares an image at a place the Shelf does not carry (outside `assets/`). */
  "asset_outside_carried",
  /** The PDF original does not match its recorded size and SHA-256. */
  "content_changed",
  /** The PDF Doc is not listed by exactly one Work. */
  "ownership",
  /** The Doc's annotations file is damaged or not bound to this Doc. */
  "annotations_invalid",
  /**
   * The access path found the annotations of older content and could not move them to the archive: they were left
   * exactly as they were.
   */
  "annotations_archive_failed",
  /**
   * The access path archived the annotations of older content, but the new empty annotations file could not be
   * created (the next access creates it). The project changed by that archive.
   */
  "annotations_new_current_failed",
] as const;
export type ShelfItemProblem = (typeof SHELF_ITEM_PROBLEMS)[number];

export const ShelfItemSchema = z.discriminatedUnion("kind", [
  /** `path`: the file concerned, relative to the Doc's folder (a path, not content), when the problem is one file. */
  z.strictObject({ kind: z.literal("doc"), docId: z.string(), path: z.string().optional() }),
  z.strictObject({
    kind: z.literal("annotations"),
    docId: z.string(),
    path: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("argument_graph") }),
  z.strictObject({ kind: z.literal("library") }),
]);
export type ShelfItem = z.infer<typeof ShelfItemSchema>;

/**
 * The `code` of a refusal:
 *
 * - 400 `invalid_request` — the body is not a {@link ShelfAddRequest} (or names a Doc twice; a bad `rev` of a delete).
 * - 404 `work_not_found` — no such Work in the project. `not_found` — (delete) no such entry.
 * - 409 `doc_not_in_work` `{docId}` — the Work does not list that Doc (any more).
 * - 409 `doc_busy` `{docId}` — the Doc is being written or deleted (DocMutationRegistry); nothing was read or written.
 * - 409 `confirmation_required` `{impact}` — the Shelf has the same paper: confirm to replace (nothing was written).
 * - 409 `confirmation_changed` `{impact?}` — what was confirmed is not what the Shelf holds now; `impact` is the fresh
 *   one when there still is something to replace. Nothing was written.
 * - 409 `rev_mismatch` `{currentRev}` — (delete) the entry was replaced since the page showed it.
 * - 409 `carried_changed` — in-process only (the Copilot card's add, shelf ticket 07; never reachable over HTTP): what
 *   the add read would put in (or what its access path archived) is not the preview the person confirmed; nothing was
 *   written to the Shelf (an archive on the way is reported in `archived`, as for every refusal after reading).
 * - 500 `item_unreadable` `{item, problem}` — a part of the add could not be read or did not verify; the Shelf was
 *   not written, and the project is as it was except for an archive the annotations access path made on the way, as
 *   any access would (`annotations_new_current_failed` says so; docs/library.md「文献仓」).
 * - 500 `shelf_unreadable` `{errno}` — an entry of the Shelf could not be read (it might be the same paper).
 * - 500 `shelf_write_failed` — writing the entry failed; nothing of it is in the Shelf.
 * - 500 `lock_lost` `{written, removed}` — the Shelf's lock was taken over by another process during the write;
 *   `written` is the new entry when it is in place, `removed` the targets that are gone (the others may still be
 *   listed).
 *
 * A refusal of an add that got as far as reading annotations (step ⑤ of docs/library.md「文献仓」, or later: the
 * Shelf's own failures) also carries `archived` ({@link ShelfArchivedSchema}), and its `detail` says so when it is not
 * empty.
 * - 503 `shelf_busy` — another workbench is writing the Shelf; try again.
 */
export const SHELF_WRITE_REFUSALS = [
  "invalid_request",
  "work_not_found",
  "not_found",
  "doc_not_in_work",
  "doc_busy",
  "confirmation_required",
  "confirmation_changed",
  "carried_changed",
  "rev_mismatch",
  "item_unreadable",
  "shelf_unreadable",
  "shelf_write_failed",
  "lock_lost",
  "shelf_busy",
] as const;
export type ShelfWriteRefusal = (typeof SHELF_WRITE_REFUSALS)[number];

/**
 * Fired after this server changed the Shelf (an entry added, replaced or deleted). The Shelf is global data: another
 * workbench process's writes are not announced here.
 */
export const WsShelfChangedSchema = z.object({
  type: z.literal("shelf.changed"),
  cause: z.enum(["add", "replace", "delete"]),
  entry_id: z.string(),
  /** The entry's rev after the change (for a delete, the rev that was deleted). */
  rev: z.number().int(),
  /**
   * The entry revs that are gone with this change: for a replacement every target as it was confirmed (the first one
   * kept its id at the new rev, the others are removed), for a delete the deleted one, for an add none.
   */
  removed: z.array(z.strictObject({ entry_id: z.string(), rev: z.number().int() })),
  /** ISO-8601 timestamp. */
  at: z.string(),
});
export type WsShelfChanged = z.infer<typeof WsShelfChangedSchema>;
