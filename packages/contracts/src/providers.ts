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
export type ProviderLoginStatus =
  | "running"
  | "awaiting_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
/** Fixed categories only: SDK/provider error text can contain tokens and is never serialized. */
export type ProviderLoginFailure = "invalid_response" | "network" | "unavailable";
export interface ProviderLoginChallenge {
  /** Binds one answer to this exact prompt of this exact login instance. */
  id: string;
  kind: "select" | "manual_code";
  /** Option ids only: SDK prompt/label text is never forwarded (the UI localizes its own copy). */
  options: { id: string }[];
}
export type ProviderLoginNotice =
  | { type: "auth_url"; url: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    };
export interface ProviderLogin {
  id: string;
  providerId: string;
  status: ProviderLoginStatus;
  challenge: ProviderLoginChallenge | null;
  notices: ProviderLoginNotice[];
  failure: ProviderLoginFailure | null;
  startedAt: number;
  expiresAt: number;
}
export interface ProviderLoginResponse {
  login: ProviderLogin;
}
export const ProviderLoginAnswerSchema = z
  .object({ challengeId: z.string().uuid(), value: z.string().min(1).max(8192) })
  .strict();

export interface CopilotProvider {
  id: string;
  name: string;
  method: "api_key" | "oauth";
  credential: {
    configured: boolean;
    stored: boolean;
    source: "stored" | "environment" | "none";
    /** A stored login whose last token refresh failed; distinct from "never signed in". */
    refreshFailed?: boolean;
  };
  /** Latest login instance of an OAuth provider; survives page reload, not a server restart. */
  login?: ProviderLogin;
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
  | "refresh_failed"
  | "unavailable";
export interface ProviderTestResult {
  code: ProviderTestCode;
  retryable: boolean;
}
export interface ProviderMutationResult {
  saved: true;
  provider: CopilotProvider;
}
