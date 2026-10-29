/**
 * Library-domain entries of the operation catalog (release-0.2 ticket 01): the read of the Library page's own data
 * and the Files tab's "set as main". Their parameters are the action schemas of `library-ops.ts`; the result schemas
 * below are what `readLibrary` / `applyLibraryOperation` (server `library-actions.ts`) answer.
 */
import { z } from "zod";
import { LibraryRefSchema } from "./library.js";
import {
  LibraryAcquireArxivPdfSchema,
  LibraryAttachArxivSchema,
  LibraryAttachLocalPdfSchema,
  LibraryDeleteDocSchema,
  LibraryImportWorksParamsSchema,
  LibraryListAdsLibrariesSchema,
  LibraryReadAdsLibrarySchema,
  LibraryReadJobsSchema,
  LibraryReadOperationSchema,
  LibraryRefSummarySchema,
  LibrarySetMainDocSchema,
} from "./library-ops.js";
import { defineOperation } from "./operation-def.js";

const WorkObjectSchema = z.object({ kind: z.literal("work"), id: z.string() }).passthrough();

export const LibraryReadResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      total: z.number().int().nonnegative(),
      matched: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable(),
      refs: z.array(LibraryRefSummarySchema),
      links: z.array(z.tuple([z.string(), z.string()])).optional(),
    })
    .strict(),
  z.object({ ok: z.literal(true), ref: LibraryRefSchema, bibtex: z.string() }).strict(),
  z.object({ ok: z.literal(false), status: z.literal("not_found") }).strict(),
]);

export const LibrarySetMainDocResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.enum(["ok", "noop"]),
      object: WorkObjectSchema,
      label: z.string().optional(),
      mainDocId: z.string().nullable(),
      warnings: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      status: z.enum(["conflict", "not_found", "rejected", "error"]),
      detail: z.string(),
      current: z
        .object({ mainDocId: z.string().nullable(), docIds: z.array(z.string()) })
        .strict()
        .optional(),
    })
    .strict(),
]);

/**
 * What a Doc delete answers. `declined` is the answer of a Copilot conversation's card, `denied` of the workbench's
 * card for an external agent (the CLI exits 3 on it): the same refusal by the user, named by the channel that asked.
 * `workbench_required` is the CLI's own refusal when no workbench runs for the data directory (nothing was shown or
 * deleted); `interrupted` is what an operation answers when the asker left while it waited.
 */
export const LibraryDeleteDocResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.literal("ok"),
      docId: z.string(),
      object: z.object({ kind: z.literal("doc"), id: z.string() }).passthrough(),
      label: z.string(),
      works: z.array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            /** The Docs the Work keeps; `remaining[0]` is its main Doc now. */
            remaining: z.array(z.string()),
          })
          .strict()
      ),
      detail: z.string(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      status: z.enum([
        "not_found",
        "rejected",
        "error",
        "expired",
        "unsupported",
        "declined",
        "denied",
        "workbench_required",
        "interrupted",
      ]),
      detail: z.string(),
    })
    .strict(),
]);

export const LIBRARY_READ_OPERATION = defineOperation({
  domain: "library",
  name: "read",
  summary:
    "Read the Library page's data: one page of the works matching --query, or one work in full with --ref-id.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: LibraryReadOperationSchema.omit({ action: true }),
  result: LibraryReadResultSchema,
});

export const LIBRARY_SET_MAIN_DOC_OPERATION = defineOperation({
  domain: "library",
  name: "set_main_doc",
  summary:
    "Make a Doc the main Doc of a work (the Files tab's 'set as main'); --expected-main-doc-id is the main Doc you read.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: LibrarySetMainDocSchema.omit({ action: true }),
  result: LibrarySetMainDocResultSchema,
});

export const LIBRARY_DELETE_DOC_OPERATION = defineOperation({
  domain: "library",
  name: "delete_doc",
  summary:
    "Permanently delete a Doc everywhere (the Files tab's 'delete document'); the user must confirm on a card in the running workbench.",
  effect: "write",
  confirm: "card",
  navigates: false,
  params: LibraryDeleteDocSchema.omit({ action: true }),
  result: LibraryDeleteDocResultSchema,
});

// --------------------------------------------------------------------------- //
// Release-0.2 ticket 06: the rest of the Library tool's business actions
// --------------------------------------------------------------------------- //

const FailureStatus = z.string();
/** A failure that is part of the answer: `{ ok: false, status, detail }` plus whatever the operation adds (reason, entries…). */
const FailureSchema = z.looseObject({
  ok: z.literal(false),
  status: FailureStatus,
  detail: z.string(),
});
const WorkRef = z.object({ kind: z.literal("work"), id: z.string() }).passthrough();

/** `import_works`: the single-entry shape (`results`), the bibcode batch shape (`entries`), or a failure. */
export const LibraryImportWorksResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    status: z.enum(["ok", "noop"]),
    mode: z.literal("bibcode"),
    batch: z.literal(true),
    requested: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    updated: z.array(z.string()),
    refused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    entries: z.array(z.looseObject({ bibcode: z.string(), status: z.string() })),
    reasons: z.record(z.string(), z.string()).optional(),
    object: WorkRef.optional(),
    label: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  z.looseObject({
    ok: z.literal(true),
    status: z.enum(["ok", "noop"]),
    mode: z.enum(["identifier", "bibcode", "bib"]),
    created: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    updated: z.array(z.string()),
    failed: z.number().int().nonnegative(),
    results: z.array(z.looseObject({ status: z.string() })),
    object: WorkRef.optional(),
    label: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  FailureSchema,
]);

const JobViewSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  workId: z.string().nullable(),
});
/**
 * What an acquisition (arXiv PDF, arXiv LaTeX source, local PDF) answers: the job it ran and waited for. `pending`:
 * the call stopped waiting before the job finished (the job goes on where it runs; `read_jobs` shows its end).
 * `workbench_required` / `denied` / `interrupted` belong to `attach_arxiv` when it would replace a Doc's text.
 */
export const LibraryAcquisitionResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    status: z.enum(["ok", "noop", "pending"]),
    job: JobViewSchema,
    docId: z.string().optional(),
    reused: z.boolean().optional(),
    object: WorkRef,
    label: z.string().optional(),
    detail: z.string().optional(),
    /** attach_local_pdf only. */
    source: z.looseObject({ filename: z.string(), bytes: z.number().int() }).optional(),
    resourceWarning: z.boolean().optional(),
  }),
  FailureSchema,
]);

export const LibraryListAdsLibrariesResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    status: z.literal("ok"),
    total: z.number().int().nonnegative(),
    libraries: z.array(
      z.looseObject({ id: z.string(), name: z.string(), numDocuments: z.number().int() })
    ),
    truncated: z.literal(true).optional(),
  }),
  FailureSchema,
]);

export const LibraryReadAdsLibraryResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    status: z.literal("ok"),
    library: z.looseObject({ id: z.string(), name: z.string(), numDocuments: z.number().int() }),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    bibcodes: z.array(z.string()),
    nextOffset: z.number().int().nonnegative().optional(),
  }),
  FailureSchema,
]);

export const LibraryReadJobsResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    jobs: z.array(JobViewSchema),
    total: z.number().int().nonnegative(),
  }),
  FailureSchema,
]);

export const LIBRARY_IMPORT_WORKS_OPERATION = defineOperation({
  domain: "library",
  name: "import_works",
  summary:
    "Add works to the Library (the import menu): --mode identifier (a DOI or arXiv:<id>), bibcode (one, or up to 200 separated by whitespace/commas/semicolons) or bib (BibTeX text) with --text; --batch is the migration form (no automatic arXiv PDF job).",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: LibraryImportWorksParamsSchema,
  result: LibraryImportWorksResultSchema,
});

export const LIBRARY_ATTACH_LOCAL_PDF_OPERATION = defineOperation({
  domain: "library",
  name: "attach_local_pdf",
  summary:
    "Attach one PDF at an absolute local --path to the existing work --ref-id as a new Doc (the Files tab's upload); the file is only read.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: LibraryAttachLocalPdfSchema.omit({ action: true }),
  result: LibraryAcquisitionResultSchema,
});

export const LIBRARY_LIST_ADS_LIBRARIES_OPERATION = defineOperation({
  domain: "library",
  name: "list_ads_libraries",
  summary: "List your NASA ADS libraries (name, id, size). Read-only; the saved ADS token is used.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: LibraryListAdsLibrariesSchema.omit({ action: true }),
  result: LibraryListAdsLibrariesResultSchema,
});

export const LIBRARY_READ_ADS_LIBRARY_OPERATION = defineOperation({
  domain: "library",
  name: "read_ads_library",
  summary:
    "Read the bibcodes of one ADS library (--library-id from list-ads-libraries), up to 200 per call from --offset. Read-only.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: LibraryReadAdsLibrarySchema.omit({ action: true }),
  result: LibraryReadAdsLibraryResultSchema,
});

export const LIBRARY_ACQUIRE_ARXIV_PDF_OPERATION = defineOperation({
  domain: "library",
  name: "acquire_arxiv_pdf",
  summary:
    "Fetch the current arXiv PDF of the work --ref-id and add it as a Doc (the acquisition dialog's 'fetch PDF from arXiv'); waits for the job.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: LibraryAcquireArxivPdfSchema.omit({ action: true }),
  result: LibraryAcquisitionResultSchema,
});

export const LIBRARY_ATTACH_ARXIV_OPERATION = defineOperation({
  domain: "library",
  name: "attach_arxiv",
  summary:
    "Get the LaTeX source of the work --ref-id from arXiv as a Doc (the acquisition dialog's 'get LaTeX source'); refreshing an existing arXiv Doc replaces its text and needs your confirmation on a card in the workbench.",
  effect: "write",
  confirm: "conditional",
  navigates: false,
  params: LibraryAttachArxivSchema.omit({ action: true }),
  result: LibraryAcquisitionResultSchema,
});

export const LIBRARY_READ_JOBS_OPERATION = defineOperation({
  domain: "library",
  name: "read_jobs",
  summary:
    "Read the acquisition jobs (queued, running, finished, failed) of the work --ref-id, or the latest jobs of any work.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: LibraryReadJobsSchema.omit({ action: true }),
  result: LibraryReadJobsResultSchema,
});
