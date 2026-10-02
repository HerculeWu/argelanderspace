import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  CopilotContextReferenceSchema,
  CopilotHistoryEntrySchema,
  CopilotHistoryHeaderSchema,
  CopilotObservationSchema,
  CopilotPromptSchema,
} from "@argelanderspace/contracts";
import type { FileEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Gate the complete original bytes before Pi can skip/migrate malformed history. */
export function readCopilotHistory(path: string, sessionId: string): FileEntry[] {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("history storage");
  const bytes = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("incomplete history");
  const lines = text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = CopilotHistoryHeaderSchema.safeParse(lines[0]);
  if (!header.success || header.data.id !== sessionId) throw new Error("unsupported history");
  const ids = new Set<string>();
  for (const raw of lines.slice(1)) {
    const result = CopilotHistoryEntrySchema.safeParse(raw);
    if (!result.success) throw new Error("invalid history entry");
    const value = result.data;
    if (ids.has(value.id) || (value.parentId !== null && !ids.has(value.parentId)))
      throw new Error("broken history tree");
    for (const key of ["targetId", "firstKeptEntryId", "fromId"])
      if (typeof raw[key] === "string" && !ids.has(raw[key] as string))
        throw new Error("broken history reference");
    ids.add(value.id);
  }
  const references = new Map<string, ReturnType<typeof CopilotContextReferenceSchema.parse>>();
  const prompts = new Set<string>();
  const contextViews = new Map<string, string>();
  const clientIds = new Set<string>();
  for (const raw of lines.slice(1)) {
    if (raw.type === "custom" && raw.customType === "argelander.context.v1") {
      const data = CopilotContextReferenceSchema.parse(raw.data);
      if (references.has(data.messageId) || clientIds.has(data.clientMessageId))
        throw new Error("duplicate host reference");
      clientIds.add(data.clientMessageId);
      references.set(data.messageId, data);
    }
    if (raw.type === "custom_message" && raw.customType === "argelander.page-observation.v1") {
      if (typeof raw.content !== "string") throw new Error("invalid page observation");
      const observation = CopilotObservationSchema.parse(JSON.parse(raw.content));
      if (contextViews.get(observation.taskContextId) !== observation.page.viewId)
        throw new Error("unbound page observation");
    }
    if (raw.type === "message") {
      const message = raw.message as { role: string; content: unknown };
      if (message.role !== "user") continue;
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content) &&
              message.content.every((block) => block.type === "text")
            ? message.content.map((block) => block.text).join("")
            : null;
      if (content === null) throw new Error("invalid host prompt");
      const prompt = CopilotPromptSchema.parse(JSON.parse(content));
      if (prompts.has(prompt.messageId)) throw new Error("duplicate host prompt");
      prompts.add(prompt.messageId);
      const reference = references.get(prompt.messageId);
      if (
        !reference ||
        reference.context.view !== prompt.context.view ||
        reference.context.status !== prompt.context.status ||
        reference.context.revision !== prompt.context.revision
      )
        throw new Error("broken host reference");
      contextViews.set(reference.context.contextId, prompt.context.viewId);
      const page = prompt.context.plan;
      const objects = page ? page.plans.map((plan) => ({ id: plan.id, rev: page.rev })) : [];
      const detail = page?.detail;
      if (page && detail && !objects.some((object) => object.id === detail.planId))
        objects.push({ id: detail.planId, rev: page.rev });
      if (JSON.stringify(objects) !== JSON.stringify(reference.context.objects))
        throw new Error("broken host objects");
    }
  }
  if ([...references.keys()].some((id) => !prompts.has(id)))
    throw new Error("orphan host reference");
  // Validation never serializes parsed/stripped objects over the original history.
  return lines as unknown as FileEntry[];
}

export function atomicCopilotFile(path: string, value: string): void {
  const stage = `${path}.${randomUUID()}.tmp`;
  try {
    try {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error("unsafe storage");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(stage, value, { flag: "wx", mode: 0o600 });
    renameSync(stage, path);
  } finally {
    rmSync(stage, { force: true });
  }
}

export function saveCopilotHistory(path: string, manager: SessionManager): void {
  // O(n) full snapshot of native SDK history; switch to an atomic SDK backend if large chats need incremental saves.
  const entries = [manager.getHeader(), ...manager.getEntries()];
  atomicCopilotFile(path, `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);
}
