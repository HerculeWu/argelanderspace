import { describe, expect, it } from "vitest";
import {
  DocDescriptionSchema,
  isTexDocIr,
  isTextDocIr,
  StoredDocIrSchema,
  TEXT_ASSET_NAME_PATTERN,
  TextBlockMetaSchema,
  TextDiagnosticSchema,
  TextDocSourceSchema,
  TextDocumentMetaSchema,
  TextReferencesSchema,
  TextSourceAssetSchema,
  TextStatsSchema,
  TextTableSchema,
  WsServerMessageSchema,
} from "../src/index.js";

const base = { sections: [], refsManifest: [], bib: [], citationsByBlock: {} };
const latex = {
  ...base,
  version: 1,
  docId: "a",
  source: { type: "latex", origin: "o", main_tex: "main.tex" },
  meta: { engine: "pdflatex" },
};
const text = {
  ...base,
  version: 1,
  docId: "text-1",
  source: { type: "text", input_version: 1, source_rev: 2, source_fingerprint: "a".repeat(64) },
  meta: { title: "T" },
};

describe("stored IR union (ticket 25)", () => {
  it("accepts both stored IRs and tells them apart; neither passes as the other", () => {
    const tex = StoredDocIrSchema.parse(latex);
    const txt = StoredDocIrSchema.parse(text);
    expect(isTexDocIr(tex) && !isTextDocIr(tex)).toBe(true);
    expect(isTextDocIr(txt) && !isTexDocIr(txt)).toBe(true);
    // a text IR cannot borrow LaTeX identity, and a LaTeX IR cannot claim a text source
    expect(
      StoredDocIrSchema.safeParse({ ...text, source: { type: "text", origin: "o", main_tex: "m" } })
        .success
    ).toBe(false);
    expect(StoredDocIrSchema.safeParse({ ...latex, source: { type: "text" } }).success).toBe(false);
  });

  it("a schema-invalid LaTeX IR keeps its own field path (no `<root>: Invalid input` from a union)", () => {
    const broken = { ...latex, sections: "nope" };
    const result = StoredDocIrSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("sections");
    const brokenText = StoredDocIrSchema.safeParse({
      ...text,
      source: { ...text.source, source_rev: -1 },
    });
    expect(brokenText.success).toBe(false);
    if (!brokenText.success)
      expect(brokenText.error.issues.map((i) => i.path.join("."))).toContain("source.source_rev");
  });

  it("describes a text Doc by explicit metadata, a draft included", () => {
    const draft = {
      doc_id: "text-1",
      format: "text",
      generated: false,
      source_rev: 0,
      published_source_rev: null,
    };
    expect(DocDescriptionSchema.parse(draft)).toEqual(draft);
    expect(DocDescriptionSchema.safeParse({ ...draft, format: "latex" }).success).toBe(false);
  });

  it("the source keeps unknown keys out and the text events join the WebSocket union", () => {
    const source = {
      version: 1,
      doc_id: "text-1",
      rev: 0,
      input_version: 1,
      markdown: "",
      assets: [],
      created_at: "2026-10-05T00:00:00.000Z",
      updated_at: "2026-10-05T00:00:00.000Z",
    };
    expect(TextDocSourceSchema.parse(source)).toEqual(source);
    expect(TextDocSourceSchema.safeParse({ ...source, extra: 1 }).success).toBe(false);
    for (const message of [
      { type: "text-source.changed", doc_id: "text-1", rev: 1, at: "t" },
      { type: "text-doc.published", doc_id: "text-1", published_source_rev: 1, at: "t" },
    ])
      expect(WsServerMessageSchema.parse(message)).toEqual(message);
  });
});

describe("format v1 marker JSON (ticket 26)", () => {
  it("document metadata is strict: version 1 is required and the text cannot name its own docId", () => {
    expect(
      TextDocumentMetaSchema.safeParse({ version: 1, title: "T", authors: ["A"] }).success
    ).toBe(true);
    for (const bad of [
      { title: "T" },
      { version: 2 },
      { version: 1, docId: "text-x" },
      { version: 1, title: "" },
    ])
      expect(TextDocumentMetaSchema.safeParse(bad).success).toBe(false);
  });
  it("block metadata is strict, ids are safe tokens, kind is an enum", () => {
    expect(
      TextBlockMetaSchema.safeParse({
        id: "eq-1",
        kind: "equation",
        number: "12",
        label: "L",
        caption: "c",
      }).success
    ).toBe(true);
    for (const bad of [
      { id: "has space" },
      { id: "" },
      { id: "x".repeat(129) },
      { kind: "chart" },
      { number: 5 },
      { colour: "red" },
    ])
      expect(TextBlockMetaSchema.safeParse(bad).success).toBe(false);
  });
  it("references use the existing Reference fields only; id and raw are required", () => {
    expect(
      TextReferencesSchema.safeParse([
        { id: "a", raw: "A", year: 1999, doi: "10.1/x", keys: ["k"] },
      ]).success
    ).toBe(true);
    for (const bad of [
      [{ id: "a" }],
      [{ raw: "A" }],
      [{ id: "a", raw: "A", extra: 1 }],
      [{ id: "a b", raw: "A" }],
      [{ id: "a", raw: "" }],
    ])
      expect(TextReferencesSchema.safeParse(bad).success).toBe(false);
  });
  it("diagnostics carry optional field/subject and stats optional scientific counts", () => {
    const d = {
      code: "block_meta_invalid",
      severity: "error",
      message: "m",
      line: 1,
      column: 2,
      field: "id",
      subject: "x",
    };
    expect(TextDiagnosticSchema.parse(d)).toEqual(d);
    expect(TextStatsSchema.parse({ sections: 1, paragraphs: 1, lists: 0 })).toEqual({
      sections: 1,
      paragraphs: 1,
      lists: 0,
    });
    expect(
      TextStatsSchema.parse({ sections: 1, paragraphs: 1, lists: 0, equations: 2, unresolved: 1 })
        .equations
    ).toBe(2);
  });
});

describe("figures, assets and tables (ticket 27)", () => {
  it("block metadata accepts figure/table kinds and a footnote", () => {
    expect(TextBlockMetaSchema.safeParse({ kind: "figure", footnote: "n" }).success).toBe(true);
    expect(TextBlockMetaSchema.safeParse({ kind: "table", caption: "c" }).success).toBe(true);
  });

  it("asset manifests stay strict and the controlled name pattern refuses paths and odd extensions", () => {
    const a = { name: "fig-0123abcd.png", sha256: "a".repeat(64), byte_length: 4 };
    expect(TextSourceAssetSchema.safeParse(a).success).toBe(true);
    expect(
      TextSourceAssetSchema.safeParse({ ...a, media_type: "image/png", width: 3, height: 2 })
        .success
    ).toBe(true);
    expect(TextSourceAssetSchema.safeParse({ ...a, media_type: "image/svg+xml" }).success).toBe(
      false
    );
    expect(TextSourceAssetSchema.safeParse({ ...a, path: "/etc" }).success).toBe(false);
    for (const ok of ["a-0123abcd.png", "x.y-1.jpg", "n.webp"])
      expect(TEXT_ASSET_NAME_PATTERN.test(ok), ok).toBe(true);
    for (const bad of [
      "../a.png",
      "a/b.png",
      ".a.png",
      "a.svg",
      "a.png.exe",
      "a\\b.png",
      "-a.png",
      "",
    ])
      expect(TEXT_ASSET_NAME_PATTERN.test(bad), bad).toBe(false);
  });

  it("table cells need positive integer spans, known fields only, and at least one row and cell", () => {
    const ok = { rows: [[{ text: "a", header: true, rowspan: 2, colspan: 3 }]] };
    expect(TextTableSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { rows: [] },
      { rows: [[]] },
      { rows: [[{ text: "a", rowspan: 0 }]] },
      { rows: [[{ text: "a", colspan: 1.5 }]] },
      { rows: [[{ text: "a", colspan: -2 }]] },
      { rows: [[{ text: "a", html: "<b>" }]] },
      { rows: [[{ text: 1 }]] },
      { rows: [[{ text: "a" }]], extra: 1 },
    ])
      expect(TextTableSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
