import { describe, expect, it } from "vitest";
import {
  type ContextCoverage,
  ContextCoverageSchema,
  CopilotOperationSchema,
  PdfMaterialEnvelopeSchema,
  ReaderReadOperationSchema,
  ReadingLedger,
  readingVersion,
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
