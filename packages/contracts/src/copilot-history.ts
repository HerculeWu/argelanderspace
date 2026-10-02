import { z } from "zod";

const base = {
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.iso.datetime(),
};
const textBlock = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imageBlock = z
  .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
  .passthrough();
const thinkingBlock = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    thinkingSignature: z.string().optional(),
    redacted: z.boolean().optional(),
  })
  .passthrough();
const toolBlock = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.json()),
  })
  .passthrough();
const content = z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]);
const usage = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        total: z.number(),
      })
      .passthrough(),
  })
  .passthrough();
const message = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("system"),
      content: z.union([z.string(), z.array(textBlock)]),
      timestamp: z.number(),
      sections: z.record(z.string(), z.string().nullable()).optional(),
      toolsAdded: z
        .array(
          z
            .object({
              name: z.string(),
              description: z.string(),
              parameters: z.record(z.string(), z.json()),
            })
            .passthrough()
        )
        .optional(),
      toolsRemoved: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    })
    .passthrough(),
  z.object({ role: z.literal("user"), content, timestamp: z.number() }).passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(z.union([textBlock, thinkingBlock, toolBlock])),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      usage,
      stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
      timestamp: z.number(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("toolResult"),
      content: z.array(z.union([textBlock, imageBlock])),
      toolCallId: z.string(),
      toolName: z.string(),
      isError: z.boolean(),
      timestamp: z.number(),
    })
    .passthrough(),
]);
export const CopilotHistoryHeaderSchema = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string().uuid(),
  timestamp: z.iso.datetime(),
  cwd: z.string(),
});
export const CopilotHistoryEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("message"), message }),
  z.object({ ...base, type: z.literal("model_change"), provider: z.string(), modelId: z.string() }),
  z.object({
    ...base,
    type: z.literal("thinking_level_change"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  z.object({
    ...base,
    type: z.literal("usage"),
    kind: z.string(),
    provider: z.string(),
    model: z.string(),
    usage,
  }),
  z.object({
    ...base,
    type: z.literal("compaction"),
    summary: z.string(),
    firstKeptEntryId: z.string().min(1),
    tokensBefore: z.number().nonnegative(),
    systemMessage: message.options[0].optional(),
    usage: usage.optional(),
    fromHook: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("branch_summary"),
    fromId: z.string().min(1),
    summary: z.string(),
    usage: usage.optional(),
    fromHook: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("custom"),
    customType: z.string().min(1),
    data: z.unknown().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("custom_message"),
    customType: z.string(),
    content,
    display: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("context_edit"),
    targetId: z.string(),
    replacement: z
      .object({
        content: z.union([
          z.string(),
          z.array(z.union([textBlock, imageBlock, thinkingBlock, toolBlock])),
        ]),
      })
      .nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("label"),
    targetId: z.string(),
    label: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("session_info"), name: z.string().optional() }),
]);
