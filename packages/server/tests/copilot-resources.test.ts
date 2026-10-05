/**
 * The one application resource loader and the page-coverage truth of a transcription (copilot ticket 30), at their
 * own seams: the loader as a Pi session sees it, and the pure derivation of what a history really delivered.
 */
import { DELIVERY_LEDGER_TYPE } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { deliveryKey, type RawEntry } from "../src/copilot-ledger.js";
import { APP_INSTRUCTIONS, createApplicationResourceLoader } from "../src/copilot-resources.js";
import {
  coverageWarnings,
  sourceCoverage,
  transcriptionLoaded,
  USABLE_LONG_EDGE,
} from "../src/copilot-transcription.js";

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
  // the instruction is held in memory: no Pi skill (no file path a /skill: command could read), never in the prompt
  expect(l.getSkills().skills).toEqual([]);
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
const answer = (stop = "stop"): RawEntry => ({
  type: "message",
  message: { role: "assistant", stopReason: stop, content: [{ type: "text", text: "x" }] } as never,
});
const record = (action: "evict" | "withdraw", kind: "tool" | "message", id: string): RawEntry => ({
  type: "custom",
  customType: DELIVERY_LEDGER_TYPE,
  data: { version: 1, records: [{ action, target: { kind, id } }] },
});
/** A page image result; `edge` is the longer side of the delivered picture in pixels. */
const imageResult = (
  id: string,
  page: number,
  edge = 1600,
  sha = SHA,
  docId = "pdf-1"
): RawEntry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "reader",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          page: { pageIndex: page, imageWidth: Math.round(edge * 0.75), imageHeight: edge },
          sha256: sha,
        }),
      },
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
/** The user message that carries a PDF's whole material (a delivery of kind message). */
const envelope = (messageId: string): RawEntry => ({
  type: "message",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          messageId,
          pdf: {
            status: "ok",
            reading: {
              docId: "pdf-1",
              sha256: SHA,
              annotationsRev: 0,
              pages: Array.from({ length: 7 }),
            },
          },
        }),
      },
    ],
  } as never,
});
const pages = Array.from({ length: 7 }, (_, pageIndex) => ({
  pageIndex,
  hasTextLayer: pageIndex !== 3 && pageIndex !== 4,
}));

test("only pages whose image was looked at count: text-only pages are listed as not looked at, and the note says so", () => {
  const entries = [textRead("t1", 0, 3), imageResult("i4", 4), imageResult("i6", 6), answer()];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  // images of 4 and 6 (zero-based); 0-2 only by text; 3 and 5 nothing
  expect(c.viewedPages).toBe(2);
  expect(c.unreadPageIndexes).toEqual([0, 1, 2, 3, 5]);
  expect(c.textOnlyPages).toBe("1-3");
  expect(c.missingPages).toBe("4, 6");
  expect(c.allPagesRead).toBe(false);
  expect(c.note).toMatch(/text only: 1-3/);
  expect(c.note).toMatch(/must not be called complete/);
  expect(coverageWarnings(c)).toEqual(["source_unviewed:1-4, 6"]);
});

test("an image under the usable resolution is listed as low resolution, not as looked at", () => {
  const entries = [imageResult("i0", 0, 800), imageResult("i1", 1, USABLE_LONG_EDGE), answer()];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.lowResolutionPages).toBe("1");
  expect(c.viewedPages).toBe(1);
  expect(c.note).toMatch(/too small an image: 1/);
  // a better image of the same page later makes it viewed
  const better = sourceCoverage(
    [...entries, imageResult("i0b", 0, 1600), answer()],
    "pdf-1",
    SHA,
    pages
  );
  expect(better.lowResolutionPages).toBe("");
  expect(better.viewedPages).toBe(2);
});

test("all pages looked at at a usable resolution: allPagesRead, and no warning code", () => {
  const entries = [...pages.map((p) => imageResult(`i${p.pageIndex}`, p.pageIndex)), answer()];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c).toMatchObject({ allPagesRead: true, unreadPages: "", viewedPages: 7 });
  expect(c.note).toMatch(/says nothing about whether the transcription itself is complete/);
  expect(coverageWarnings(c)).toEqual([]);
  expect(coverageWarnings({ unavailable: "x" })).toEqual(["source_coverage_unverifiable"]);
});

test("a delivery nobody answered does not count: only a request that carried it and was answered successfully", () => {
  // delivered, then the provider failed: not read
  expect(
    sourceCoverage([imageResult("i0", 0), answer("error")], "pdf-1", SHA, pages).viewedPages
  ).toBe(0);
  expect(
    sourceCoverage([imageResult("i0", 0), answer("aborted")], "pdf-1", SHA, pages).viewedPages
  ).toBe(0);
  expect(sourceCoverage([imageResult("i0", 0)], "pdf-1", SHA, pages).viewedPages).toBe(0);
});

test("the reviewer's case: image, provider error, then shedding evicts it, then a successful answer: the page is unread", () => {
  const entries = [
    imageResult("i2", 2),
    answer("error"), // the request that carried it failed
    record("evict", "tool", "i2"), // the next message shed it before any answer
    answer(), // the model answered a request that only had the stand-in
  ];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.viewedPages).toBe(0);
  expect(c.unreadPageIndexes).toContain(2);
  // while an eviction AFTER an answered request keeps it read
  const kept = sourceCoverage(
    [imageResult("i2", 2), answer(), record("evict", "tool", "i2"), answer()],
    "pdf-1",
    SHA,
    pages
  );
  expect(kept.viewedPages).toBe(1);
});

test("a withdrawn delivery never counts: a tool image, a tool text part and a message envelope alike", () => {
  const image = sourceCoverage(
    [imageResult("i1", 1), answer(), record("withdraw", "tool", "i1")],
    "pdf-1",
    SHA,
    pages
  );
  expect(image.viewedPages).toBe(0);
  const text = sourceCoverage(
    [textRead("t", 0, 3), answer(), record("withdraw", "tool", "t")],
    "pdf-1",
    SHA,
    pages
  );
  expect(text.textOnlyPages).toBe("");
  expect(text.missingPages).toBe("1-7");
  const message = sourceCoverage(
    [envelope("m1"), answer(), record("withdraw", "message", "m1")],
    "pdf-1",
    SHA,
    pages
  );
  expect(message.textOnlyPages).toBe("");
  // the same envelope, not withdrawn, delivers the text of the pages that have a text layer
  const kept = sourceCoverage([envelope("m1"), answer()], "pdf-1", SHA, pages);
  expect(kept.textOnlyPages).toBe("1-3, 6-7");
  expect(kept.missingPages).toBe("4-5");
});

test("images of another original or another PDF and failed reads do not count", () => {
  const failed = imageResult("i2", 2);
  (failed.message?.details as { status: string }).status = "rejected";
  const entries = [
    failed,
    imageResult("i3", 3, 1600, "b".repeat(64)), // an older original
    imageResult("i4", 4, 1600, SHA, "pdf-other"),
    answer(),
  ];
  const c = sourceCoverage(entries, "pdf-1", SHA, pages);
  expect(c.viewedPages).toBe(0);
  expect(c.unreadPageIndexes).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(deliveryKey("tool", "i1")).toBe("tool:i1");
});

test("transcriptionLoaded recognises the loaded instruction in the history", () => {
  const loaded: RawEntry = {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "l",
      toolName: "text",
      content: [{ type: "text", text: "{}" }],
      details: {
        tool: "text",
        action: "load_instruction",
        status: "ok",
        label: "pdf-transcription v1",
      },
    },
  };
  expect(transcriptionLoaded([loaded])).toBe(true);
  expect(transcriptionLoaded([answer()])).toBe(false);
});
