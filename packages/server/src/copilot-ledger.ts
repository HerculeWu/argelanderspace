/**
 * The delivery ledger of a Copilot conversation (ticket 24, spec §8.2): which reading deliveries (a message's Reader
 * reading or PDF material, a `reader read` part, a page image) the history holds, and which of them a request shows
 * as a stand-in because they were taken out of the conversation (`evict`) or rejected by the provider (`withdraw`).
 *
 * The history itself is never rewritten: every message and tool result stays exactly as the model was sent it. The
 * decisions live in their own appended entries (`DELIVERY_LEDGER_TYPE`); everything here is a pure projection over
 * the entries, applied when a request is sent and when the window is measured.
 */
import { createHash } from "node:crypto";
import {
  type ContextCoverage,
  ContextCoverageSchema,
  CopilotPromptSchema,
  DELIVERY_LEDGER_TYPE,
  DeliveryRecordSchema,
  ReadingLedger,
  readingVersion,
} from "@argelanderspace/contracts";
import { fitEnvelope, historyCost, restateGone } from "./copilot-batching.js";

/** The parts of a history entry this module reads. */
export interface RawEntry {
  type: string;
  customType?: string;
  data?: unknown;
  message?: {
    role: string;
    content?: unknown;
    details?: unknown;
    toolCallId?: string;
    toolName?: string;
  };
}
export type LedgerAction = "evict" | "withdraw";
export interface Delivery {
  /** `message:<messageId>` or `tool:<toolCallId>`. */
  key: string;
  kind: "message" | "tool";
  id: string;
  /** Position in the entries (older first). */
  index: number;
  /** The reading it carries, as it was delivered (one synthesized for an older message that had none); null for a page image. */
  coverage: ContextCoverage | null;
  image: boolean;
  /** What it takes in the history (bytes, JSON-escaped). */
  size: number;
}

export const textOfContent = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text)
              : ""
          )
          .join("")
      : "";

/**
 * The ledger key of a delivery. A tool-call id the provider chose can be any length: a long one is mapped to a stable,
 * bounded key (a sha256 prefix), the same in the ledger and in the projection.
 */
export function deliveryKey(kind: "tool" | "message", id: string): string {
  return `${kind}:${id.length <= 120 ? id : `h-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`}`;
}

const cache = new WeakMap<object, Delivery | null>();

/** The reading a stored message envelope carried: its own coverage, or one synthesized from an older whole envelope. */
function envelopeCoverage(prompt: {
  coverage?: unknown;
  context?: { reader?: { reading?: unknown } | null } | null;
  pdf?: { status?: string; reading?: unknown };
}): ContextCoverage | null {
  const own = ContextCoverageSchema.safeParse(prompt.coverage);
  if (own.success) return own.data;
  const reader = prompt.context?.reader?.reading as
    | { docId: string; epoch: { fingerprint: string; annotationsRev: number }; entries: unknown[] }
    | null
    | undefined;
  if (reader?.entries && reader.epoch)
    return {
      kind: "reader",
      docId: reader.docId,
      version: readingVersion(reader.epoch.fingerprint, reader.epoch.annotationsRev),
      unit: "entries",
      total: reader.entries.length,
      from: 0,
      to: reader.entries.length,
      head: true,
      status: "complete",
      note: "the whole reading (a message sent before coverage was recorded)",
    };
  const pdf =
    prompt.pdf?.status === "ok"
      ? (prompt.pdf.reading as {
          docId: string;
          sha256: string;
          annotationsRev: number;
          pages: unknown[];
        })
      : undefined;
  if (pdf?.pages)
    return {
      kind: "pdf",
      docId: pdf.docId,
      version: readingVersion(pdf.sha256, pdf.annotationsRev),
      unit: "pages",
      total: pdf.pages.length,
      from: 0,
      to: pdf.pages.length,
      head: true,
      status: "complete",
      note: "the whole PDF material (a message sent before coverage was recorded)",
    };
  return null;
}

function deliveryOf(entry: RawEntry, index: number): Delivery | null {
  const cached = cache.get(entry);
  if (cached !== undefined) return cached ? { ...cached, index } : null;
  let found: Delivery | null = null;
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "user") {
    const text = textOfContent(message.content);
    if (text.startsWith("{") && /"(reading|pdf|coverage)"/.test(text)) {
      try {
        const prompt = JSON.parse(text) as Parameters<typeof envelopeCoverage>[0] & {
          messageId?: string;
        };
        const coverage = envelopeCoverage(prompt);
        if (coverage && typeof prompt.messageId === "string")
          found = {
            key: deliveryKey("message", prompt.messageId),
            kind: "message",
            id: prompt.messageId,
            index,
            coverage,
            image: false,
            size: historyCost(text),
          };
      } catch {
        // not an envelope: not a delivery
      }
    }
  } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
    const details = message.details as
      | { batch?: unknown; tool?: string; action?: string }
      | undefined;
    const batch = ContextCoverageSchema.safeParse(details?.batch);
    const content = Array.isArray(message.content) ? message.content : [];
    const image = content.some((part) => (part as { type?: string })?.type === "image");
    // A read from before coverage was recorded (tickets 18-23): the whole reading, recognised by tool and action.
    let old: ContextCoverage | null = null;
    if (!batch.success && !image && details?.tool === "reader" && details.action === "read") {
      try {
        const reading = (
          JSON.parse(textOfContent(message.content)) as { reading?: { format?: string } }
        ).reading;
        if (reading?.format === "latex")
          old = envelopeCoverage({ context: { reader: { reading } } });
        else if (reading?.format === "pdf")
          old = envelopeCoverage({ pdf: { status: "ok", reading } });
      } catch {
        // not a reading
      }
    }
    if (batch.success || image || old)
      found = {
        key: deliveryKey("tool", message.toolCallId),
        kind: "tool",
        id: message.toolCallId,
        index,
        coverage: batch.success ? batch.data : old,
        image,
        size: historyCost(JSON.stringify(message.content)),
      };
  }
  cache.set(entry, found);
  return found;
}

/** Every reading delivery and page image in the history, oldest first. */
export function deliveriesOf(entries: readonly RawEntry[]): Delivery[] {
  const out: Delivery[] = [];
  entries.forEach((entry, index) => {
    const found = deliveryOf(entry, index);
    if (found) out.push(found);
  });
  return out;
}

/** What the ledger entries say: which deliveries are out of the conversation, and the learned ceiling. */
export function recordsOf(entries: readonly RawEntry[]): {
  gone: Map<string, LedgerAction>;
  ceiling?: number;
} {
  const gone = new Map<string, LedgerAction>();
  let ceiling: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== DELIVERY_LEDGER_TYPE) continue;
    const data = entry.data as { records?: unknown; ceiling?: unknown } | null;
    // One unreadable record never costs the others: they are read one by one.
    for (const raw of Array.isArray(data?.records) ? data.records : []) {
      const record = DeliveryRecordSchema.safeParse(raw);
      if (!record.success) continue;
      const key = `${record.data.target.kind}:${record.data.target.id}`;
      // A withdrawn delivery stays withdrawn (it was never read); an evicted one may be withdrawn later.
      if (gone.get(key) !== "withdraw") gone.set(key, record.data.action);
    }
    const learned = data?.ceiling;
    if (typeof learned === "number" && Number.isInteger(learned) && learned >= 0)
      ceiling = ceiling === undefined ? learned : Math.min(ceiling, learned);
  }
  return { gone, ...(ceiling !== undefined ? { ceiling } : {}) };
}

/** What the conversation holds now of each reading version: only deliveries that are still present count. */
export function presentLedger(
  deliveries: readonly Delivery[],
  gone: ReadonlyMap<string, LedgerAction>
): ReadingLedger {
  const ledger = new ReadingLedger();
  for (const delivery of deliveries) {
    if (gone.has(delivery.key) || !delivery.coverage) continue;
    ledger.add(delivery.coverage, delivery.kind === "message" ? delivery.id : undefined);
  }
  return ledger;
}

/** The deliveries a request could still shed to make room: present, carrying a reading or an image, oldest first. */
export function shedCandidates(
  deliveries: readonly Delivery[],
  gone: ReadonlyMap<string, LedgerAction>
): Delivery[] {
  return deliveries.filter(
    (delivery) =>
      !gone.has(delivery.key) &&
      (delivery.image ||
        delivery.coverage?.status === "complete" ||
        delivery.coverage?.status === "partial")
  );
}

const EVICT_NOTE =
  "this message's material was read and then taken out of the conversation to make room for later parts";
const WITHDRAW_NOTE = "withdrawn: the provider rejected the request that carried it as too large";

/** The stand-in a request shows for an out-of-conversation delivery, as the content of its entry. */
function standInContent(entry: RawEntry, delivery: Delivery, action: LedgerAction): unknown {
  const message = entry.message;
  if (!message) return undefined;
  if (delivery.kind === "message") {
    const text = textOfContent(message.content);
    const prompt = CopilotPromptSchema.parse(JSON.parse(text));
    const withCoverage = delivery.coverage ? { ...prompt, coverage: delivery.coverage } : prompt;
    const fitted = fitEnvelope(
      withCoverage,
      Number.POSITIVE_INFINITY,
      new ReadingLedger(),
      Number.POSITIVE_INFINITY,
      action === "evict" ? EVICT_NOTE : WITHDRAW_NOTE
    );
    if (!fitted?.coverage) return message.content;
    const next = JSON.stringify(fitted.prompt);
    return typeof message.content === "string" ? next : [{ type: "text", text: next }];
  }
  const coverage = delivery.coverage;
  if (coverage) {
    const range = `${coverage.unit} [${coverage.from}, ${coverage.to}) of ${coverage.total}`;
    return [
      {
        type: "text",
        text: JSON.stringify(
          action === "evict"
            ? {
                ok: true,
                status: "evicted",
                detail: `${range} were read, then taken out of the conversation to make room; NOT in your context now. Read them again with reader read {docId, from: ${coverage.from}, version: "${coverage.version}"}`,
              }
            : {
                ok: false,
                status: "rejected",
                detail: `capacity: ${WITHDRAW_NOTE}. This part (${range}) is NOT read; read it again in a smaller part with reader read {docId, from: ${coverage.from}, version: "${coverage.version}"}`,
              }
        ),
      },
    ];
  }
  // a page image: the text that came with it stays, the picture goes
  const original = textOfContent(message.content);
  return [
    {
      type: "text",
      text: JSON.stringify({
        ok: action === "evict",
        status: action === "evict" ? "evicted" : "rejected",
        detail:
          "the page image was taken out of the conversation (to make room, or because the provider rejected the request as too large); it is NOT in your context now. Read it again with reader read_page_image {docId, pageIndex, sha256}, at a smaller longEdge if it was rejected",
        was: original.slice(0, 600),
      }),
    },
  ];
}

/**
 * A `held` message points at the delivery that made its version whole: it is only true while that delivery is
 * present (and the version is whole). Once it left, the message is restated, whatever a later message delivered.
 */
export function heldGone(
  coverage: ContextCoverage,
  gone: ReadonlyMap<string, LedgerAction>,
  ledger: ReadingLedger
): boolean {
  if (!ledger.complete(coverage.kind, coverage.docId, coverage.version)) return true;
  return coverage.heldIn !== undefined && gone.has(deliveryKey("message", coverage.heldIn));
}

const standInCache = new WeakMap<object, Map<string, unknown>>();

/**
 * The entries as a request shows them: every out-of-conversation delivery replaced by its stand-in, and every
 * `held` message whose earlier delivery is no longer present restated as not in the conversation. Never mutates.
 */
export function projectEntries<T extends RawEntry>(
  entries: readonly T[],
  gone: ReadonlyMap<string, LedgerAction>,
  deliveries: readonly Delivery[],
  ledger: ReadingLedger
): T[] {
  const byIndex = new Map(deliveries.map((delivery) => [delivery.index, delivery]));
  return entries.map((entry, index) => {
    const delivery = byIndex.get(index);
    if (!delivery || !entry.message) return entry;
    const action = gone.get(delivery.key);
    if (action) {
      let perEntry = standInCache.get(entry);
      if (!perEntry) {
        perEntry = new Map();
        standInCache.set(entry, perEntry);
      }
      if (!perEntry.has(action)) perEntry.set(action, standInContent(entry, delivery, action));
      return { ...entry, message: { ...entry.message, content: perEntry.get(action) } };
    }
    const coverage = delivery.coverage;
    if (
      delivery.kind === "message" &&
      coverage?.status === "held" &&
      heldGone(coverage, gone, ledger)
    ) {
      try {
        const prompt = CopilotPromptSchema.parse(JSON.parse(textOfContent(entry.message.content)));
        const next = JSON.stringify(
          restateGone(
            prompt,
            "the earlier delivery of this version was taken out of the conversation"
          )
        );
        return {
          ...entry,
          message: {
            ...entry.message,
            content:
              typeof entry.message.content === "string" ? next : [{ type: "text", text: next }],
          },
        };
      } catch {
        return entry;
      }
    }
    return entry;
  });
}

/** The same projection for the messages an SDK request is about to send (matched by tool call id / message id). */
export function projectMessages<T extends { role: string }>(
  messages: readonly T[],
  entries: readonly RawEntry[],
  gone: ReadonlyMap<string, LedgerAction>,
  deliveries: readonly Delivery[],
  ledger: ReadingLedger
): T[] {
  if (!deliveries.length) return [...messages];
  const projected = projectEntries(entries, gone, deliveries, ledger);
  const content = new Map<string, unknown>();
  for (const delivery of deliveries) {
    const before = entries[delivery.index];
    const after = projected[delivery.index];
    if (before && after && before.message?.content !== after.message?.content)
      content.set(delivery.key, after.message?.content);
  }
  if (!content.size) return [...messages];
  return messages.map((message) => {
    if (message.role === "toolResult") {
      const stand = content.get(
        deliveryKey("tool", (message as unknown as { toolCallId: string }).toolCallId)
      );
      return stand !== undefined ? ({ ...message, content: stand } as T) : message;
    }
    if (message.role === "user") {
      const text = textOfContent((message as unknown as { content: unknown }).content);
      const id = /"messageId":"([^"]+)"/.exec(text.slice(0, 400))?.[1];
      const stand = id ? content.get(deliveryKey("message", id)) : undefined;
      return stand !== undefined ? ({ ...message, content: stand } as T) : message;
    }
    return message;
  });
}

/** A coverage as the UI shows it after the ledger: evicted, or withdrawn (the original is not touched). */
export const annotateCoverage = (
  coverage: ContextCoverage,
  action: LedgerAction | undefined
): ContextCoverage =>
  action === "evict"
    ? { ...coverage, evicted: true }
    : action === "withdraw"
      ? { ...coverage, withdrawn: true }
      : coverage;
