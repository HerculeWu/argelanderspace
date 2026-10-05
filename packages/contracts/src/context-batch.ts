/**
 * Context batching (copilot ticket 24, spec §7.2): what a message or a `reader read` call actually gave the model of
 * a whole Reader reading or PDF material, and the ledger that tells what a conversation has already been given.
 *
 * A reading too large for the room left in the model's window is delivered in parts, never cut: every delivery
 * records its range, the total and its source version, so a part is never mistaken for the whole. The source of
 * every part stays the live Doc (`reader read`), the record is the only thing this module keeps.
 */
import { z } from "zod";

const Count = z.number().int().nonnegative();

export const CONTEXT_COVERAGE_STATUSES = ["complete", "partial", "omitted", "held"] as const;

/**
 * One delivery of a Reader reading (units are its entries, in reading order) or of a PDF's material (units are its
 * pages, zero-based): `[from, to)` of `total`. `head` says whether the part that is not a unit list came along (the
 * Reader's bibliography, annotations and metadata; the PDF's outline and annotations). `version` binds the delivery
 * to the content it was read from: `<fingerprint>#<annotationsRev>` or `<sha256>#<annotationsRev>`.
 *
 * - `complete`: everything, head included (in a `reader read` result: nothing remains after this part).
 * - `partial`: a part; the units `[to, total)` are NOT read and must be fetched with `reader read` (from = to).
 * - `omitted`: nothing was delivered (it did not fit, or the provider rejected it); `note` says why.
 * - `held`: nothing was repeated because this very version was already delivered whole earlier in the conversation.
 */
export const ContextCoverageSchema = z
  .object({
    kind: z.enum(["reader", "pdf"]),
    docId: z.string().min(1).max(500),
    version: z.string().min(1).max(300),
    unit: z.enum(["entries", "pages"]),
    total: Count,
    from: Count,
    to: Count,
    head: z.boolean(),
    status: z.enum(CONTEXT_COVERAGE_STATUSES),
    /** The message that delivered a `held` version (when known). */
    heldIn: z.string().max(200).optional(),
    /**
     * This part was delivered and read, then taken out of the conversation to make room for later parts (it is no
     * longer in the model's context; `reader read` fetches it again from the Doc). The range stays as the record of
     * what was read; the ledger no longer counts it as present.
     */
    evicted: z.boolean().optional(),
    /** The provider rejected the request that carried this part as too large: it was withdrawn and is NOT read. */
    withdrawn: z.boolean().optional(),
    /** A single unit that did not fit (status `omitted` of a read): its id and the bytes it needs. */
    gap: z
      .object({ id: z.string().max(200), bytes: Count })
      .strict()
      .optional(),
    note: z.string().max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from > value.to || value.to > value.total)
      ctx.addIssue({ code: "custom", message: "invalid coverage range" });
  });
export type ContextCoverage = z.infer<typeof ContextCoverageSchema>;

/**
 * The durable record of which deliveries were taken out of the conversation (ticket 24, spec §8.2): the history keeps
 * every message and tool result exactly as the model was sent it; this record, appended as its own entry, says which
 * of them a later request shows as a stand-in. `evict`: taken out to make room (what was read stays on record).
 * `withdraw`: the provider rejected the request that carried it (NOT read). `ceiling`: the most bytes one delivery
 * may take from now on, learned from the rejected delivery (it only ever shrinks).
 */
export const DELIVERY_LEDGER_TYPE = "argelander.delivery.v1";
export const DeliveryLedgerEntrySchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(
        z
          .object({
            action: z.enum(["evict", "withdraw"]),
            target: z
              .object({ kind: z.enum(["tool", "message"]), id: z.string().min(1).max(200) })
              .strict(),
          })
          .strict()
      )
      .max(10000),
    ceiling: Count.optional(),
  })
  .strict();
export type DeliveryLedgerEntry = z.infer<typeof DeliveryLedgerEntrySchema>;

export const readingVersion = (identity: string, annotationsRev: number): string =>
  `${identity}#${annotationsRev}`;
export const ledgerKey = (kind: "reader" | "pdf", docId: string, version: string): string =>
  `${kind}\n${docId}\n${version}`;

interface Held {
  total: number;
  head: boolean;
  /** Merged, sorted, non-adjacent half-open ranges. */
  ranges: [number, number][];
  heldIn?: string;
}

/**
 * What a conversation's history already holds of each reading version. Built from the deliveries recorded in the
 * history itself, so it can never claim more than the model was actually given (a withdrawn delivery leaves no
 * record and therefore no claim).
 */
export class ReadingLedger {
  private readonly held = new Map<string, Held>();
  add(coverage: ContextCoverage, messageId?: string): void {
    // `held` and `omitted` deliver nothing new.
    if (coverage.status === "held" || coverage.status === "omitted" || coverage.evicted) return;
    const key = ledgerKey(coverage.kind, coverage.docId, coverage.version);
    const entry = this.held.get(key) ?? { total: coverage.total, head: false, ranges: [] };
    entry.total = coverage.total;
    entry.head = entry.head || coverage.head;
    if (coverage.to > coverage.from)
      entry.ranges = merge([...entry.ranges, [coverage.from, coverage.to]]);
    // The message that delivered the head (heldIn names a message, never a tool call).
    if (messageId && coverage.head && !entry.heldIn) entry.heldIn = messageId;
    this.held.set(key, entry);
  }
  /** True when this version's head and every unit were delivered. */
  complete(kind: "reader" | "pdf", docId: string, version: string): boolean {
    const entry = this.held.get(ledgerKey(kind, docId, version));
    if (!entry?.head) return false;
    if (entry.total === 0) return true;
    const only = entry.ranges[0];
    return entry.ranges.length === 1 && !!only && only[0] === 0 && only[1] >= entry.total;
  }
  /** Every version whose head and every unit are present, as `[kind, docId, version]`. */
  completeVersions(): ["reader" | "pdf", string, string][] {
    const out: ["reader" | "pdf", string, string][] = [];
    for (const [key, entry] of this.held) {
      const [kind, docId, version] = key.split("\n");
      if (!kind || docId === undefined || version === undefined) continue;
      if (this.complete(kind as "reader" | "pdf", docId, version))
        out.push([kind as "reader" | "pdf", docId, version]);
      void entry;
    }
    return out;
  }
  heldIn(kind: "reader" | "pdf", docId: string, version: string): string | undefined {
    return this.held.get(ledgerKey(kind, docId, version))?.heldIn;
  }
  /** The ranges given so far, for a version (empty when none). */
  ranges(kind: "reader" | "pdf", docId: string, version: string): [number, number][] {
    return this.held.get(ledgerKey(kind, docId, version))?.ranges.map(([a, b]) => [a, b]) ?? [];
  }
}
function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}
