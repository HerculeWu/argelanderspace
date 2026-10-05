import { describe, expect, it } from "vitest";
import {
  AddPdfImageRequestSchema,
  CopilotConfirmationDecisionSchema,
  CopilotConfirmationSchema,
  observationPage,
  TEXT_OPERATION_ACTIONS,
  TextOperationSchema,
  TextSourcePageSchema,
} from "../src/index.js";

const SHA = "a".repeat(64);
const DOC = "text-11111111-1111-4111-8111-111111111111";

describe("the text tool's closed operation union", () => {
  it("every listed action parses with its own fields and nothing else", () => {
    const samples: Record<string, object> = {
      create: { action: "create", workId: "w" },
      read_source: { action: "read_source", docId: DOC },
      save_source: { action: "save_source", docId: DOC, expectedRev: 0, markdown: "x" },
      add_asset: {
        action: "add_asset",
        docId: DOC,
        expectedRev: 0,
        attachmentId: "11111111-1111-4111-8111-111111111111",
      },
      add_pdf_image: {
        action: "add_pdf_image",
        docId: DOC,
        expectedRev: 0,
        sha256: SHA,
        pageIndex: 0,
      },
      validate: { action: "validate", docId: DOC, sourceRev: 1 },
      generate: { action: "generate", docId: DOC, sourceRev: 1 },
      open_source_pdf: { action: "open_source_pdf", docId: DOC },
      load_instruction: { action: "load_instruction", name: "pdf-transcription" },
    };
    expect(Object.keys(samples).sort()).toEqual([...TEXT_OPERATION_ACTIONS].sort());
    for (const sample of Object.values(samples))
      expect(TextOperationSchema.safeParse(sample).success).toBe(true);
  });

  it("has no way to carry an approval: confirm, extra keys and unknown actions are refused", () => {
    expect(
      TextOperationSchema.safeParse({
        action: "generate",
        docId: DOC,
        sourceRev: 1,
        confirm: { docId: DOC },
      }).success
    ).toBe(false);
    expect(
      TextOperationSchema.safeParse({
        action: "generate",
        docId: DOC,
        sourceRev: 1,
        approved: true,
      }).success
    ).toBe(false);
    expect(TextOperationSchema.safeParse({ action: "write_file", docId: DOC }).success).toBe(false);
  });

  it("a source PDF picture needs the original's hash, a zero-based page and a region inside the page", () => {
    const ok = { expectedRev: 0, sha256: SHA, pageIndex: 0 };
    expect(AddPdfImageRequestSchema.safeParse(ok).success).toBe(true);
    expect(AddPdfImageRequestSchema.safeParse({ ...ok, sha256: undefined }).success).toBe(false);
    expect(AddPdfImageRequestSchema.safeParse({ ...ok, pageIndex: -1 }).success).toBe(false);
    expect(
      AddPdfImageRequestSchema.safeParse({
        ...ok,
        region: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
      }).success
    ).toBe(true);
    // the PDF area tool's own validation: inside the page, at least 0.006 on each side
    expect(
      AddPdfImageRequestSchema.safeParse({
        ...ok,
        region: { x: 0.8, y: 0, width: 0.4, height: 0.4 },
      }).success
    ).toBe(false);
    expect(
      AddPdfImageRequestSchema.safeParse({
        ...ok,
        region: { x: 0, y: 0, width: 0.001, height: 0.4 },
      }).success
    ).toBe(false);
    expect(AddPdfImageRequestSchema.safeParse({ ...ok, longEdge: 99999 }).success).toBe(false);
  });
});

describe("the replacement confirmation", () => {
  const impact = {
    docId: DOC,
    sourceRev: 2,
    publishedSourceRev: 1,
    annotations: 2,
    annotationsRev: 4,
    oldFingerprint: SHA,
    newFingerprint: "b".repeat(64),
  };
  const card = {
    id: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    toolCallId: "c",
    action: "replace_text_reading",
    object: { kind: "doc", id: DOC },
    label: DOC,
    impact,
    baseRev: 4,
    objectDigest: "d",
  };
  it("binds the Doc and every value of the impact", () => {
    expect(CopilotConfirmationSchema.safeParse(card).success).toBe(true);
    expect(
      CopilotConfirmationSchema.safeParse({ ...card, impact: { ...impact, annotations: 0 } })
        .success
    ).toBe(false);
    expect(
      CopilotConfirmationSchema.safeParse({ ...card, impact: { ...impact, extra: 1 } }).success
    ).toBe(false);
  });
  it("the real UI's decision names the action, the object and the version", () => {
    expect(
      CopilotConfirmationDecisionSchema.safeParse({
        decision: "approve",
        viewId: card.id,
        action: "replace_text_reading",
        objectId: DOC,
        baseRev: 4,
      }).success
    ).toBe(true);
  });
});

describe("the text source page", () => {
  const page = {
    docId: DOC,
    view: "source" as const,
    phase: "ready" as const,
    rev: 1,
    save: "dirty" as const,
    unsaved: true,
    characters: 3,
    markdown: "abc",
    assets: [],
    generated: false,
    publishedSourceRev: null,
    diagnostics: [],
    generation: "idle" as const,
  };
  it("is complete content of the editor; a later observation names it instead of repeating it", () => {
    expect(TextSourcePageSchema.safeParse(page).success).toBe(true);
    const seen = observationPage<{
      reader: null;
      textSource: { markdown: string | null; omitted?: string };
    }>({ textSource: page, reader: null });
    expect(seen.textSource?.markdown).toBeNull();
    expect(seen.textSource?.omitted).toContain("read_source");
  });
});
