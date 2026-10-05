import { DELIVERY_LEDGER_TYPE } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import {
  deliveriesOf,
  deliveryKey,
  heldGone,
  presentLedger,
  type RawEntry,
  recordsOf,
  shedCandidates,
} from "../src/copilot-ledger.js";

const reading = (entries: number) => ({
  docId: "d1",
  epoch: { fingerprint: "fp", annotationsRev: 2, annotations: "current" },
  entries: Array.from({ length: entries }, (_, n) => ({ id: `p-${n}` })),
});
const user = (messageId: string, body: object): RawEntry => ({
  type: "message",
  message: { role: "user", content: JSON.stringify({ version: 1, messageId, text: "t", ...body }) },
});
const tool = (
  toolCallId: string,
  details: object,
  content: unknown[] = [{ type: "text", text: "{}" }]
): RawEntry => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName: "reader", content, details },
});
const ledgerEntry = (data: object): RawEntry => ({
  type: "custom",
  customType: DELIVERY_LEDGER_TYPE,
  data,
});

describe("the delivery ledger over the history entries", () => {
  it("synthesizes the coverage of an older whole envelope that never had one, so it can be shed", () => {
    const old = user("m1", { context: { reader: { reading: reading(7) } } });
    const [delivery] = deliveriesOf([old]);
    expect(delivery).toMatchObject({
      key: "message:m1",
      coverage: {
        kind: "reader",
        total: 7,
        from: 0,
        to: 7,
        head: true,
        status: "complete",
        version: "fp#2",
      },
    });
    expect(shedCandidates([delivery as never], new Map()).map((d) => d.key)).toEqual([
      "message:m1",
    ]);
    const pdf = user("m2", {
      context: {},
      pdf: {
        status: "ok",
        reading: { docId: "p", sha256: "a".repeat(64), annotationsRev: 0, pages: [{}, {}, {}] },
      },
    });
    expect(deliveriesOf([pdf])[0]?.coverage).toMatchObject({
      kind: "pdf",
      unit: "pages",
      total: 3,
    });
  });
  it("sees a page image as a delivery with no reading, and a plain message as none", () => {
    const entries = [
      user("m3", { context: {} }),
      tool("c1", {}, [
        { type: "text", text: "{}" },
        { type: "image", data: "x", mimeType: "image/png" },
      ]),
    ];
    const deliveries = deliveriesOf(entries);
    expect(deliveries.map((d) => [d.key, d.image, d.coverage])).toEqual([["tool:c1", true, null]]);
  });
  it("counts only what is present: shed and withdrawn deliveries leave the ledger, and are never shed twice", () => {
    const part = (from: number, to: number, head: boolean) => ({
      batch: {
        kind: "reader",
        docId: "d1",
        version: "fp#2",
        unit: "entries",
        total: 10,
        from,
        to,
        head,
        status: to === 10 ? "complete" : "partial",
        note: "n",
      },
    });
    const entries = [
      tool("a", part(0, 5, true)),
      tool("b", part(5, 10, false)),
      ledgerEntry({
        version: 1,
        records: [{ action: "evict", target: { kind: "tool", id: "a" } }],
        ceiling: 4000,
      }),
      ledgerEntry({
        version: 1,
        records: [{ action: "withdraw", target: { kind: "tool", id: "a" } }],
        ceiling: 9000,
      }),
    ];
    const { gone, ceiling } = recordsOf(entries);
    expect(gone.get("tool:a")).toBe("withdraw");
    expect(ceiling).toBe(4000);
    const deliveries = deliveriesOf(entries);
    expect(presentLedger(deliveries, gone).complete("reader", "d1", "fp#2")).toBe(false);
    expect(presentLedger(deliveries, gone).ranges("reader", "d1", "fp#2")).toEqual([[5, 10]]);
    expect(shedCandidates(deliveries, gone).map((d) => d.key)).toEqual(["tool:b"]);
  });
  it("ignores a ledger entry it cannot read instead of failing the conversation", () => {
    const { gone } = recordsOf([
      ledgerEntry({ nonsense: true }),
      ledgerEntry({
        version: 1,
        records: [{ action: "evict", target: { kind: "message", id: "m1" } }],
      }),
    ]);
    expect([...gone.keys()]).toEqual(["message:m1"]);
  });
  it("a held message is only true while the delivery it names is present", () => {
    const held = {
      kind: "reader" as const,
      docId: "d1",
      version: "fp#2",
      unit: "entries" as const,
      total: 10,
      from: 0,
      to: 10,
      head: true,
      status: "held" as const,
      heldIn: "m1",
      note: "n",
    };
    const whole = { ...held, status: "complete" as const, heldIn: undefined };
    const present = presentLedger(
      deliveriesOf([
        user("m1", { coverage: whole, context: { reader: { reading: reading(10) } } }),
      ]),
      new Map()
    );
    expect(heldGone(held, new Map(), present)).toBe(false);
    // m1 left, a later delivery made the version whole again: the held message still must not point at m1
    const later = presentLedger(
      deliveriesOf([
        user("m9", { coverage: whole, context: { reader: { reading: reading(10) } } }),
      ]),
      new Map()
    );
    expect(heldGone(held, new Map([["message:m1", "evict" as const]]), later)).toBe(true);
    expect(heldGone(held, new Map(), presentLedger([], new Map()))).toBe(true);
  });
  it("one record it cannot read costs the others nothing", () => {
    const { gone, ceiling } = recordsOf([
      ledgerEntry({
        version: 1,
        records: [
          { action: "evict", target: { kind: "tool", id: "x".repeat(225) } },
          { action: "evict", target: { kind: "message", id: "m1" } },
          { action: "nonsense", target: { kind: "message", id: "m2" } },
        ],
        ceiling: 3000,
      }),
    ]);
    expect([...gone.keys()]).toEqual(["message:m1"]);
    expect(ceiling).toBe(3000);
  });
  it("a long tool-call id gets a stable bounded key, the same in both directions", () => {
    const long = `c${"y".repeat(224)}`;
    expect(deliveryKey("tool", long)).toBe(deliveryKey("tool", long));
    expect(deliveryKey("tool", long).length).toBeLessThan(150);
    expect(deliveryKey("tool", "short")).toBe("tool:short");
    expect(deliveryKey("tool", long)).not.toBe(deliveryKey("tool", `${long}z`));
  });
  it("a write (ticket 21 PDF annotations, Reader annotations) is never a delivery, however its result looks", () => {
    const write = tool("w1", { tool: "reader", action: "create_pdf_annotation", status: "ok" }, [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          reading: { format: "pdf", sha256: "a".repeat(64), annotationsRev: 1, pages: [{}] },
        }),
      },
    ]);
    expect(deliveriesOf([write])).toEqual([]);
  });
});
