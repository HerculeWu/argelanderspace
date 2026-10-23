/**
 * The Shelf (文献仓) read and take interface of the server (shelf ticket 04; contracts「文献仓」; docs/library.md
 * 「文献仓」「取入与查询」): what `GET /api/shelf`, `GET /api/shelf/entries/:id`, `GET /api/shelf/entries/:id/annotations`,
 * `GET /api/shelf/lookup`, `POST /api/shelf/entries/:id/take/preview` and `POST /api/shelf/entries/:id/take` answer.
 * The entry format itself is `shelf.ts`.
 *
 * Only the annotation list carries annotation bodies (for the page), and only the entry summary carries the opening of
 * the note (`notePreview`, for the page; shelf follow-up 01); no answer carries the whole note or the graph's content.
 */

import { z } from "zod";
import {
  SHELF_DOC_KINDS,
  type ShelfBibliography,
  type ShelfDocKind,
  type ShelfIdentity,
} from "./shelf.js";

/** One Doc of an entry, as a list or a summary shows it. */
export interface ShelfDocSummary {
  docId: string;
  kind: ShelfDocKind;
  /** Bytes of the Doc's files (the annotation copy not included). */
  bytes: number;
  /** Annotations carried with this Doc; null when none were carried. */
  annotations: number | null;
}

/** An entry of this build's format, without its files. */
export interface ShelfEntrySummary {
  entryId: string;
  rev: number;
  /** Bytes on disk: the manifest and every file it names. */
  bytes: number;
  addedAt: string;
  /** Where it was added from (the project folder on this machine and the Work id there). */
  source: { project: string; workId: string };
  identity: ShelfIdentity;
  title: string;
  authors: string[];
  year: number | null;
  docs: ShelfDocSummary[];
  /** All annotations carried, over every Doc. */
  annotations: number;
  argumentGraph: boolean;
  /**
   * How many arguments the carried graph has, counted when read from the entry's own `argument-graph.json` (shelf
   * follow-up 01). Null when no graph is carried, or when this build cannot count it (a later version, not a graph,
   * a file that no longer matches the manifest or cannot be read): unknown, never an error. A count, not content.
   */
  argumentCount: number | null;
  note: boolean;
}

/** How many characters (code points) of the note `GET /api/shelf/entries/:id` gives (`notePreview`). */
export const SHELF_NOTE_PREVIEW_CHARS = 200;

/**
 * The opening of an entry's note for the page (shelf follow-up 01): its first {@link SHELF_NOTE_PREVIEW_CHARS}
 * characters, `truncated` when the note is longer. Only the entry summary has it; the list and the Copilot never do.
 */
export interface ShelfNotePreview {
  text: string;
  truncated: boolean;
}

/**
 * One row of `GET /api/shelf`. `incompatible`: written by a newer workbench; it is shown, never taken
 * (`needsUpdate`, the page says 「需要更新工作台」). `damaged`: its manifest says it is broken (`problem` is a
 * category). `unreadable`: a system error kept it from being looked at — not damage, the entry may be whole.
 */
export type ShelfListRow =
  | ({ status: "ok" } & ShelfEntrySummary)
  | {
      status: "incompatible";
      entryId: string;
      rev: number;
      bytes: number;
      /** The `format` the entry declares, as found. */
      format: unknown;
      title: string | null;
      needsUpdate: true;
    }
  | { status: "damaged"; entryId: string; rev: number; bytes: number; problem: string }
  | { status: "unreadable"; entryId: string; rev: number; bytes: 0; code: string };

export interface ShelfListResponse {
  entries: ShelfListRow[];
}

/**
 * `GET /api/shelf/entries/:id`: the entry as its manifest says (the Doc files are not hashed here; the take and its
 * preview check every file). `ok` adds the whole bibliography snapshot and the note's opening to the list row:
 * `notePreview` is null when no note is carried or the note file no longer matches the manifest or cannot be read.
 */
export type ShelfEntryResponse =
  | ({
      status: "ok";
      bibliography: ShelfBibliography;
      notePreview: ShelfNotePreview | null;
    } & ShelfEntrySummary)
  | { status: "incompatible"; entryId: string; rev: number; needsUpdate: true }
  | { status: "damaged"; entryId: string; rev: number; problem: string }
  | { status: "unreadable"; entryId: string; rev: number; code: string };

/** `GET /api/shelf/lookup?doi=&arxiv=&openalex=`: entries that are the same paper (only these three identifiers). */
export interface ShelfLookupResponse {
  entries: {
    entryId: string;
    rev: number;
    title: string;
    matchedOn: ("doi" | "arxiv" | "openalex")[];
  }[];
}

/**
 * `GET /api/shelf/entries/:id/annotations`: every annotation an entry carries, Doc by Doc, for the page that lets the
 * person leave some out (spec Q6). This is the only Shelf answer with annotation bodies; it is for the page, not for
 * the Copilot. `location` is where the annotation sits: for LaTeX / text Docs the section path read from the
 * entry's own reading text (null when it cannot be read or the block is not in it) plus the printed number of a
 * structure target; for PDF Docs the zero-based page (the first page of a text target; null for a whole-document
 * comment).
 */
export interface ShelfAnnotationsResponse {
  entryId: string;
  rev: number;
  docs: {
    docId: string;
    kind: ShelfDocKind;
    annotations: {
      id: string;
      /** LaTeX / text: `document` | `text` | the structure kind (`section`, `paragraph`, `figure`, …). PDF: its kind. */
      kind: string;
      location: {
        sectionPath: string | null;
        number: string | null;
        pageIndex: number | null;
      };
      /** What was annotated, as saved with it (a quote or the snapshot text), at most 200 characters; may be "". */
      snippet: string;
      body: string;
      createdAt: string;
      updatedAt: string;
    }[];
  }[];
}

const AnnotationIdList = z.array(z.string().min(1).max(200)).max(10_000);

/**
 * `POST /api/shelf/entries/:id/take` and `POST /api/shelf/entries/:id/take/preview` (the same body). `rev` is the
 * rev the person saw: a replaced entry is refused (409 `changed`). `excludeAnnotations` names, per Doc, the
 * annotations NOT to take (`"all"` for every one); everything else is taken (spec Q6: by default all).
 * `argumentGraph` and `note` default to true; the note is only ever written into a Work this take creates.
 * `planDigest` (take only, optional): the `planDigest` of the preview the person confirmed; when the plan worked out
 * again under the lock differs, nothing is written (409 `plan_changed` with the new plan and digest).
 */
export const ShelfTakeRequestSchema = z.strictObject({
  rev: z.number().int().min(1),
  excludeAnnotations: z
    .record(z.string().min(1).max(128), z.union([z.literal("all"), AnnotationIdList]))
    .optional(),
  argumentGraph: z.boolean().optional(),
  note: z.boolean().optional(),
  planDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ShelfTakeRequest = z.infer<typeof ShelfTakeRequestSchema>;

/**
 * Why a Doc of the entry is not taken; the project's own Doc and annotations stay byte for byte as they were.
 * - `exists`: the project has a Doc directory of that id;
 * - `linked`: a Work of the project lists that Doc id (its directory is gone);
 * - `annotations_present`: the project has annotations under that Doc id (left behind by a removed Doc);
 * - `seed_conflict`: a LaTeX Doc the next library build would put in another Work, a new one, or fold another Work
 *   with, even with the target Work's identity written into its `source`/`meta` (`wouldJoin`: the other Work's id, or
 *   null for a new Work). Reported instead of letting the build fold Works.
 */
export type ShelfTakeSkipReason = "exists" | "linked" | "annotations_present" | "seed_conflict";

/**
 * What a take does (the preview's plan) and, after a take, what it did — the same shape: the take works the plan out
 * again under the lock and carries it out.
 */
export interface ShelfTakeResult {
  work: {
    id: string;
    /** The Work's title after the take (a merge fills a blank title from the entry). */
    title: string;
    /** true: a new Work; false: the entry is merged into this Work (the same paper by DOI, arXiv or OpenAlex). */
    created: boolean;
    citeKey: string | null;
    /** The bibliography fields written into the Work: every field of a new Work, the blank ones filled on a merge. */
    filled: string[];
  };
  /** The Work's main Doc before and after; `changed` only when a Work without Docs gets the entry's first one. */
  mainDoc: { before: string | null; after: string | null; changed: boolean };
  docs: {
    /**
     * `stamped`: a LaTeX Doc whose reading text gets the Work's DOI / arXiv id (or title) in `source`/`meta`, so the
     * next library build keeps it with this Work (contracts「文献仓」局部修订二); its text and annotations do not change.
     */
    taken: { docId: string; kind: ShelfDocKind; annotations: number; stamped: boolean }[];
    skipped: {
      docId: string;
      kind: ShelfDocKind;
      reason: ShelfTakeSkipReason;
      wouldJoin?: string | null;
    }[];
  };
  /**
   * `written`; `kept_local` (the Work already has a non-empty graph, kept); `not_carried` (the entry has none);
   * `not_chosen`.
   */
  argumentGraph: "written" | "kept_local" | "not_carried" | "not_chosen";
  /**
   * `written` (into the new Work); `kept_local` (merged into a Work whose note is not empty: it is not written);
   * `existing_work` (merged into a Work: the project's note is left alone); `not_carried`; `not_chosen`.
   */
  note: "written" | "kept_local" | "existing_work" | "not_carried" | "not_chosen";
}

/**
 * {@link ShelfTakeResult} as a schema, for the Copilot's take confirmation card (shelf ticket 07), which carries the plan
 * it shows. The interface stays the type the server answers with; the two are checked to be the same below.
 */
const SkipReasonSchema = z.enum(["exists", "linked", "annotations_present", "seed_conflict"]);
const DocKindSchema = z.enum(SHELF_DOC_KINDS);
export const ShelfTakeResultSchema = z.strictObject({
  work: z.strictObject({
    id: z.string(),
    title: z.string(),
    created: z.boolean(),
    citeKey: z.string().nullable(),
    filled: z.array(z.string()),
  }),
  mainDoc: z.strictObject({
    before: z.string().nullable(),
    after: z.string().nullable(),
    changed: z.boolean(),
  }),
  docs: z.strictObject({
    taken: z.array(
      z.strictObject({
        docId: z.string(),
        kind: DocKindSchema,
        annotations: z.number().int().min(0),
        stamped: z.boolean(),
      })
    ),
    skipped: z.array(
      z.strictObject({
        docId: z.string(),
        kind: DocKindSchema,
        reason: SkipReasonSchema,
        wouldJoin: z.string().nullable().optional(),
      })
    ),
  }),
  argumentGraph: z.enum(["written", "kept_local", "not_carried", "not_chosen"]),
  note: z.enum(["written", "kept_local", "existing_work", "not_carried", "not_chosen"]),
});
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Compile-time check: the schema is exactly the interface (a field added to one and not the other fails here).
const takeResultSchemaIsTheInterface: Same<
  z.infer<typeof ShelfTakeResultSchema>,
  ShelfTakeResult
> = true;
void takeResultSchemaIsTheInterface;

/** `POST …/take/preview`: the plan, written nowhere, and its digest to send back with the take. */
export interface ShelfTakePreview {
  plan: ShelfTakeResult;
  planDigest: string;
}

/**
 * The refusals of the take and the preview (`{detail, code, …}`), with their HTTP status:
 * 400 `invalid_request` · 404 `not_found` · 409 `changed` (`currentRev`), `incompatible` (`needsUpdate`), `busy`
 * (`docId`: a Doc of that id is being written or deleted), `id_taken` (`workId`: the new Work's id is held by a
 * different Work), `multiple_works` (`workIds`: several Works of the project are this paper; merge them first),
 * `plan_changed` (take only: `plan`, `planDigest` as now worked out) · 422 `damaged` (`problem`), `entry_invalid`
 * (`docId`, `part`, `problem`: the entry's content does not hold together; excluding that part may let the take go
 * through) · 500 `shelf_unreadable` (`errno`), `library_unreadable`, `argument_graph_unreadable`, `write_failed`
 * (`cleanedUp`: false when something this take added could not be removed again).
 */
export type ShelfTakeRefusalCode =
  | "invalid_request"
  | "not_found"
  | "changed"
  | "incompatible"
  | "busy"
  | "id_taken"
  | "multiple_works"
  | "plan_changed"
  | "damaged"
  | "entry_invalid"
  | "shelf_unreadable"
  | "library_unreadable"
  | "argument_graph_unreadable"
  | "write_failed";
