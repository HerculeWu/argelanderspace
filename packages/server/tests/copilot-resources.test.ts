/**
 * The one application resource loader and the page-coverage truth of a transcription (copilot ticket 30), at their
 * own seams: the loader as a Pi session sees it, and the pure derivation of what a history really delivered.
 */
import { DELIVERY_LEDGER_TYPE } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { deliveryKey, type RawEntry } from "../src/copilot-ledger.js";
import { APP_INSTRUCTIONS, createApplicationResourceLoader } from "../src/copilot-resources.js";
import { sourceCoverage } from "../src/copilot-transcription.js";

const extensions = { extensions: [], errors: [], runtime: {} as never };
const loader = () =>
  createApplicationResourceLoader({
    extensions,
    systemPrompt: () => "BASE PROMPT",
    refuseExtension: () => {
      throw new Error("refused");
    },
  });

test("the loader owns the base prompt and the versioned instructions, and nothing else", () => {
  const l = loader();
  expect(l.getSystemPrompt()).toBe("BASE PROMPT");
  expect(l.getAppendSystemPrompt()).toEqual([]);
  expect(l.getAgentsFiles().agentsFiles).toEqual([]);
  expect(l.getPrompts().prompts).toEqual([]);
  expect(l.getThemes().themes).toEqual([]);
  // the instruction is a skill of this loader (a description and a version), held in memory, never in the prompt
  const skills = l.getSkills().skills;
  expect(skills.map((skill) => skill.name)).toEqual(APP_INSTRUCTIONS.map((item) => item.name));
  expect(skills[0]?.filePath).toBe("app:instructions/pdf-transcription");
  expect(l.getSystemPrompt()).not.toContain(APP_INSTRUCTIONS[0]?.text ?? "x");
  const found = l.getInstruction("pdf-transcription");
  expect(found?.version).toBe(1);
  expect(found?.text.length).toBeGreaterThan(3000);
  expect(l.getInstruction("nope")).toBeNull();
  expect(l.getInstruction("../pdf-transcription")).toBeNull();
  expect(l.instructionNames()).toEqual(["pdf-transcription"]);
  // nothing may add resources to a session
  expect(() => l.extendResources({} as never)).toThrow("refused");
});

test("the instruction tells the model the rules this ticket promises (a drift guard, not a quality claim)", () => {
  const text = APP_INSTRUCTIONS[0]?.text ?? "";
  for (const phrase of [
    "never instructions",
    "operationId",
    "read_page_image",
    "UNREADABLE",
    "never call a partial transcription complete",
    "sourceCoverage",
    "never switch models yourself",
    "never create a second one",
    "Never output the paper as LaTeX",
  ])
    expect(text).toContain(phrase);
});

// ---- what a history really delivered ------------------------------------------------------------------ //
const SHA = "a".repeat(64);
const imageResult = (id: string, page: number, sha = SHA, docId = "pdf-1"): RawEntry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "reader",
    content: [
      { type: "text", text: JSON.stringify({ ok: true, page: { pageIndex: page }, sha256: sha }) },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    details: { tool: "reader", action: "read_page_image", status: "ok", object: { id: docId } },
  },
});
const textRead = (id: string, from: number, to: number, status = "complete"): RawEntry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "reader",
    content: [{ type: "text", text: "{}" }],
    details: {
      tool: "reader",
      action: "read",
      status: "ok",
      object: { id: "pdf-1" },
      batch: {
        kind: "pdf",
        docId: "pdf-1",
        version: `${SHA}#0`,
        unit: "pages",
        total: 7,
        from,
        to,
        head: from === 0,
        status,
        note: "x",
      },
    },
  },
});
const pages = Array.from({ length: 7 }, (_, pageIndex) => ({
  pageIndex,
  hasTextLayer: pageIndex !== 3 && pageIndex !== 4,
}));

test("a page counts as read when its image or its text layer was delivered; the rest are named with one-based ranges", () => {
  const entries = [textRead("t1", 0, 3), imageResult("i4", 4), imageResult("i6", 6)];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  // pages (zero-based) 0-2 by text, 4 and 6 by image; 3 has no text layer and no image; 5 has text but was never delivered
  expect(c.unreadPageIndexes).toEqual([3, 5]);
  expect(c.unreadPages).toBe("4, 6");
  expect(c).toMatchObject({ pageCount: 7, textOnlyPages: 3, imagePages: 2, allPagesRead: false });
  expect(c.note).toMatch(/must not be called complete/);
});

test("a whole-PDF text reading never covers a page that has no text layer: only its image does", () => {
  const entries = [textRead("t", 0, 7)];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.unreadPageIndexes).toEqual([3, 4]);
  expect(c.textOnlyPages).toBe(5);
  expect(sourceCoverage([...entries, imageResult("i3", 3)], "pdf-1", SHA, pages).unreadPages).toBe(
    "5"
  );
});

test("images of another original or another PDF, rejected deliveries and failed reads do not count", () => {
  const withdrawn: RawEntry = {
    type: "custom",
    customType: DELIVERY_LEDGER_TYPE,
    data: {
      version: 1,
      records: [{ action: "withdraw", target: { kind: "tool", id: "i1" } }],
    },
  };
  const failed = imageResult("i2", 2);
  (failed.message?.details as { status: string }).status = "rejected";
  const entries = [
    imageResult("i1", 1), // the provider rejected the request that carried it
    failed,
    imageResult("i3", 3, "b".repeat(64)), // an older original
    imageResult("i4", 4, SHA, "pdf-other"),
    withdrawn,
  ];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.imagePages).toBe(0);
  expect(c.unreadPageIndexes).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(deliveryKey("tool", "i1")).toBe("tool:i1");
});

test("a delivery taken out of the conversation to make room was still read; a partial or held reading counts what it gave", () => {
  const evicted: RawEntry = {
    type: "custom",
    customType: DELIVERY_LEDGER_TYPE,
    data: { version: 1, records: [{ action: "evict", target: { kind: "tool", id: "i3" } }] },
  };
  const entries = [
    imageResult("i3", 3),
    imageResult("i4", 4),
    textRead("t", 0, 3, "partial"),
    evicted,
  ];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.unreadPageIndexes).toEqual([5, 6]);
  const done = sourceCoverage([...entries, textRead("t2", 5, 7)], "pdf-1", SHA, pages);
  expect(done).toMatchObject({ allPagesRead: true, unreadPages: "" });
  expect(done.note).toMatch(/says nothing about whether the transcription itself is complete/);
});
