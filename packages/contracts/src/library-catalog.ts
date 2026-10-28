/**
 * Library-domain entries of the operation catalog (release-0.2 ticket 01): the read of the Library page's own data
 * and the Files tab's "set as main". Their parameters are the action schemas of `library-ops.ts`; the result schemas
 * below are what `readLibrary` / `applyLibraryOperation` (server `library-actions.ts`) answer.
 */
import { z } from "zod";
import { LibraryRefSchema } from "./library.js";
import {
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
