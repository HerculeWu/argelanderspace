/**
 * The Shelf (文献仓) entry format (shelf ticket 01; ADR 0013; contracts「文献仓」). The store itself is infra
 * `shelf/store.ts`; the layout and the reasons for it are in docs/architecture.md「数据与配置」.
 *
 * One entry is one directory `<global data>/shelf/entries/<entry id>.r<rev>/` holding `entry.json` (the manifest
 * below) and the copied files at fixed places:
 *
 *   docs/<doc id>/<path>        one Doc's files, at the same relative paths as under the project's `output/<doc id>/`
 *   annotations/<doc id>.json   the annotation copy of that Doc (bytes as handed in), when one was carried
 *   argument-graph.json         the Work's argument graph file, when carried
 *   note.md                     the Work's note (UTF-8), when carried
 *
 * The envelope stays the same in every later format, so an older build can still list (and delete) an entry a newer
 * one wrote, and builds of different versions can write side by side:
 *
 *   - `shelf/shelf.lock/` is the one cross-process write lock (a proper-lockfile directory); every write — add,
 *     replace, delete, tidying — holds it.
 *   - `shelf/entries/<entry id>.r<rev>/` is an entry: the id is 32 lowercase hex digits, the rev a positive integer.
 *     Other names under `entries/` are not entries. When an id has several directories, the one with the highest rev
 *     is the entry; lower ones are superseded leftovers of a replacement, removed under the lock only when the
 *     highest one is a whole entry of the remover's own format.
 *   - `entry.json` in it has `format`, `entry_id` and `rev` (equal to the directory name) at the top level.
 *   - `shelf/staging/` holds entries being written and `shelf/trash/` entries being removed; neither is ever read,
 *     and a writer holding the lock may clear trash and staging older than an hour.
 *
 * A `format` other than {@link SHELF_FORMAT} is not understood: such an entry is listed as incompatible, never read,
 * never rewritten, and the directories of its id are left alone; only a delete removes it.
 */

import { z } from "zod";

/** The entry format this build reads and writes. */
export const SHELF_FORMAT = 1;

export const SHELF_DOC_KINDS = ["latex", "pdf", "text"] as const;
export type ShelfDocKind = (typeof SHELF_DOC_KINDS)[number];

/** Entry ids are 32 lowercase hex digits, chosen at random when the entry is created and kept through replacements. */
export const SHELF_ENTRY_ID_RE = /^[0-9a-f]{32}$/;
/** A Doc id as the project stores it (the PDF storage's rule): it is a directory name, never a path. */
export const SHELF_DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Work fields that are project state, never part of a Shelf bibliography snapshot (spec Q14, Q15): the Work id and
 * its Doc list (rebuilt on taking), cite key (re-assigned by the target project), tags, label, read, star, the note
 * (carried separately, by choice), and how and when the Work came into its project — `added_at`, `origin`
 * (ingested / manual / graph-node / bib) and `acquisition` (the planner's record of where to read the full text,
 * which names the project's own Doc in `ingested_doc` and is recomputed by the target project's library build).
 * `resolution` (which metadata source answered) is kept: it is provenance of the bibliographic data itself.
 */
export const SHELF_EXCLUDED_WORK_FIELDS = [
  "id",
  "doc_ids",
  "cite_key",
  "tags",
  "label",
  "read",
  "star",
  "note",
  "added_at",
  "origin",
  "acquisition",
] as const;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ByteCount = z.number().int().min(0);

/** A relative POSIX path inside a Doc directory: no empty, `.`/`..` or dot-leading segments, no backslash. */
export function isShelfRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.includes("\\") || path.includes("\0"))
    return false;
  const segments = path.split("/");
  if (segments.length > 16) return false;
  return segments.every((s) => s.length > 0 && s.length <= 255 && !s.startsWith("."));
}

/**
 * Which files of a project Doc directory (`output/<doc id>/`) go into a Shelf entry. This is the one rule both
 * directions use: adding copies exactly these files, the store refuses anything else, and taking writes them back
 * at the same relative paths.
 *
 * - LaTeX: `<doc id>.json` (the stored IR, required) and everything under `assets/`. `src/` and `build/` are left
 *   out: nothing reads them once the IR exists (reading, the annotation fingerprint and the assets use only the IR
 *   and `assets/`), and a re-ingest fetches or unpacks the source again and wipes `src/` first.
 * - PDF: `<doc id>.json` (metadata) and `original.pdf`, both required. The workbench annotation sidecar is carried as
 *   the Doc's annotation copy, not as a Doc file; `reading-position.json` is project state and never carried (Q18).
 * - Text: `text-source.json` (required), `<doc id>.json` (the reading text last generated; absent for a draft never
 *   generated, which is legal) and everything under `assets/`.
 */
export function shelfDocFileAllowed(kind: ShelfDocKind, docId: string, path: string): boolean {
  if (!isShelfRelativePath(path)) return false;
  const inAssets = path.startsWith("assets/") && path.length > "assets/".length;
  switch (kind) {
    case "latex":
      return path === `${docId}.json` || inAssets;
    case "pdf":
      return path === `${docId}.json` || path === "original.pdf";
    case "text":
      return path === "text-source.json" || path === `${docId}.json` || inAssets;
  }
}

/** The files a Doc of this kind must have in an entry. */
export function shelfDocRequiredFiles(kind: ShelfDocKind, docId: string): string[] {
  switch (kind) {
    case "latex":
      return [`${docId}.json`];
    case "pdf":
      return [`${docId}.json`, "original.pdf"];
    case "text":
      return ["text-source.json"];
  }
}

export const ShelfFileRecordSchema = z.object({ bytes: ByteCount, sha256: Sha256 }).strict();
export type ShelfFileRecord = z.infer<typeof ShelfFileRecordSchema>;

export const ShelfDocFileSchema = z
  .object({ path: z.string().refine(isShelfRelativePath), bytes: ByteCount, sha256: Sha256 })
  .strict();

export const ShelfDocSchema = z
  .object({
    doc_id: z.string().regex(SHELF_DOC_ID_RE),
    kind: z.enum(SHELF_DOC_KINDS),
    /** Sum of the Doc's file sizes (the annotation copy not included). */
    bytes: ByteCount,
    /** SHA-256 over the Doc's files: each `path NUL sha256 LF`, in path order (see `shelfDocDigest`). */
    sha256: Sha256,
    files: z.array(ShelfDocFileSchema),
    /** The annotation copy, or null when none was carried; `count` is the number of annotations in it. */
    annotations: z
      .object({ count: z.number().int().min(0), bytes: ByteCount, sha256: Sha256 })
      .strict()
      .nullable(),
  })
  .strict();
export type ShelfDoc = z.infer<typeof ShelfDocSchema>;

export const ShelfIdentitySchema = z
  .object({
    /** Normalized as the Library does (lowercase, no `doi:` / doi.org prefix). */
    doi: z.string().min(1).nullable(),
    /** Without its version (`2401.01234`, not `2401.01234v2`); also taken from an arXiv DataCite DOI. */
    arxiv: z.string().min(1).nullable(),
    /** The short OpenAlex id (`W123…`). */
    openalex: z.string().min(1).nullable(),
  })
  .strict();
export type ShelfIdentity = z.infer<typeof ShelfIdentitySchema>;

/**
 * The bibliography snapshot: the Work's bibliographic fields as they were when it was added, minus
 * {@link SHELF_EXCLUDED_WORK_FIELDS}. Other fields are kept as given.
 */
export const ShelfBibliographySchema = z
  .object({
    title: z.string(),
    authors: z.array(z.string()),
    year: z.number().int().nullable(),
    doi: z.string().nullable().optional(),
    arxiv_id: z.string().nullable().optional(),
    openalex_id: z.string().nullable().optional(),
  })
  .catchall(z.unknown())
  .superRefine((bib, ctx) => {
    for (const key of SHELF_EXCLUDED_WORK_FIELDS)
      if (key in bib) ctx.addIssue({ code: "custom", path: [key], message: "project field" });
  });
export type ShelfBibliography = z.infer<typeof ShelfBibliographySchema>;

export const ShelfManifestSchema = z
  .object({
    format: z.literal(SHELF_FORMAT),
    entry_id: z.string().regex(SHELF_ENTRY_ID_RE),
    /** 1 when created, +1 at each replacement; also in the directory name. */
    rev: z.number().int().min(1),
    /** When this content was added (a replacement is a new addition). */
    added_at: z.iso.datetime(),
    /** Where it was added from: the project folder (absolute, this machine) and the Work id there. */
    source: z.object({ project: z.string().min(1), work_id: z.string().min(1) }).strict(),
    identity: ShelfIdentitySchema,
    bibliography: ShelfBibliographySchema,
    /** In the Work's order: the first is the one that was primary in the source project. */
    docs: z.array(ShelfDocSchema),
    argument_graph: ShelfFileRecordSchema.nullable(),
    note: ShelfFileRecordSchema.nullable(),
  })
  .strict();
export type ShelfManifest = z.infer<typeof ShelfManifestSchema>;

/** Number of annotations an entry carries, over all its Docs. */
export function shelfAnnotationCount(manifest: ShelfManifest): number {
  return manifest.docs.reduce((n, d) => n + (d.annotations?.count ?? 0), 0);
}
