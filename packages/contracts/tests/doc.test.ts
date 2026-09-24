import { describe, expect, test } from "vitest";
import { DocDescriptionSchema } from "../src/doc.js";

describe("DocDescriptionSchema", () => {
  test("describes format and only explicit known acquisition provenance", () => {
    expect(
      DocDescriptionSchema.parse({
        doc_id: "latex-a",
        format: "latex",
        acquired_via: "user_latex_zip",
      })
    ).toEqual({
      doc_id: "latex-a",
      format: "latex",
      acquired_via: "user_latex_zip",
    });
    expect(DocDescriptionSchema.parse({ doc_id: "local-a", format: "latex" })).toEqual({
      doc_id: "local-a",
      format: "latex",
    });
    expect(
      DocDescriptionSchema.parse({
        doc_id: "pdf-123",
        format: "pdf",
        acquired_via: "user_pdf_upload",
        acquired_at: "2026-09-24T00:00:00.000Z",
        owner_work_id: "work:1",
        work_title: "Paper",
        display_name: "paper.pdf",
        byte_length: 123,
        sha256: "a".repeat(64),
        page_count: 1,
        pages: [{ width: 612, height: 792, rotation: 0 }],
      }).format
    ).toBe("pdf");
    expect(
      DocDescriptionSchema.parse({
        doc_id: "pdf-arxiv",
        format: "pdf",
        acquired_via: "arxiv_pdf",
        arxiv_id: "2601.01234",
        acquired_at: "2026-09-24T00:00:00.000Z",
        owner_work_id: "work:1",
        work_title: "Paper",
        display_name: "arxiv-2601.01234.pdf",
        byte_length: 123,
        sha256: "a".repeat(64),
        page_count: 1,
        pages: [{ width: 612, height: 792, rotation: 0 }],
      }).acquired_via
    ).toBe("arxiv_pdf");
    expect(
      DocDescriptionSchema.safeParse({
        doc_id: "latex-a",
        format: "latex",
        acquired_via: "planner-pdf",
      }).success
    ).toBe(false);
    expect(DocDescriptionSchema.safeParse({ doc_id: "upload-a", format: "other" }).success).toBe(
      false
    );
  });
});
