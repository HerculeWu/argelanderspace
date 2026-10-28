/**
 * Context compaction of a Copilot conversation (release-0.2 ticket 11, spec "Copilot 上下文压缩").
 *
 * The host decides WHEN to compact (copilot.ts: once the delivery ledger has taken every reading delivery out and the
 * request still does not fit, or when the user asks) and pi supplies the rest: the cut point rules, the summarization
 * prompts and the `CompactionEntry` the session manager projects (summary + the kept part). Pi's own automatic trigger
 * stays off, because it measures the raw history before the ledger has projected it and would compact what the ledger
 * could have shed, and because its summary requests would go through the host's per-run `streamFunction`.
 *
 * Pure functions over the history entries; nothing here reads or writes a file.
 */
import {
  type CompactionDetails,
  CopilotPromptSchema,
  copilotContextObjects,
} from "@argelanderspace/contracts";
import {
  buildContextEntries,
  type compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  findCutPoint,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  deliveriesOf,
  type LedgerAction,
  presentLedger,
  projectEntries,
  type RawEntry,
  recordsOf,
  shedCandidates,
  textOfContent,
} from "./copilot-ledger.js";

type Preparation = Parameters<typeof compact>[0];
type SummaryMessage = Preparation["messagesToSummarize"][number];

/** Pi's defaults (reserve 16 384 tokens for the summary request, keep about 20 000 recent tokens), kept inside a small window. */
export function compactionSettings(contextWindow: number): Preparation["settings"] {
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: Math.max(
      1000,
      Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(contextWindow / 4))
    ),
  };
}

/** The page observations the host records are not conversation: the summary leaves them out. */
const OBSERVATION_TYPE = "argelander.page-observation.v1";
/** The heading under which the application restates the object references a summary lost. */
export const REFERENCES_HEADING = "## Object references (kept verbatim by the application)";

/**
 * What the summary request is told on top of pi's own prompt (appended as its "Additional focus"). The whole summary
 * is written in the interface language; ids, keys, paths and names are copied, never translated.
 */
export function compactionFocus(language: "zh-CN" | "en"): string {
  const tongue = language === "zh-CN" ? "Simplified Chinese (简体中文)" : "English";
  return [
    `Write the whole summary in ${tongue}, the language of the user's interface. Everything that is an identifier stays EXACTLY as written, never translated, shortened, reformatted or paraphrased.`,
    "This is a research workbench agent. Copy every object reference that appears VERBATIM: workId, docId, annotation ids, argument ids, plan and task ids, manuscript ids, cite keys, DOI, arXiv and bibcode identifiers, file paths. List all of them again under Critical Context.",
    "Keep the user's goals, the constraints they gave and everything still unfinished or waiting for the user's decision; say what was last asked and whether it was answered.",
    "The summary does not replace reading material: document text, pages and images are not copied into it and are not in the conversation any more. State which Doc and which range was read and what was concluded from it, so the agent reads it again from the Doc when the details matter.",
  ].join(" ");
}

const BOUND_KEYS = new Set([
  "workId",
  "docId",
  "annotationId",
  "argumentId",
  "planId",
  "taskId",
  "manuscriptId",
  "entryId",
  "citeKey",
  "id",
]);

/** Object references the summarized messages carry: the page context's objects and the ids a tool call named. */
export function referencesOf(
  messages: readonly SummaryMessage[],
  previousSummary?: string
): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === "user") {
      const marker = /\[objects: ([^\]]*)\]/.exec(textOfContent(content));
      for (const id of marker?.[1]?.split(", ") ?? []) if (id) found.add(id);
    } else if (message.role === "assistant" && Array.isArray(content)) {
      for (const part of content as { type?: string; arguments?: Record<string, unknown> }[]) {
        if (part?.type !== "toolCall" || !part.arguments) continue;
        for (const [key, value] of Object.entries(part.arguments))
          if (BOUND_KEYS.has(key) && typeof value === "string" && value && value.length <= 200)
            found.add(value);
      }
    }
  }
  // What an earlier summary already had restated stays restated.
  const before = previousSummary?.split(REFERENCES_HEADING)[1];
  for (const line of before?.split("\n") ?? []) {
    const id = /^- `?([^`\s]+)`?$/.exec(line.trim())?.[1];
    if (id) found.add(id);
  }
  return [...found];
}

/** A summary that lost an object reference gets it back, from the application and not from the model. */
export function withReferences(summary: string, references: readonly string[]): string {
  if (references.every((id) => summary.includes(id))) return summary;
  // An earlier restated block is rebuilt with the new ones, so the heading appears once.
  const base = (summary.split(REFERENCES_HEADING)[0] ?? summary).trimEnd();
  const restated = references.filter((id) => !base.includes(id));
  return `${base}\n\n${REFERENCES_HEADING}\n${restated.map((id) => `- ${id}`).join("\n")}\n`;
}

/** A user message of the host is a JSON envelope with the whole page context: the summary sees the words and the objects. */
function condense(message: SummaryMessage): SummaryMessage | undefined {
  const custom = message as { role: string; customType?: string };
  if (custom.role === "custom" && custom.customType === OBSERVATION_TYPE) return undefined;
  if (message.role !== "user") return message;
  const text = textOfContent((message as { content?: unknown }).content);
  if (!text.startsWith("{")) return message;
  try {
    const prompt = CopilotPromptSchema.parse(JSON.parse(text));
    const objects = copilotContextObjects(prompt.context).map((object) => object.id);
    const lines = [
      `${prompt.kind === "resume" ? "[resume request] " : ""}${prompt.text}`,
      `[page: ${prompt.context.view}]`,
      ...(objects.length ? [`[objects: ${objects.join(", ")}]`] : []),
    ];
    return {
      ...message,
      content: [{ type: "text", text: lines.join("\n") }],
    } as unknown as SummaryMessage;
  } catch {
    return message;
  }
}

/** The text of a message cut to `cap` characters, so a long history still fits one summary request. */
function capped(message: SummaryMessage, cap: number): SummaryMessage {
  if (!Number.isFinite(cap)) return message;
  const cut = (text: string) =>
    text.length > cap ? `${text.slice(0, cap)}\n[… cut for the summary]` : text;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string")
    return { ...message, content: cut(content) } as unknown as SummaryMessage;
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    content: content.map((part: Record<string, unknown>) => {
      if (part.type === "text" && typeof part.text === "string")
        return { ...part, text: cut(part.text) };
      if (part.type === "toolCall") {
        const args = JSON.stringify(part.arguments ?? {});
        return args.length > cap ? { ...part, arguments: { cut: args.slice(0, cap) } } : part;
      }
      return part;
    }),
  } as unknown as SummaryMessage;
}

/**
 * Pi walks the cut back over the metadata entries that stand before the message it keeps (model and thinking changes, the
 * host's reference entries) and then asks whether that METADATA entry starts a turn; it does not, so a cut right before a
 * user message is taken for one in the middle of a turn. The turn starts where the first message after the cut does.
 */
function splitTurn(
  cut: ReturnType<typeof findCutPoint>,
  entries: readonly SessionEntry[]
): { isSplitTurn: boolean; turnStartIndex: number } {
  if (!cut.isSplitTurn) return { isSplitTurn: false, turnStartIndex: -1 };
  for (let index = cut.firstKeptEntryIndex; index < entries.length; index++) {
    const first = entries[index];
    if (!first) break;
    const messages = sessionEntryToContextMessages(first);
    if (!messages.length) continue;
    const starts = messages.some((message) =>
      ["user", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(
        message.role
      )
    );
    return starts
      ? { isSplitTurn: false, turnStartIndex: -1 }
      : { isSplitTurn: true, turnStartIndex: cut.turnStartIndex };
  }
  return { isSplitTurn: false, turnStartIndex: -1 };
}

export interface CompactionPlan {
  /** Everything pi's `compact` needs. */
  preparation: Preparation;
  /** The entry the model keeps from; the marker of the shown history stands before it. */
  firstKeptEntryId: string;
  /** Index of that entry in the branch the plan was made from. */
  firstKeptIndex: number;
  /** Reading deliveries (`kind:id`) that leave the model's context with the cut: they are recorded as taken out. */
  evict: string[];
  /** Object references the summarized messages carry, restated if the summary loses one. */
  references: string[];
  /** Whether an earlier summary is folded into this one. */
  includesPrevious: boolean;
}

/**
 * What a compaction of this history would do, or undefined when there is nothing to compact (the conversation is still
 * short: the part to keep reaches back to the first message, or only a compaction entry ends it).
 *
 * `entries` is the whole branch. The cut is chosen on the history as the ledger projects it (a reading that was taken
 * out costs only its stand-in); the messages to summarize show every reading delivery on the far side of the cut as its
 * stand-in too, because the summary never carries reading material.
 */
export function planCompaction(
  entries: readonly SessionEntry[],
  settings: Preparation["settings"],
  budgetChars: number
): CompactionPlan | undefined {
  const last = entries.at(-1);
  if (!last || last.type === "compaction") return undefined;
  const ctx = buildContextEntries([...entries], last.id);
  const earlier = ctx[0]?.type === "compaction" ? ctx[0] : undefined;
  const start = earlier ? 1 : 0;
  const raw = ctx as unknown as RawEntry[];
  const { gone } = recordsOf(entries as unknown as RawEntry[]);
  const deliveries = deliveriesOf(raw);
  const present = projectEntries(raw, gone, deliveries, presentLedger(deliveries, gone));
  const cut = findCutPoint(
    present as unknown as SessionEntry[],
    start,
    ctx.length,
    settings.keepRecentTokens
  );
  const first = ctx[cut.firstKeptEntryIndex];
  if (!first?.id) return undefined;
  const { isSplitTurn, turnStartIndex } = splitTurn(cut, present as unknown as SessionEntry[]);
  const leaving = shedCandidates(
    deliveries.filter((delivery) => delivery.index < cut.firstKeptEntryIndex),
    gone
  ).map((delivery) => delivery.key);
  const after = new Map<string, LedgerAction>(gone);
  for (const key of leaving) after.set(key, "evict");
  const shown = projectEntries(raw, after, deliveries, presentLedger(deliveries, after));
  const messagesIn = (from: number, to: number) =>
    shown
      .slice(from, to)
      .flatMap((entry) => sessionEntryToContextMessages(entry as unknown as SessionEntry))
      .filter((message) => message.role !== "system")
      .map((message) => condense(message as SummaryMessage))
      .filter((message): message is SummaryMessage => message !== undefined);
  const historyEnd = isSplitTurn ? turnStartIndex : cut.firstKeptEntryIndex;
  let messagesToSummarize = messagesIn(start, historyEnd);
  let turnPrefixMessages = isSplitTurn ? messagesIn(turnStartIndex, cut.firstKeptEntryIndex) : [];
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
  const size = () => JSON.stringify([messagesToSummarize, turnPrefixMessages]).length;
  if (size() > budgetChars) {
    const originalHistory = messagesToSummarize;
    const originalPrefix = turnPrefixMessages;
    for (const cap of [8000, 2000, 600]) {
      messagesToSummarize = originalHistory.map((message) => capped(message, cap));
      turnPrefixMessages = originalPrefix.map((message) => capped(message, cap));
      if (size() <= budgetChars) break;
    }
  }
  const previousSummary = earlier?.type === "compaction" ? earlier.summary : undefined;
  const everything = [...messagesToSummarize, ...turnPrefixMessages];
  const tokensBefore = (present as unknown as SessionEntry[])
    .slice(start)
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .reduce((sum, message) => sum + estimateTokens(message), 0);
  return {
    preparation: {
      firstKeptEntryId: first.id,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn,
      tokensBefore: tokensBefore + (previousSummary ? Math.ceil(previousSummary.length / 4) : 0),
      ...(previousSummary ? { previousSummary } : {}),
      // Files are not what a Copilot conversation is about: the summary carries no file lists.
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings,
    },
    firstKeptEntryId: first.id,
    firstKeptIndex: cut.firstKeptEntryIndex,
    evict: leaving,
    references: referencesOf(everything, previousSummary),
    includesPrevious: previousSummary !== undefined,
  };
}

/** The `details` a compaction entry records. */
export function compactionDetails(
  origin: CompactionDetails["origin"],
  model: { provider: string; id: string }
): CompactionDetails {
  return { version: 1, origin, provider: model.provider, model: model.id };
}

/**
 * The entries a request is made from: after a compaction, its entry (summary and system message) and the entries from
 * the one it keeps on; before one, all of them. With `assumed`, the compaction that WOULD be made: a stand-in as big as a
 * summary may be replaces everything before the cut (a message is admitted on that assumption, see `admitMessage`).
 */
export function activeEntries<T extends RawEntry>(
  entries: readonly T[],
  assumed?: { firstKeptEntryId: string; reserve: number }
): T[] {
  const system = (entry: T) => entry.type === "message" && entry.message?.role === "system";
  if (assumed) {
    const kept = entries.findIndex((entry) => entry.id === assumed.firstKeptEntryId);
    if (kept >= 0) {
      const stand = {
        type: "compaction",
        summary: "x".repeat(assumed.reserve),
        firstKeptEntryId: assumed.firstKeptEntryId,
      } as unknown as T;
      return [
        ...entries.slice(0, kept).filter(system),
        stand,
        ...entries.slice(kept).filter((entry) => entry.type !== "compaction" && !system(entry)),
      ];
    }
  }
  let at = -1;
  entries.forEach((entry, index) => {
    if (entry.type === "compaction") at = index;
  });
  if (at < 0) return [...entries];
  const kept = entries.findIndex((entry) => entry.id === entries[at]?.firstKeptEntryId);
  const from = kept >= 0 && kept < at ? kept : at;
  return [
    entries[at] as T,
    ...entries.slice(from, at).filter((entry) => entry.type !== "compaction" && !system(entry)),
    ...entries.slice(at + 1),
  ];
}

/** Whether a compaction of this branch has anything to summarize (a conversation that is still short has not). */
export function canCompact(
  entries: readonly SessionEntry[],
  settings: Preparation["settings"]
): boolean {
  const last = entries.at(-1);
  if (!last || last.type === "compaction") return false;
  const ctx = buildContextEntries([...entries], last.id);
  const start = ctx[0]?.type === "compaction" ? 1 : 0;
  const raw = ctx as unknown as RawEntry[];
  const { gone } = recordsOf(entries as unknown as RawEntry[]);
  const deliveries = deliveriesOf(raw);
  const present = projectEntries(raw, gone, deliveries, presentLedger(deliveries, gone));
  const cut = findCutPoint(
    present as unknown as SessionEntry[],
    start,
    ctx.length,
    settings.keepRecentTokens
  );
  if (!ctx[cut.firstKeptEntryIndex]?.id) return false;
  return present
    .slice(start, cut.firstKeptEntryIndex)
    .some((entry) =>
      sessionEntryToContextMessages(entry as unknown as SessionEntry).some(
        (message) => message.role !== "system"
      )
    );
}
