import { z } from "zod";

/** Explicit metadata for choosing a Doc reading path; never proves content consistency. */
export const DocFormatSchema = z.enum(["latex", "pdf"]);
export type DocFormat = z.infer<typeof DocFormatSchema>;

export const DocDescriptionSchema = z.discriminatedUnion("format", [
  z.strictObject({
    doc_id: z.string().min(1),
    format: z.literal("latex"),
    /** Trusted only when copied from the stored Doc's explicit source metadata. */
    acquired_via: z.enum(["arxiv_eprint", "user_latex_zip"]).optional(),
  }),
  z.strictObject({
    doc_id: z.string().min(1),
    format: z.literal("pdf"),
    acquired_via: z.enum(["user_pdf_upload", "arxiv_pdf"]),
    arxiv_id: z.string().min(1).optional(),
    acquired_at: z.string().datetime({ offset: true }),
    owner_work_id: z.string().min(1),
    work_title: z.string(),
    display_name: z.string().min(1),
    byte_length: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    page_count: z.number().int().positive(),
    pages: z.array(
      z.strictObject({
        width: z.number().positive(),
        height: z.number().positive(),
        rotation: z.number(),
      })
    ),
  }),
]);
export type DocDescription = z.infer<typeof DocDescriptionSchema>;
