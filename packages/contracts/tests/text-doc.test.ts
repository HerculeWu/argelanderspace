import { describe, expect, it } from "vitest";
import {
  DocDescriptionSchema,
  isTexDocIr,
  isTextDocIr,
  StoredDocIrSchema,
  TextDocSourceSchema,
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
