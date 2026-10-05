import { describe, expect, it } from "vitest";
import {
  type AnnotationsFile,
  buildReaderReading,
  canonicalSegmentsText,
  copilotContextObjects,
  ObservationPageContextSchema,
  observationPage,
  PageContextSchema,
  READER_OPERATION_ACTIONS,
  READER_VIEW_ACTIONS,
  ReaderPageSchema,
  ReaderReadingSchema,
  ReaderViewActionSchema,
  readingKey,
  summarizeReaderPage,
  type TexDocIr,
  type TextDocIr,
  WsCopilotViewActionSchema,
} from "../src/index.js";

const FP = "f".repeat(64);
const VIEW = "11111111-1111-4111-8111-111111111111";

/** A document with every block kind, an atomic segment of each type, a spanned table and a unique last line. */
function ir(): TexDocIr {
  const cite = {
    type: "cite" as const,
    refs: [
      { id: "ref-1", resolved: true, short: "Bok 1934" },
      { id: "ref-2", resolved: true, short: "Lee 2020" },
    ],
    raw: "(Bok 1934; Lee 2020)",
  };
  return {
    version: 1,
    docId: "doc-a",
    title: "A Test Paper",
    nPages: 12,
    source: { type: "latex", origin: "x", main_tex: "main.tex", arxiv_id: "2601.00001" },
    meta: {
      title: "A Test Paper",
      authors: ["A. Author", "B. Author"],
      authorDetails: [
        { name: "A. Author", affiliations: [1], email: "a@example.org" },
        { name: "B. Author", affiliations: [1, 2] },
      ],
      affiliations: ["Inst One", "Inst Two"],
      email: "corresponding@example.org",
    },
    sections: [
      {
        id: "sec-0",
        level: 1,
        heading: "A Test Paper",
        blocks: [],
        children: [
          {
            id: "sec-1",
            level: 1,
            number: "1",
            heading: "Introduction",
            blocks: [
              {
                id: "p-1",
                type: "paragraph",
                segments: [
                  { type: "text", text: "Mass " },
                  { type: "math", latex: "M_\\odot" },
                  { type: "text", text: " was studied " },
                  cite,
                  { type: "text", text: " see " },
                  {
                    type: "xref",
                    target: {
                      id: "fig-1",
                      resolved: true,
                      targetType: "figure",
                      number: "1",
                    },
                  },
                  { type: "text", text: "." },
                ],
              },
              {
                id: "l-1",
                type: "list",
                ordered: true,
                items: [
                  { segments: [{ type: "text", text: "first" }] },
                  {
                    segments: [
                      { type: "text", text: "second " },
                      { type: "math", latex: "x" },
                    ],
                  },
                ],
              },
              { id: "eq-1", type: "equation", number: "1", label: "eq:m", latex: "E=mc^2" },
              {
                id: "fig-1",
                type: "figure",
                number: "1",
                label: "fig:a",
                captionSegments: [{ type: "text", text: "A figure." }],
                footnote: "fn",
                imgPath: "assets/a.png",
                imgWidth: 200,
                imgHeight: 100,
              },
              {
                id: "tab-1",
                type: "table",
                number: "1",
                captionSegments: [{ type: "text", text: "A table." }],
                tableBody:
                  '<table><tr><th colspan="2">H</th></tr><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>TABLE-LAST-CELL</td></tr></table>',
              },
              { id: "tab-2", type: "table", imgPath: "assets/t.png" },
              { id: "code-1", type: "code", lang: "python", body: "print('x')" },
              { id: "alg-1", type: "algorithm", body: "for i in range(3): pass" },
            ],
            children: [
              {
                id: "sec-1-1",
                level: 2,
                number: "1.1",
                heading: "Data",
                blocks: [
                  {
                    id: "p-last",
                    type: "paragraph",
                    segments: [{ type: "text", text: "UNIQUE-LAST-PARAGRAPH-MARKER" }],
                  },
                ],
                children: [],
              },
            ],
          },
        ],
      },
    ],
    refsManifest: [],
    bib: [
      { id: "ref-1", short: "Bok 1934", raw: "Bok, B. 1934 raw one", year: 1934 },
      { id: "ref-2", short: "Lee 2020", raw: "REFERENCE-LAST-RAW-TEXT" },
    ],
    references: [
      { id: "ref-1", raw: "Bok, B. 1934 raw one", authors: ["Bok"], year: 1934, title: "Stars" },
    ],
    citationsByBlock: { "p-1": ["ref-1", "ref-2"], "l-1": ["ref-2"] },
  };
}

const file = (annotations: AnnotationsFile["annotations"] = [], rev = 3): AnnotationsFile => ({
  version: 1,
  rev,
  content_fingerprint: FP,
  annotations,
});
const annotation = {
  id: "a_0000aaaa",
  target: {
    type: "text" as const,
    block: "p-last",
    container: { type: "content" as const },
    start: 0,
    end: 6,
    quote: "UNIQUE",
  },
  body: "  keep my bytes $x$ ",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};
const assets = [
  { imgPath: "assets/a.png", sha256: "a".repeat(64) },
  { imgPath: "assets/t.png", sha256: "b".repeat(64) },
];

describe("buildReaderReading", () => {
  const reading = buildReaderReading({ ir: ir(), file: file([annotation]), assets });

  it("carries the document's last unique paragraph, the whole table body and the whole bibliography", () => {
    const text = JSON.stringify(reading);
    expect(text).toContain("UNIQUE-LAST-PARAGRAPH-MARKER");
    expect(text).toContain("TABLE-LAST-CELL");
    expect(text).toContain('rowspan=\\"2\\"');
    expect(text).toContain("REFERENCE-LAST-RAW-TEXT");
    expect(reading.entries.at(-1)).toMatchObject({ id: "p-last" });
    expect(reading.references.map((r) => r.id)).toEqual(["ref-1", "ref-2"]);
    expect(reading.references[0]).toMatchObject({
      authors: ["Bok"],
      title: "Stars",
      short: "Bok 1934",
    });
  });

  it("keeps reading order: heading, its blocks, then its children", () => {
    expect(reading.entries.map((e) => e.id)).toEqual([
      "sec-0",
      "sec-1",
      "p-1",
      "l-1",
      "eq-1",
      "fig-1",
      "tab-1",
      "tab-2",
      "code-1",
      "alg-1",
      "sec-1-1",
      "p-last",
    ]);
    expect(reading.entries.find((e) => e.id === "sec-1-1")).toMatchObject({
      kind: "section",
      path: "A Test Paper › 1 Introduction › 1.1 Data",
    });
  });

  it("text is the canonical annotation text, so a selection's offsets index into it; atoms are marked", () => {
    const paragraph = reading.entries.find((e) => e.id === "p-1");
    if (paragraph?.kind !== "paragraph") throw new Error("paragraph expected");
    const source = ir().sections[0]?.children[0]?.blocks[0];
    if (source?.type !== "paragraph") throw new Error("paragraph expected");
    expect(paragraph.text).toBe(canonicalSegmentsText(source.segments));
    const [math, cite, xref] = paragraph.marks ?? [];
    if (!math || !cite || !xref) throw new Error("three marks expected");
    expect(paragraph.text.slice(math.start, math.end)).toBe("$M_\\odot$");
    expect(paragraph.text.slice(cite.start, cite.end)).toBe("(Bok 1934; Lee 2020)");
    expect(cite).toMatchObject({ type: "cite", refs: [{ id: "ref-1" }, { id: "ref-2" }] });
    expect(paragraph.text.slice(xref.start, xref.end)).toBe("Fig. 1");
    expect(xref).toMatchObject({ type: "xref", target: { id: "fig-1", targetType: "figure" } });
    // a text target made over the whole cite chip indexes the same characters
    const target = { start: cite.start, end: cite.end };
    expect(paragraph.text.slice(target.start, target.end)).toBe("(Bok 1934; Lee 2020)");
  });

  it("binds assets to the manifest of the same epoch and says when there is none", () => {
    const figure = reading.entries.find((e) => e.id === "fig-1");
    expect(figure).toMatchObject({
      asset: { path: "assets/a.png", sha256: "a".repeat(64), width: 200 },
    });
    const fallback = reading.entries.find((e) => e.id === "tab-2");
    expect(fallback).toMatchObject({ asset: { sha256: "b".repeat(64) } });
    const bare = buildReaderReading({ ir: ir(), file: file(), assets: [] });
    expect(bare.entries.find((e) => e.id === "fig-1")).toMatchObject({ asset: { sha256: null } });
    expect(reading.coverage.assets).toBe(2);
  });

  it("carries the current annotations with their exact bodies and the epoch they belong to", () => {
    expect(reading.annotations).toEqual([annotation]);
    expect(reading.annotations[0]?.body).toBe("  keep my bytes $x$ ");
    expect(reading.epoch).toEqual({ fingerprint: FP, annotationsRev: 3, annotations: "current" });
    expect(reading.coverage).toMatchObject({
      sections: 3,
      blocks: 9,
      references: 2,
      annotations: 1,
    });
    expect(reading.citationsByBlock).toEqual({ "p-1": ["ref-1", "ref-2"], "l-1": ["ref-2"] });
  });

  it("leaves out annotations of older content (a stale background read) and says so", () => {
    const stale = buildReaderReading({ ir: ir(), file: file([annotation]), assets, stale: true });
    expect(stale.annotations).toEqual([]);
    expect(stale.epoch.annotations).toBe("stale");
  });

  it("is deterministic and a valid reading; the format is a discriminator with no invented LaTeX metadata for other formats", () => {
    expect(JSON.stringify(buildReaderReading({ ir: ir(), file: file([annotation]), assets }))).toBe(
      JSON.stringify(reading)
    );
    expect(ReaderReadingSchema.safeParse(reading).success).toBe(true);
    // a text Doc is its own variant (ticket 29): the LaTeX fields do not pass as a text reading and the other way round
    const text = { ...reading, format: "text" };
    expect(ReaderReadingSchema.safeParse(text).success).toBe(false);
    expect(JSON.stringify(reading)).not.toContain("main_tex");
    if (reading.format !== "latex") throw new Error("a LaTeX IR builds a LaTeX reading");
    expect(reading.latex).toEqual({
      authors: ["A. Author", "B. Author"],
      authorDetails: [
        { name: "A. Author", affiliations: [1], email: "a@example.org" },
        { name: "B. Author", affiliations: [1, 2] },
      ],
      affiliations: ["Inst One", "Inst Two"],
      email: "corresponding@example.org",
      nPages: 12,
      arxivId: "2601.00001",
    });
  });
});

describe("a text Doc's reading (ticket 29)", () => {
  const textIr = (): TextDocIr => {
    const base = ir();
    return {
      ...base,
      source: { type: "text", input_version: 1, source_rev: 7, source_fingerprint: "a".repeat(64) },
      meta: { title: "A Test Paper", authors: ["A. Author"] },
    } as unknown as TextDocIr;
  };
  it("has the same entries, references and annotations as a LaTeX reading, its own metadata and no LaTeX engine fields", () => {
    const latex = buildReaderReading({ ir: ir(), file: file([annotation]), assets });
    const text = buildReaderReading({ ir: textIr(), file: file([annotation]), assets });
    expect(ReaderReadingSchema.safeParse(text).success).toBe(true);
    expect(text.format).toBe("text");
    if (text.format !== "text") throw new Error("unreachable");
    expect(text.text).toEqual({ authors: ["A. Author"], publishedSourceRev: 7 });
    expect(JSON.stringify(text)).not.toContain("main_tex");
    expect(JSON.stringify(text)).not.toContain("nPages");
    expect(text.entries).toEqual(latex.entries);
    expect(text.references).toEqual(latex.references);
    expect(text.annotations).toEqual(latex.annotations);
    expect(text.epoch).toEqual(latex.epoch);
    // the page of a text Doc's Reader is the same page with its own format, and the summary says so
    const summary = summarizeReaderPage(
      ReaderPageSchema.parse({ ...page(), format: "text", reading: text })
    );
    expect(summary.format).toBe("text");
    expect(summary.blocks).toBe(latex.coverage.blocks);
  });
  it("a text reading does not pass for a LaTeX page", () => {
    const text = buildReaderReading({ ir: textIr(), file: file(), assets });
    expect(ReaderPageSchema.safeParse({ ...page(), reading: text }).success).toBe(false);
  });
});

const page = (over: Record<string, unknown> = {}) => ({
  docId: "doc-a",
  format: "latex" as const,
  sync: { phase: "ready" as const },
  reading: buildReaderReading({ ir: ir(), file: file([annotation]), assets }),
  position: { activeSectionId: "sec-1", visibleBlockIds: ["p-1"] },
  selection: null,
  panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" as const },
  canGoBack: false,
  ...over,
});
const context = (reader: unknown, over: Record<string, unknown> = {}) => ({
  version: 1,
  viewId: VIEW,
  revision: 1,
  paneId: 1,
  view: "doc",
  otherPanes: [],
  status: "complete",
  plan: null,
  reader,
  ...over,
});

describe("ReaderPage and the page context", () => {
  it("an admitted reading makes the doc view complete; no reading never does", () => {
    expect(PageContextSchema.safeParse(context(page())).success).toBe(true);
    expect(
      PageContextSchema.safeParse(
        context(page({ sync: { phase: "syncing" }, reading: null }), { status: "complete" })
      ).success
    ).toBe(false);
    expect(
      PageContextSchema.safeParse(
        context(page({ sync: { phase: "syncing" }, reading: null }), { status: "unavailable" })
      ).success
    ).toBe(true);
    expect(PageContextSchema.safeParse(context(null, { status: "complete" })).success).toBe(false);
  });

  it("a reading belongs to a ready page only", () => {
    expect(
      ReaderPageSchema.safeParse(page({ sync: { phase: "error", reason: "read" } })).success
    ).toBe(false);
    expect(
      ReaderPageSchema.safeParse(page({ sync: { phase: "error", reason: "read" }, reading: null }))
        .success
    ).toBe(true);
  });

  it("a selection must name the epoch of the reading it is sent with; another epoch cannot be applied to this text", () => {
    const target = { ...annotation.target };
    expect(
      ReaderPageSchema.safeParse(page({ selection: { fingerprint: FP, target } })).success
    ).toBe(true);
    expect(
      ReaderPageSchema.safeParse(page({ selection: { fingerprint: "e".repeat(64), target } }))
        .success
    ).toBe(false);
    expect(
      ReaderPageSchema.safeParse(
        page({ sync: { phase: "syncing" }, reading: null, selection: { fingerprint: FP, target } })
      ).success
    ).toBe(false);
  });

  it("the summary names the Doc, the epoch and the sizes", () => {
    const summary = summarizeReaderPage(ReaderPageSchema.parse(page()));
    expect(summary).toMatchObject({
      docId: "doc-a",
      phase: "ready",
      fingerprint: FP,
      sections: 3,
      references: 2,
      annotations: 1,
      selection: false,
      activeSectionId: "sec-1",
    });
  });
});

describe("observationPage", () => {
  it("drops the reading from a later observation but stays a valid page that still says what it was", () => {
    const original = context(page({ selection: { fingerprint: FP, target: annotation.target } }));
    const parsed = PageContextSchema.parse(original);
    const light = observationPage(parsed);
    expect(JSON.stringify(light)).not.toContain("UNIQUE-LAST-PARAGRAPH-MARKER");
    expect(JSON.stringify(light).length).toBeLessThan(JSON.stringify(parsed).length / 2);
    expect(light.reader?.reading).toBeNull();
    expect(light.reader?.readingOmitted?.fingerprint).toBe(FP);
    expect(ObservationPageContextSchema.safeParse(light).success).toBe(true);
    // a view cannot publish it, and a page that carries one is not complete
    expect(PageContextSchema.safeParse(light).success).toBe(false);
    expect(PageContextSchema.safeParse({ ...light, status: "unavailable" }).success).toBe(false);
    // idempotent and a no-op for pages without a reading
    expect(observationPage(light)).toEqual(light);
    const plain = PageContextSchema.parse(context(null, { status: "unavailable" }));
    expect(observationPage(plain)).toBe(plain);
  });
});

describe("copilotContextObjects", () => {
  it("names the open work, the Reader's Doc or the plans, in that order of precedence", () => {
    expect(copilotContextObjects({ library: { selectedRefId: "w1" } })).toEqual([
      { id: "w1", rev: 0 },
    ]);
    expect(
      copilotContextObjects({ library: { selectedRefId: null }, reader: { docId: "d" } })
    ).toEqual([{ id: "d", rev: 0 }]);
    expect(
      copilotContextObjects({
        plan: { rev: 4, plans: [{ id: "p1" }], detail: { planId: "p2" } },
      })
    ).toEqual([
      { id: "p1", rev: 4 },
      { id: "p2", rev: 4 },
    ]);
    expect(copilotContextObjects({})).toEqual([]);
  });
});

describe("Reader operations", () => {
  it("accepts exactly the controls the Reader has and nothing that takes a path, URL or selector", () => {
    for (const action of [
      { action: "navigate", docId: "d", anchor: "sec-2" },
      { action: "navigate", docId: "d", anchor: "ann-a_0000aaaa" },
      { action: "jump_back", docId: "d" },
      { action: "set_panel", docId: "d", panel: "outline", collapsed: true },
      { action: "set_right_tab", docId: "d", tab: "annotations" },
      { action: "retry_sync", docId: "d" },
    ])
      expect(ReaderViewActionSchema.safeParse(action).success, action.action).toBe(true);
    for (const bad of [
      { action: "navigate", docId: "d" },
      { action: "navigate", docId: "d", anchor: "x", selector: "#a" },
      { action: "navigate", anchor: "x" },
      { action: "set_panel", docId: "d", panel: "toc", collapsed: true },
      { action: "set_right_tab", docId: "d", tab: "refs" },
      { action: "create_annotation", docId: "d" },
      { action: "scroll_to", docId: "d", y: 1 },
    ])
      expect(ReaderViewActionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("is routed to the bound view and listed", () => {
    const message = {
      type: "copilot.view-action",
      viewId: VIEW,
      actionId: "22222222-2222-4222-8222-222222222222",
      action: { action: "navigate", docId: "d", anchor: "sec-1" },
    };
    expect(WsCopilotViewActionSchema.safeParse(message).success).toBe(true);
    expect([...READER_OPERATION_ACTIONS]).toEqual([
      "read",
      "read_page_image",
      ...READER_VIEW_ACTIONS,
      "create_annotation",
      "update_annotation",
      "delete_annotation",
      "create_pdf_annotation",
      "update_pdf_annotation",
      "delete_pdf_annotation",
      "undo_pdf_annotation",
      "redo_pdf_annotation",
    ]);
    // annotation writes are business writes through the server, never views the browser is asked to run
    for (const write of ["create_annotation", "update_annotation", "delete_annotation"])
      expect(ReaderViewActionSchema.safeParse({ action: write, docId: "d" }).success).toBe(false);
  });
});

describe("observationPage holds", () => {
  const parsed = () => PageContextSchema.parse(context(page()));
  it("says the reading is in the task's context only when this Doc and fingerprint were sent with it", () => {
    const held = observationPage(parsed(), new Set([readingKey("doc-a", FP)]));
    expect(held.reader?.readingOmitted?.note).toContain("in the task's context");
    const otherEpoch = observationPage(parsed(), new Set([readingKey("doc-a", "e".repeat(64))]));
    expect(otherEpoch.reader?.readingOmitted?.note).toContain("not in the task's context");
    const otherDoc = observationPage(parsed(), new Set([readingKey("doc-b", FP)]));
    expect(otherDoc.reader?.readingOmitted?.note).toContain("not in the task's context");
    for (const light of [held, otherEpoch, otherDoc])
      expect(ObservationPageContextSchema.safeParse(light).success).toBe(true);
  });
});

describe("readingRef and the new page fields", () => {
  it("a view may reference the reading the service holds, but not alongside it or without the epoch of its selection", () => {
    const ref = { fingerprint: FP, annotationsRev: 3 };
    expect(
      PageContextSchema.safeParse(context(page({ reading: null, readingRef: ref }))).success
    ).toBe(true);
    expect(PageContextSchema.safeParse(context(page({ readingRef: ref }))).success).toBe(false);
    const target = { ...annotation.target };
    expect(
      PageContextSchema.safeParse(
        context(
          page({
            reading: null,
            readingRef: ref,
            selection: { fingerprint: "0".repeat(64), target },
          })
        )
      ).success
    ).toBe(false);
  });
  it("names the reading section by its path and the open annotation", () => {
    const withPosition = ReaderPageSchema.parse(
      page({
        position: { activeSectionId: "sec-1-1", visibleBlockIds: [] },
        openAnnotationId: "a_0000aaaa",
      })
    );
    expect(summarizeReaderPage(withPosition).activeSectionLabel).toBe(
      "A Test Paper › 1 Introduction › 1.1 Data"
    );
    expect(withPosition.openAnnotationId).toBe("a_0000aaaa");
  });
});
