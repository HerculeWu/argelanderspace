/**
 * What a job is for and which acquisition it is: the convention of `Job.payload` (architecture ticket 02).
 *
 * The runner stores the payload a submit passes and never looks at it; the payload is the only record of the Work,
 * the Doc and the kind of acquisition a job belongs to, and it is read back from the job files under
 * `<dataDir>/jobs/`, from the `hello` replay and from every `job.*` message. Two halves:
 *
 * - **Writing**: five shapes, one per submit in the server's acquisition module. The schemas below name their fields
 *   in the order they are written; a submit states its shape with `satisfies`, so a renamed field or a new format is a
 *   type error at the submit. They are the convention, not a gate: no reader parses a payload with them.
 * - **Reading**: `jobTarget` — lenient, because an old job file or a replayed job may carry any payload (none, null, a
 *   string, an array, missing or mistyped fields, a format this build does not know). It never throws and never calls
 *   such a payload bad data; what a reader does with an empty `workId` or an unknown `format` stays with the reader.
 *
 * `JobSchema.payload` itself stays `unknown` on the wire and on disk.
 */
import { z } from "zod";
import type { JobKindSchema } from "./job-status.js";

// ---- format ---------------------------------------------------------------- //

/** An upload job's `payload.format`: an uploaded PDF, an arXiv PDF. A LaTeX archive has none. */
export const JOB_FORMATS = ["pdf", "arxiv-pdf"] as const;
export const JobFormatSchema = z.enum(JOB_FORMATS);
export type JobFormat = z.infer<typeof JobFormatSchema>;
/** The formats by name, for the readers that compare (no format literals at the comparison). */
export const JOB_FORMAT = { pdf: "pdf", arxivPdf: "arxiv-pdf" } as const satisfies Record<
  string,
  JobFormat
>;

export function isJobFormat(value: unknown): value is JobFormat {
  return (JOB_FORMATS as readonly unknown[]).includes(value);
}

// ---- the five shapes a submit writes (field names and order as written) ---- //

/** `ingest`: the arXiv LaTeX source fetch for a Work. */
export const IngestPayloadSchema = z.strictObject({ workId: z.string(), arxivId: z.string() });
/** `upload`, format `arxiv-pdf`: the arXiv PDF acquisition (`automatic` = queued by the manual import). */
export const ArxivPdfPayloadSchema = z.strictObject({
  workId: z.string(),
  docId: z.string(),
  format: z.literal(JOB_FORMAT.arxivPdf),
  arxivId: z.string(),
  automatic: z.boolean(),
});
/** `upload`, format `pdf`: a local PDF uploaded into a Work. */
export const PdfUploadPayloadSchema = z.strictObject({
  workId: z.string(),
  docId: z.string(),
  format: z.literal(JOB_FORMAT.pdf),
});
/** `upload` without a format: a LaTeX zip, its payload the upload's Work query `?id=|doi=|arxiv=` (`arxiv`, not `arxivId`). */
export const LatexZipPayloadSchema = z.strictObject({
  workId: z.string().nullable(),
  doi: z.string().nullable(),
  arxiv: z.string().nullable(),
});
/** `refresh`: the library refresh. */
export const RefreshPayloadSchema = z.strictObject({ offline: z.boolean() });

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type ArxivPdfPayload = z.infer<typeof ArxivPdfPayloadSchema>;
export type PdfUploadPayload = z.infer<typeof PdfUploadPayloadSchema>;
export type LatexZipPayload = z.infer<typeof LatexZipPayloadSchema>;
export type RefreshPayload = z.infer<typeof RefreshPayloadSchema>;

type JobKindName = z.infer<typeof JobKindSchema>;

/** The payloads a job of kind `K` is submitted with. */
export type JobPayloadOf<K extends JobKindName> = K extends "ingest"
  ? IngestPayload
  : K extends "upload"
    ? ArxivPdfPayload | PdfUploadPayload | LatexZipPayload
    : K extends "refresh"
      ? RefreshPayload
      : never;

/**
 * A kind and its payload, judged together (kind outside the payload, format inside it, the zip without one). For
 * tests and as the written convention; never on a reading path — see `jobTarget`.
 */
export const JobPayloadSchema = z.union([
  z.object({ kind: z.literal("ingest"), payload: IngestPayloadSchema }),
  z.object({
    kind: z.literal("upload"),
    payload: z.union([ArxivPdfPayloadSchema, PdfUploadPayloadSchema, LatexZipPayloadSchema]),
  }),
  z.object({ kind: z.literal("refresh"), payload: RefreshPayloadSchema }),
]);

// ---- reading ---------------------------------------------------------------- //

/** The fields a reader takes from a payload; each is null when the payload does not carry it with that type. */
export interface JobTarget {
  workId: string | null;
  docId: string | null;
  arxivId: string | null;
  format: string | null;
  automatic: boolean | null;
}

/**
 * The Work, Doc, arXiv id, format and `automatic` a job's payload names, read leniently: never throws; a string field is
 * given as it is (an empty `workId`, a format this build does not know); a missing or mistyped field, or a payload that
 * is not a plain object, gives null. Reads only these keys — the zip's `arxiv` is not an `arxivId` — and never looks at
 * the job's kind.
 */
export function jobTarget(job: { readonly payload?: unknown }): JobTarget {
  const p = job.payload;
  const fields =
    typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    workId: str(fields.workId),
    docId: str(fields.docId),
    arxivId: str(fields.arxivId),
    format: str(fields.format),
    automatic: typeof fields.automatic === "boolean" ? fields.automatic : null,
  };
}
