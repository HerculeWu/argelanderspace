/**
 * Zod schemas for the REST API DTOs.
 *
 * Mirrors the 8 endpoints of `server/app.py` (FastAPI). Endpoint paths and
 * response shapes are preserved as-is for the TS/Hono rewrite (decision 15),
 * so these schemas are the shared contract between server and web.
 *
 *   GET  /api/papers                     → PapersListResponse
 *   GET  /api/paper/{doc_id}/ir          → TexDocIr (= the stored render IR;
 *     the retired raw `GET /api/paper/{doc_id}` Document passthrough was
 *     removed in MS3a, and its alias left this file in MS3b)
 *   GET  /api/library                    → LibraryResponse (= LibraryPayload)
 *   POST /api/library/refs               → AddRefRequest / AddRefResponse
 *   PATCH /api/library/refs              → PatchRefRequest / PatchRefResponse
 *   POST /api/library/refresh?offline=   → RefreshQuery / RefreshResponse
 *   POST /api/library/upload?id|doi|arxiv → UploadQuery / UploadResponse
 *   GET  /images/{doc_id}/{filename}     → ImageParams (binary response)
 *
 * All endpoints report errors as FastAPI's `{"detail": string}` (ApiError).
 */

import { z } from "zod";
import { LibraryPayloadSchema, LibraryRefSchema } from "./library.js";

// ---- GET /api/papers ------------------------------------------------------- //

export const PapersListResponseSchema = z.object({
  papers: z.array(z.string()),
});

// ---- GET /api/library ------------------------------------------------------ //

export const LibraryResponseSchema = LibraryPayloadSchema;

// ---- POST /api/library/refs ------------------------------------------------ //

/** The frontend also sends `source: "graph-node"`; the server ignores extras. */
export const AddRefRequestSchema = z.looseObject({
  nodeId: z.string(),
});

export const AddRefResponseSchema = z.object({
  ref: LibraryRefSchema,
});

// ---- PATCH /api/library/refs ----------------------------------------------- //

/**
 * The work id rides in the body (ids contain slashes/colons, e.g.
 * "doi:10.1051/..."). Only these five user-state fields are applied
 * server-side; other keys are ignored.
 */
export const PatchRefRequestSchema = z.looseObject({
  id: z.string(),
  /** Color label; empty string clears it. */
  label: z.string().optional(),
  read: z.boolean().optional(),
  star: z.boolean().optional(),
  /** Note text; empty string clears it. */
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const PatchRefResponseSchema = z.object({
  ok: z.boolean(),
});

// ---- POST /api/library/refresh --------------------------------------------- //

/** Query params; `offline=true` skips remote enrichment. */
export const RefreshQuerySchema = z.object({
  offline: z.boolean().optional(),
});

export const AdsStatusSchema = z.enum(["ok", "no-token", "unauthorized", "error"]);

/** Summary returned by `rebuild()`. */
export const RefreshResponseSchema = z.object({
  works: z.number().int(),
  bib_entries: z.number().int(),
  saved_nodes: z.number().int(),
  nodes: z.number().int(),
  links: z.number().int(),
  ads_status: AdsStatusSchema,
  acquisition: z.object({
    /** Tallies keyed by tier/status label ("—" for unset). */
    chosen: z.record(z.string(), z.number().int()),
    ready_now: z.record(z.string(), z.number().int()),
    status: z.record(z.string(), z.number().int()),
    ingested: z.number().int(),
  }),
  resolution: z.object({
    count_source: z.record(z.string(), z.number().int()),
  }),
});

// ---- POST /api/library/upload ---------------------------------------------- //

/**
 * Query params identify the target work (exactly one is required); the payload
 * rides as the raw request body (not JSON — hence no body schema here).
 * Stage 3.1 MS2: the body is a LaTeX source **zip**
 * (`Content-Type: application/zip`), attach-only — the named work must already
 * exist. (The PDF/OCR variant is archived on the `ocr-features` branch.)
 */
export const UploadQuerySchema = z
  .object({
    id: z.string().optional(),
    doi: z.string().optional(),
    arxiv: z.string().optional(),
  })
  .refine((q) => q.id !== undefined || q.doi !== undefined || q.arxiv !== undefined, {
    message: "id, doi, or arxiv query param required",
  });

export const UploadResponseSchema = z.object({
  ref: LibraryRefSchema,
});

// ---- GET /images/{doc_id}/{filename} --------------------------------------- //

/** Path params; the response is the image binary (no JSON body). */
export const ImageParamsSchema = z.object({
  doc_id: z.string(),
  filename: z.string(),
});

// ---- errors ---------------------------------------------------------------- //

/** FastAPI `HTTPException` body, shared by all endpoints. */
export const ApiErrorSchema = z.object({
  detail: z.string(),
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type PapersListResponse = z.infer<typeof PapersListResponseSchema>;
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;
export type AddRefRequest = z.infer<typeof AddRefRequestSchema>;
export type AddRefResponse = z.infer<typeof AddRefResponseSchema>;
export type PatchRefRequest = z.infer<typeof PatchRefRequestSchema>;
export type PatchRefResponse = z.infer<typeof PatchRefResponseSchema>;
export type RefreshQuery = z.infer<typeof RefreshQuerySchema>;
export type AdsStatus = z.infer<typeof AdsStatusSchema>;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
export type UploadQuery = z.infer<typeof UploadQuerySchema>;
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type ImageParams = z.infer<typeof ImageParamsSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
