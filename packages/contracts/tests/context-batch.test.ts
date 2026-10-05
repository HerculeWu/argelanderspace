import { describe, expect, it } from "vitest";
import {
  buildPdfReading,
  type ContextCoverage,
  ContextCoverageSchema,
  CopilotOperationSchema,
  PdfMaterialEnvelopeSchema,
  ReaderReadOperationSchema,
  ReadingLedger,
  readingVersion,
  summarizePdfPage,
} from "../src/index.js";

const cov = (over: Partial<ContextCoverage> = {}): ContextCoverage => ({
  kind: "reader",
  docId: "d1",
  version: readingVersion("fp", 0),
  unit: "entries",
  total: 10,
  from: 0,
  to: 4,
  head: true,
  status: "partial",
  note: "n",
  ...over,
});

describe("context coverage", () => {
  it("rejects a range outside its total and unknown keys", () => {
    expect(ContextCoverageSchema.safeParse(cov()).success).toBe(true);
    expect(ContextCoverageSchema.safeParse(cov({ to: 11 })).success).toBe(false);
    expect(ContextCoverageSchema.safeParse(cov({ from: 5, to: 4 })).success).toBe(false);
    expect(ContextCoverageSchema.safeParse({ ...cov(), extra: 1 }).success).toBe(false);
  });
  it("is carried by an operation record and a read can name where to continue", () => {
    expect(
      CopilotOperationSchema.safeParse({
        id: "1",
        tool: "reader",
        action: "read",
        status: "ok",
        batch: cov(),
      }).success
    ).toBe(true);
    expect(
      ReaderReadOperationSchema.safeParse({ action: "read", docId: "d", from: 3 }).success
    ).toBe(true);
    expect(
      ReaderReadOperationSchema.safeParse({ action: "read", docId: "d", from: -1 }).success
    ).toBe(false);
    expect(ReaderReadOperationSchema.safeParse({ action: "read", docId: "d" }).success).toBe(true);
  });
  it("PDF material may be stated as held or omitted with the totals, never as an empty document", () => {
    const totals = { pages: 3, pagesWithText: 2, pagesWithoutText: 1, characters: 9 };
    for (const status of ["held", "omitted"] as const)
      expect(
        PdfMaterialEnvelopeSchema.safeParse({
          status,
          detail: "x",
          modelAcceptsImages: true,
          coverage: totals,
        }).success
      ).toBe(true);
    expect(PdfMaterialEnvelopeSchema.safeParse({ status: "held", detail: "x" }).success).toBe(
      false
    );
  });
});

describe("the reading ledger", () => {
  it("counts only what was delivered, merges adjacent parts and needs the head and every unit for complete", () => {
    const ledger = new ReadingLedger();
    const v = readingVersion("fp", 0);
    ledger.add(cov({ from: 0, to: 4 }), "m1");
    expect(ledger.complete("reader", "d1", v)).toBe(false);
    expect(ledger.ranges("reader", "d1", v)).toEqual([[0, 4]]);
    ledger.add(cov({ from: 6, to: 10, head: false, status: "complete" }));
    expect(ledger.ranges("reader", "d1", v)).toEqual([
      [0, 4],
      [6, 10],
    ]);
    expect(ledger.complete("reader", "d1", v)).toBe(false);
    ledger.add(cov({ from: 4, to: 6, head: false }));
    expect(ledger.ranges("reader", "d1", v)).toEqual([[0, 10]]);
    expect(ledger.complete("reader", "d1", v)).toBe(true);
    expect(ledger.heldIn("reader", "d1", v)).toBe("m1");
  });
  it("never counts a part without the head, an omitted or held delivery, or one taken out of the conversation", () => {
    const ledger = new ReadingLedger();
    const v = readingVersion("fp", 0);
    ledger.add(cov({ from: 0, to: 10, head: false, status: "complete" }));
    expect(ledger.complete("reader", "d1", v)).toBe(false);
    ledger.add(cov({ from: 0, to: 0, head: false, status: "omitted" }));
    ledger.add(cov({ from: 0, to: 10, status: "held" }));
    ledger.add(cov({ from: 0, to: 10, status: "complete", evicted: true }));
    expect(ledger.complete("reader", "d1", v)).toBe(false);
    expect(ledger.ranges("reader", "d1", v)).toEqual([[0, 10]]);
  });
  it("keeps versions apart: a changed annotations revision is another version", () => {
    const ledger = new ReadingLedger();
    ledger.add(cov({ from: 0, to: 10, status: "complete" }));
    expect(ledger.complete("reader", "d1", readingVersion("fp", 0))).toBe(true);
    expect(ledger.complete("reader", "d1", readingVersion("fp", 1))).toBe(false);
    expect(ledger.complete("pdf", "d1", readingVersion("fp", 0))).toBe(false);
  });
});

describe("the PDF context summary describes what the message carried", () => {
  const SHA = "d".repeat(64);
  const page = {
    docId: "p",
    format: "pdf" as const,
    phase: "ready" as const,
    sha256: SHA,
    pageCount: 4,
    currentPage: 0,
    zoom: null,
    outline: [],
    outlineTruncated: false,
    search: null,
    selection: null,
    panels: { outlineCollapsed: false, annotationsCollapsed: false },
  };
  const reading = buildPdfReading(
    {
      docId: "p",
      sha256: SHA,
      pageCount: 4,
      pages: [0, 1, 2, 3].map((pageIndex) => ({
        pageIndex,
        width: 1,
        height: 1,
        rotation: 0 as const,
        hasTextLayer: pageIndex !== 3,
        text: pageIndex === 3 ? null : "abc",
      })),
      outline: [],
      outlineTruncated: false,
      annotations: [],
      annotationsRev: 0,
    },
    false
  );
  it("a part counts its own pages and carries the whole document's totals beside them", () => {
    const part = { ...reading, pages: reading.pages.slice(0, 2) };
    const summary = summarizePdfPage(page as never, { status: "ok", reading: part }, false);
    expect(summary.material).toMatchObject({
      status: "ok",
      pages: 2,
      pagesWithText: 2,
      pagesWithoutText: 0,
      characters: 6,
      totals: { pages: 4, pagesWithText: 3, pagesWithoutText: 1 },
    });
  });
  it("a held or left-out material carries none of its pages but still the totals and the model's capability", () => {
    const coverage = { pages: 4, pagesWithText: 3, pagesWithoutText: 1, characters: 9 };
    const held = summarizePdfPage(page as never, {
      status: "held",
      detail: "d",
      modelAcceptsImages: false,
      coverage,
    });
    expect(held.material).toMatchObject({
      status: "held",
      pages: 0,
      modelAcceptsImages: false,
      totals: coverage,
    });
  });
});
