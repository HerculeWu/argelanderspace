import { z } from "zod";

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const baseUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });

/** Only non-secret fields: never accept SDK commands, keys, or headers here. */
export const ProviderModelConfigSchema = z
  .object({
    baseUrl,
    modelId: identifier,
    name: z.string().trim().min(1).max(200),
    contextWindow: z.number().int().positive().max(10_000_000),
    maxTokens: z.number().int().positive().max(1_000_000),
    image: z.boolean(),
    tools: z.boolean(),
    defaultThinking: ThinkingLevelSchema.nullable(),
  })
  .strict()
  .refine((value) => value.maxTokens <= value.contextWindow);
export type ProviderModelConfig = z.infer<typeof ProviderModelConfigSchema>;
export const ProviderCredentialSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(16_384)
      .refine(
        (value) =>
          !value.startsWith("!") && ![...value].some((character) => character.charCodeAt(0) < 32)
      ),
  })
  .strict();
export const ProviderPreferencesSchema = z
  .object({
    version: z.literal(1),
    models: z.record(
      identifier,
      z.record(
        identifier,
        z
          .object({
            tools: z.boolean(),
            defaultThinking: ThinkingLevelSchema.nullable(),
          })
          .strict()
      )
    ),
  })
  .strict();
export type ProviderPreferences = z.infer<typeof ProviderPreferencesSchema>;

// Restricted Pi models.json surface. Pi itself validates this again when loading.
const piModelFields = {
  name: z.string().min(1).max(200).optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .max(2)
    .optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
};
export const CopilotModelsFileSchema = z
  .object({
    providers: z.record(
      identifier,
      z
        .object({
          baseUrl: baseUrl.optional(),
          models: z
            .array(
              z
                .object({ id: identifier, api: z.string().min(1).max(100), ...piModelFields })
                .strict()
            )
            .max(500)
            .optional(),
          modelOverrides: z.record(identifier, z.object(piModelFields).strict()).optional(),
        })
        .strict()
    ),
  })
  .strict();

export interface CopilotModel {
  id: string;
  name: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  image: boolean;
  tools: boolean;
  thinkingLevels: ThinkingLevel[];
  capabilitiesKnown: boolean;
  defaultThinking: ThinkingLevel | null;
  defaultThinkingValid: boolean;
}
export interface CopilotProvider {
  id: string;
  name: string;
  method: "api_key" | "oauth";
  credential: { configured: boolean; stored: boolean; source: "stored" | "environment" | "none" };
  models: CopilotModel[];
  catalogStatus: "ready" | "error";
}
export interface ProvidersResponse {
  version: 1;
  providers: CopilotProvider[];
}
export type ProviderTestCode =
  | "success"
  | "credentials"
  | "endpoint"
  | "model"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "capabilities"
  | "unavailable";
export interface ProviderTestResult {
  code: ProviderTestCode;
  retryable: boolean;
}
export interface ProviderMutationResult {
  saved: true;
  provider: CopilotProvider;
}
