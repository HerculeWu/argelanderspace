import { describe, expect, it } from "vitest";
import {
  PdfAnnotationsFileSchema,
  PdfDocMetadataSchema,
  PdfReadingPositionSchema,
} from "../src/pdf-doc.js";

describe("PDF Doc persistence contracts", () => {
  const metadata = {
    version: 1,
    doc_id: "pdf-123",
    format: "pdf",
    display_name: "paper.pdf",
    original_filename: "paper.pdf",
    acquired_via: "user_pdf_upload",
    acquired_at: "2026-09-24T12:00:00.000Z",
    byte_length: 1234,
    sha256: "a".repeat(64),
    page_count: 2,
    pages: [
      { width: 612, height: 792, rotation: 0 },
      { width: 612, height: 792, rotation: 90 },
    ],
  };

  it("accepts valid immutable PDF metadata and bounded page geometry", () => {
    expect(PdfDocMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      PdfDocMetadataSchema.parse({ ...metadata, acquired_via: "arxiv_pdf", arxiv_id: "2601.01234" })
    ).toMatchObject({ acquired_via: "arxiv_pdf", arxiv_id: "2601.01234" });
    expect(PdfDocMetadataSchema.safeParse({ ...metadata, acquired_via: "arxiv_pdf" }).success).toBe(
      false
    );
    expect(PdfDocMetadataSchema.safeParse({ ...metadata, page_count: 101 }).success).toBe(false);
    expect(PdfDocMetadataSchema.safeParse({ ...metadata, sha256: "not-a-hash" }).success).toBe(
      false
    );
  });

  it("accepts null initial progress and only bounded finite page-local locations", () => {
    const base = { version: 1, doc_id: "pdf-123", content_sha256: "a".repeat(64), rev: 0 };
    expect(PdfReadingPositionSchema.parse({ ...base, position: null })).toMatchObject({
      position: null,
    });
    expect(
      PdfReadingPositionSchema.parse({ ...base, position: { page_index: 1, x: 0.25, y: 0.8 } })
        .position
    ).toEqual({ page_index: 1, x: 0.25, y: 0.8 });
    for (const position of [
      { page_index: 1.5, x: 0.2, y: 0.3 },
      { page_index: 0, x: Number.NaN, y: 0.3 },
      { page_index: 0, x: 1.1, y: 0.3 },
      { page_index: 0, x: 0.2, y: -0.1 },
      { page_index: 0, x: 0.2, y: 0.3, future: true },
    ])
      expect(PdfReadingPositionSchema.safeParse({ ...base, position }).success).toBe(false);
  });

  it("represents initial annotation state as a bound empty user file", () => {
    const file = {
      version: 1,
      doc_id: "pdf-123",
      content_sha256: "a".repeat(64),
      rev: 0,
      annotations: [],
    };
    expect(PdfAnnotationsFileSchema.parse(file)).toEqual(file);
    expect(PdfAnnotationsFileSchema.safeParse({ ...file, annotations: undefined }).success).toBe(
      false
    );
  });

  it("validates area/page/document annotations without stripping additive fields", () => {
    const base = {
      id: "ann-1",
      body: "  note $x^2$  ",
      created_at: "2026-09-24T12:00:00.000Z",
      updated_at: "2026-09-24T12:00:00.000Z",
    };
    const file = {
      version: 1,
      doc_id: "pdf-123",
      content_sha256: "a".repeat(64),
      rev: 0,
      future_sidecar_field: { retain: true },
      annotations: [
        {
          ...base,
          kind: "rectangle",
          page_index: 1,
          rectangle: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          style: { color: "#ffcc00", opacity: 0.35, line_width: 2 },
          future_annotation_field: 17,
        },
        { ...base, id: "ann-2", kind: "page_comment", page_index: 0 },
        { ...base, id: "ann-3", kind: "document_comment" },
      ],
    };
    expect(PdfAnnotationsFileSchema.parse(file)).toEqual(file);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        ...file,
        annotations: [
          { ...file.annotations[0], rectangle: { x: 0.9, y: 0.1, width: 0.2, height: 0.2 } },
        ],
      }).success
    ).toBe(false);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        ...file,
        annotations: [
          { ...file.annotations[1], style: { color: "red", opacity: 1, line_width: 1 } },
        ],
      }).success
    ).toBe(false);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        ...file,
        annotations: [file.annotations[0], file.annotations[0]],
      }).success
    ).toBe(false);
  });

  it("validates one stable cross-page text target with exact page-local geometry", () => {
    const base = {
      id: "text-1",
      body: "Default note",
      created_at: "2026-09-24T12:00:00.000Z",
      updated_at: "2026-09-24T12:00:00.000Z",
    };
    const annotation = {
      ...base,
      kind: "highlight",
      target: {
        quote: "Across two pages",
        fragments: [
          { page_index: 0, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] },
          { page_index: 1, rectangles: [{ x: 0.2, y: 0.05, width: 0.4, height: 0.03 }] },
        ],
      },
    };
    const parsed = PdfAnnotationsFileSchema.parse({
      version: 1,
      doc_id: "pdf-123",
      content_sha256: "a".repeat(64),
      rev: 1,
      annotations: [annotation],
    });
    expect(parsed.annotations).toEqual([annotation]);
    expect(
      PdfAnnotationsFileSchema.parse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 2,
        annotations: [{ ...base, kind: "highlight", color: "#387bd1", target: annotation.target }],
      }).annotations[0]
    ).toMatchObject({ kind: "highlight", color: "#387bd1" });
    expect(
      PdfAnnotationsFileSchema.parse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 2,
        annotations: [{ ...base, kind: "highlight", target: annotation.target }],
      }).annotations[0]
    ).not.toHaveProperty("color");
    expect(
      PdfAnnotationsFileSchema.safeParse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 2,
        annotations: [{ ...base, kind: "underline", color: "#387bd1", target: annotation.target }],
      }).success
    ).toBe(false);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 2,
        annotations: [{ ...base, kind: "highlight", color: "red", target: annotation.target }],
      }).success
    ).toBe(false);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 1,
        annotations: [
          { ...annotation, target: { ...annotation.target, future_target_field: true } },
        ],
      }).data?.annotations[0]
    ).toMatchObject({ target: { future_target_field: true } });
    expect(
      PdfAnnotationsFileSchema.safeParse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 1,
        annotations: [
          {
            ...annotation,
            target: {
              ...annotation.target,
              fragments: [annotation.target.fragments[0], annotation.target.fragments[0]],
            },
          },
        ],
      }).success
    ).toBe(false);
    expect(
      PdfAnnotationsFileSchema.safeParse({
        version: 1,
        doc_id: "pdf-123",
        content_sha256: "a".repeat(64),
        rev: 1,
        annotations: [
          {
            ...annotation,
            target: {
              ...annotation.target,
              fragments: [
                { page_index: 0, rectangles: [{ x: 0.9, y: 0.2, width: 0.3, height: 0.1 }] },
              ],
            },
          },
        ],
      }).success
    ).toBe(false);
  });

  it("represents no reading position without fabricating page zero", () => {
    const file = {
      version: 1,
      doc_id: "pdf-123",
      content_sha256: "a".repeat(64),
      rev: 0,
      position: null,
    };
    expect(PdfReadingPositionSchema.parse(file)).toEqual(file);
  });
});
