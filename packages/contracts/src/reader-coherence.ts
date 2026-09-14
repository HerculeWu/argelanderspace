/** Opt-in annotations response; metadata only, never persisted in the IR/store. */
import { z } from "zod";
import { AnnotationsFileSchema } from "./annotations.js";
import { TexDocIrSchema } from "./tex-ir.js";

export const AssetDigestSchema = z.object({
  imgPath: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AssetDigest = z.infer<typeof AssetDigestSchema>;

export const CoherentAnnotationsReadSchema = z.object({
  version: z.literal(1),
  ir: TexDocIrSchema,
  file: AnnotationsFileSchema,
  assets: z.array(AssetDigestSchema),
});
export type CoherentAnnotationsRead = z.infer<typeof CoherentAnnotationsReadSchema>;
