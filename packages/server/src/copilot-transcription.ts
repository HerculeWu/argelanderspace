/**
 * What a conversation has actually LOOKED AT of a source PDF (copilot ticket 30, spec §12 step 5/6 and §7.2 rules 3 and 5).
 *
 * A transcription must never be called complete over pages the model did not see. The host therefore derives, from
 * the conversation's own history (never from what the model claims), which pages of the source PDF were delivered:
 *  - viewed: the original page image was delivered at a usable resolution (long edge >= USABLE_LONG_EDGE); only these
 *    count toward `allPagesRead`, because equations, tables and figures are only right when the page is looked at;
 *  - low resolution: an image was delivered but smaller than that (spec §7.2(5): not a legible reading);
 *  - text only: the real text of a page that has a text layer was delivered, no usable image (listed as "not looked
 *    at"; the text helps, it does not replace looking);
 *  - missing: nothing of the page was delivered.
 * A delivery counts only when a request that carried it was answered successfully by the model: one that was only in a
 * failed or stopped request and was then taken out of the conversation (evicted) was never read; a delivery the
 * provider rejected (withdrawn) never was. The result rides on `text validate`/`generate` and, as a warning code, on
 * their operation records, so the model, the user's side panel and the final report all carry the same truth.
 */
import {
  ContextCoverageSchema,
  DELIVERY_LEDGER_TYPE,
  type PdfPageMaterial,
} from "@argelanderspace/contracts";
import { deliveriesOf, type RawEntry, textOfContent } from "./copilot-ledger.js";

/** A page image smaller than this (longer edge, pixels) is not a legible reading of the page. */
export const USABLE_LONG_EDGE = 1024;

export interface SourceCoverage {
  pdfDocId: string;
  pageCount: number;
  /** Pages whose image was looked at at a usable resolution. */
  viewedPages: number;
  /** Zero-based indexes of the pages NOT looked at (text only, low resolution or missing), and the same as one-based ranges. */
  unreadPageIndexes: number[];
  unreadPages: string;
  /** Of those: only their text layer was delivered (one-based ranges), only a too-small image, nothing at all. */
  textOnlyPages: string;
  lowResolutionPages: string;
  missingPages: string;
  /** Every page was looked at at a usable resolution; never "the transcription is complete or correct". */
  allPagesRead: boolean;
  note: string;
}
/** The "coverage cannot be verified" form: no source PDF, or its pages cannot be read now. */
export interface SourceCoverageUnavailable {
  unavailable: string;
}

const isRecordEntry = (entry: RawEntry) =>
  entry.type === "custom" && entry.customType === DELIVERY_LEDGER_TYPE;
const answered = (entry: RawEntry) =>
  entry.type === "message" &&
  entry.message?.role === "assistant" &&
  !["error", "aborted"].includes(
    String((entry.message as { stopReason?: unknown }).stopReason ?? "stop")
  );

/**
 * The entry indexes of the deliveries that were READ: a request carrying the delivery (present, not a stand-in) was
 * answered by the model. Replayed in order: a delivery is pending until a successful assistant entry follows it; an
 * `evict` record before that answer, or any `withdraw`, means it never counted.
 */
export function readDeliveries(entries: readonly RawEntry[]): Set<number> {
  const byIndex = new Map(deliveriesOf(entries).map((delivery) => [delivery.index, delivery]));
  const state = new Map<string, { index: number; answered: boolean; dropped: boolean }>();
  entries.forEach((entry, index) => {
    const delivery = byIndex.get(index);
    if (delivery) state.set(delivery.key, { index, answered: false, dropped: false });
    if (answered(entry)) for (const s of state.values()) s.answered = true;
    if (isRecordEntry(entry)) {
      const records = (entry.data as { records?: unknown } | null)?.records;
      for (const raw of Array.isArray(records) ? records : []) {
        const record = raw as { action?: string; target?: { kind?: string; id?: string } };
        const s = state.get(`${record.target?.kind}:${record.target?.id}`);
        if (!s) continue;
        if (record.action === "withdraw") s.dropped = true;
        else if (record.action === "evict" && !s.answered) s.dropped = true;
      }
    }
  });
  return new Set([...state.values()].filter((s) => s.answered && !s.dropped).map((s) => s.index));
}

/** Zero-based page index -> the longest edge (pixels) delivered as an original page image of `sha256`'s original. */
export function imagedPages(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string
): Map<number, number> {
  const read = readDeliveries(entries);
  const out = new Map<number, number>();
  entries.forEach((entry, index) => {
    const message = entry.type === "message" ? entry.message : undefined;
    if (!read.has(index) || message?.role !== "toolResult") return;
    const details = message.details as
      | { tool?: string; action?: string; status?: string; object?: { id?: string } }
      | undefined;
    if (
      details?.tool !== "reader" ||
      details.action !== "read_page_image" ||
      details.status !== "ok" ||
      details.object?.id !== pdfDocId
    )
      return;
    try {
      const body = JSON.parse(textOfContent(message.content)) as {
        sha256?: string;
        page?: { pageIndex?: number; imageWidth?: number; imageHeight?: number };
      };
      const page = body.page?.pageIndex;
      if (body.sha256 !== sha256 || !Number.isInteger(page) || (page as number) < 0) return;
      const edge = Math.max(body.page?.imageWidth ?? 0, body.page?.imageHeight ?? 0);
      out.set(page as number, Math.max(out.get(page as number) ?? 0, edge));
    } catch {
      // not a page image result
    }
  });
  return out;
}

/** The page indexes whose real text was delivered (a PDF reading, whole or in parts, or a message's material). */
export function textPages(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string
): Set<number> {
  const read = readDeliveries(entries);
  const out = new Set<number>();
  for (const delivery of deliveriesOf(entries)) {
    if (!read.has(delivery.index)) continue;
    const coverage = delivery.coverage ? ContextCoverageSchema.safeParse(delivery.coverage) : null;
    if (!coverage?.success) continue;
    const c = coverage.data;
    if (c.kind !== "pdf" || c.docId !== pdfDocId || !c.version.startsWith(`${sha256}#`)) continue;
    if (c.status !== "complete" && c.status !== "partial") continue;
    for (let page = c.from; page < c.to; page++) out.add(page);
  }
  return out;
}

export const ranges = (indexes: readonly number[]): string => {
  const out: string[] = [];
  let start = -1;
  let prev = -2;
  const flush = () => {
    if (start >= 0) out.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  };
  for (const index of indexes) {
    if (index !== prev + 1) {
      flush();
      start = index;
    }
    prev = index;
  }
  flush();
  return out.join(", ");
};

/** What the conversation has looked at of the PDF. `pages` is the verified original's own page material. */
export function sourceCoverage(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string,
  pages: readonly Pick<PdfPageMaterial, "pageIndex" | "hasTextLayer">[]
): SourceCoverage {
  const imaged = imagedPages(entries, pdfDocId, sha256);
  const texted = textPages(entries, pdfDocId, sha256);
  const textOnly: number[] = [];
  const lowResolution: number[] = [];
  const missing: number[] = [];
  let viewed = 0;
  for (const page of pages) {
    const edge = imaged.get(page.pageIndex);
    if (edge !== undefined && edge >= USABLE_LONG_EDGE) viewed++;
    else if (edge !== undefined) lowResolution.push(page.pageIndex);
    // a page with no text layer exists only as an image: its "text reading" is nothing
    else if (page.hasTextLayer && texted.has(page.pageIndex)) textOnly.push(page.pageIndex);
    else missing.push(page.pageIndex);
  }
  const unread = [...textOnly, ...lowResolution, ...missing].sort((a, b) => a - b);
  const allPagesRead = unread.length === 0;
  return {
    pdfDocId,
    pageCount: pages.length,
    viewedPages: viewed,
    unreadPageIndexes: unread,
    unreadPages: ranges(unread),
    textOnlyPages: ranges(textOnly),
    lowResolutionPages: ranges(lowResolution),
    missingPages: ranges(missing),
    allPagesRead,
    note: allPagesRead
      ? `every page of the PDF was looked at as an image of at least ${USABLE_LONG_EDGE} px; that says nothing about whether the transcription itself is complete or correct`
      : `pages ${ranges(unread)} of ${pages.length} were NOT looked at as an image of at least ${USABLE_LONG_EDGE} px in this conversation (text only: ${ranges(textOnly) || "none"}; too small an image: ${ranges(lowResolution) || "none"}; nothing delivered: ${ranges(missing) || "none"}): the transcription is not finished and must not be called complete. Read those pages with reader read_page_image (longEdge ${USABLE_LONG_EDGE} or more)`,
  };
}

/** The operation record's warning codes for a coverage result (the side panel words them in the user's language). */
export function coverageWarnings(coverage: SourceCoverage | SourceCoverageUnavailable): string[] {
  if ("unavailable" in coverage) return ["source_coverage_unverifiable"];
  return coverage.allPagesRead ? [] : [`source_unviewed:${coverage.unreadPages}`];
}

/** Whether this conversation loaded the transcription instruction (it is then doing a transcription). */
export function transcriptionLoaded(entries: readonly RawEntry[]): boolean {
  return entries.some((entry) => {
    const message = entry.type === "message" ? entry.message : undefined;
    const details = message?.details as
      | { tool?: string; action?: string; status?: string; label?: string }
      | undefined;
    return (
      message?.role === "toolResult" &&
      details?.tool === "text" &&
      details.action === "load_instruction" &&
      details.status === "ok" &&
      String(details.label ?? "").startsWith("pdf-transcription")
    );
  });
}
