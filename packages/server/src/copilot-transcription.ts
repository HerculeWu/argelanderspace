/**
 * What a conversation has actually READ of a source PDF (copilot ticket 30, spec §12 step 5/6 and §7.2 rule 3).
 *
 * A transcription must never be called complete over pages the model did not see. The host therefore derives, from
 * the conversation's own history (never from what the model claims), which pages of the source PDF were delivered
 * to it: as an original page image (`reader read_page_image`), or as the real text of a page that has a text layer
 * (a PDF reading, whole or in parts). A delivery that was taken out of the conversation to make room still counts as
 * read (it was read, and what was written from it is saved); a delivery the provider rejected does not (it never
 * was). The result rides on `text generate` and `save_source`, so the model, the user's operation record and the
 * final report all carry the same truth.
 */
import { ContextCoverageSchema, type PdfPageMaterial } from "@argelanderspace/contracts";
import {
  deliveriesOf,
  deliveryKey,
  type RawEntry,
  recordsOf,
  textOfContent,
} from "./copilot-ledger.js";

export interface SourceCoverage {
  pdfDocId: string;
  pageCount: number;
  /** Zero-based indexes of the pages not delivered to the model in any form this conversation. */
  unreadPageIndexes: number[];
  /** The same pages as the user's Reader numbers them (one-based), as ranges: "3, 5-7". */
  unreadPages: string;
  /** Pages read only through their text layer (no image looked at). */
  textOnlyPages: number;
  imagePages: number;
  /** Every page was delivered; never "the transcription is complete". */
  allPagesRead: boolean;
  note: string;
}

/** The zero-based page indexes of `sha256`'s original whose image the conversation delivered, per its history. */
export function imagedPages(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string
): Set<number> {
  const { gone } = recordsOf(entries);
  const out = new Set<number>();
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const details = message.details as
      | { tool?: string; action?: string; status?: string; object?: { id?: string } }
      | undefined;
    if (
      details?.tool !== "reader" ||
      details.action !== "read_page_image" ||
      details.status !== "ok" ||
      details.object?.id !== pdfDocId
    )
      continue;
    // a rejected delivery was never read
    if (gone.get(deliveryKey("tool", message.toolCallId)) === "withdraw") continue;
    try {
      const body = JSON.parse(textOfContent(message.content)) as {
        sha256?: string;
        page?: { pageIndex?: number };
      };
      const page = body.page?.pageIndex;
      if (body.sha256 === sha256 && Number.isInteger(page) && (page as number) >= 0)
        out.add(page as number);
    } catch {
      // not a page image result
    }
  }
  return out;
}

/** The page ranges `[from, to)` of this original's text that the conversation delivered (whole PDF messages and parts). */
export function textPages(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string
): Set<number> {
  const { gone } = recordsOf(entries);
  const out = new Set<number>();
  for (const delivery of deliveriesOf(entries)) {
    if (gone.get(delivery.key) === "withdraw") continue;
    const coverage = delivery.coverage ? ContextCoverageSchema.safeParse(delivery.coverage) : null;
    if (!coverage?.success) continue;
    const c = coverage.data;
    if (c.kind !== "pdf" || c.docId !== pdfDocId || !c.version.startsWith(`${sha256}#`)) continue;
    if (c.status !== "complete" && c.status !== "partial") continue;
    for (let page = c.from; page < c.to; page++) out.add(page);
  }
  return out;
}

const ranges = (indexes: readonly number[]): string => {
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

/** What the conversation has read of the PDF. `pages` is the verified original's own page material. */
export function sourceCoverage(
  entries: readonly RawEntry[],
  pdfDocId: string,
  sha256: string,
  pages: readonly Pick<PdfPageMaterial, "pageIndex" | "hasTextLayer">[]
): SourceCoverage {
  const imaged = imagedPages(entries, pdfDocId, sha256);
  const texted = textPages(entries, pdfDocId, sha256);
  const unread: number[] = [];
  let textOnly = 0;
  let images = 0;
  for (const page of pages) {
    if (imaged.has(page.pageIndex)) {
      images++;
      continue;
    }
    // a page with no text layer exists only as an image: its "text reading" is nothing
    if (page.hasTextLayer && texted.has(page.pageIndex)) textOnly++;
    else unread.push(page.pageIndex);
  }
  const allPagesRead = unread.length === 0;
  return {
    pdfDocId,
    pageCount: pages.length,
    unreadPageIndexes: unread,
    unreadPages: ranges(unread),
    textOnlyPages: textOnly,
    imagePages: images,
    allPagesRead,
    note: allPagesRead
      ? `every page of the PDF was delivered to you (${images} as images, ${textOnly} through their text layer only); that says nothing about whether the transcription itself is complete or correct`
      : `pages ${ranges(unread)} (zero-based ${unread.join(", ")}) of ${pages.length} were NOT delivered to you in this conversation: the transcription is not finished and must not be called complete`,
  };
}
