/** The Shelf entry format (shelf ticket 01): which Doc files an entry carries, and the bibliography snapshot. */
import { describe, expect, it } from "vitest";
import {
  isShelfRelativePath,
  ShelfBibliographySchema,
  shelfDocFileAllowed,
  shelfDocRequiredFiles,
} from "../src/shelf.js";

describe("shelfDocFileAllowed", () => {
  it("LaTeX: the IR and assets/, never src/ or build/", () => {
    const ok = (p: string) => shelfDocFileAllowed("latex", "arxiv-1", p);
    expect(ok("arxiv-1.json")).toBe(true);
    expect(ok("assets/fig-1.svg")).toBe(true);
    expect(ok("assets/sub/fig.png")).toBe(true);
    expect(ok("src/main.tex")).toBe(false);
    expect(ok("build/main.aux")).toBe(false);
    expect(ok("assets")).toBe(false);
    expect(ok("assets/")).toBe(false);
    expect(ok("other.json")).toBe(false);
  });

  it("PDF: metadata and the original, not the annotation sidecar or the reading position", () => {
    const ok = (p: string) => shelfDocFileAllowed("pdf", "pdf-1", p);
    expect(ok("pdf-1.json")).toBe(true);
    expect(ok("original.pdf")).toBe(true);
    expect(ok("annotations.json")).toBe(false);
    expect(ok("reading-position.json")).toBe(false);
    expect(shelfDocRequiredFiles("pdf", "pdf-1")).toEqual(["pdf-1.json", "original.pdf"]);
  });

  it("text: the source, the generated reading text and assets/", () => {
    const ok = (p: string) => shelfDocFileAllowed("text", "text-1", p);
    expect(ok("text-source.json")).toBe(true);
    expect(ok("text-1.json")).toBe(true);
    expect(ok("assets/a.webp")).toBe(true);
    expect(shelfDocRequiredFiles("text", "text-1")).toEqual(["text-source.json"]);
  });

  it("paths stay inside the Doc directory", () => {
    for (const p of [
      "",
      "/abs",
      "assets/../x",
      "assets/./x",
      "assets/.hidden",
      "assets\\x",
      "a//b",
      "assets/x\0",
    ])
      expect(isShelfRelativePath(p), p).toBe(false);
  });
});

describe("ShelfBibliographySchema", () => {
  it("keeps bibliographic fields and refuses project fields", () => {
    const bib = { title: "T", authors: ["A"], year: 2020, doi: "10.1/x", venue: "V", volume: "3" };
    expect(ShelfBibliographySchema.parse(bib)).toEqual(bib);
    for (const key of [
      "id",
      "doc_ids",
      "cite_key",
      "tags",
      "label",
      "read",
      "star",
      "note",
      "added_at",
      "origin",
      "acquisition",
    ])
      expect(ShelfBibliographySchema.safeParse({ ...bib, [key]: null }).success, key).toBe(false);
  });
});
