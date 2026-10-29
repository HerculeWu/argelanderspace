/**
 * Text-domain entry of the operation catalog (release-0.2 ticket 07): the source panel's read. The other text actions
 * (create, save_source, add_pdf_image, validate, generate) write the Doc's source or publish reading text and are not
 * in this ticket's scope; `open_source_pdf` is an interface action and `load_instruction` is the Copilot's own loader.
 */
import { z } from "zod";
import { defineOperation } from "./operation-def.js";
import { TextReadSourceSchema } from "./text-ops.js";

/** The saved source, or the refusal (no such text Doc, `from` beyond the source, a changed version). */
export const TextReadSourceResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.literal("ok"),
      docId: z.string(),
      rev: z.number().int().nonnegative(),
      version: z.string(),
      markdown: z.string(),
    })
    .passthrough(),
  z.object({ ok: z.literal(false), status: z.string(), detail: z.string() }).passthrough(),
]);

export const TEXT_READ_SOURCE_OPERATION = defineOperation({
  domain: "text",
  name: "read_source",
  summary:
    "Read the saved Markdown source of a text Doc with its rev and assets (in parts with --from and --version when asked)",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: TextReadSourceSchema.omit({ action: true }),
  result: TextReadSourceResultSchema,
});
