/**
 * Port of the `test_html_*` group from `tests/run_tests.py` (12 cases,
 * deferred from M1a): the A&A adapter end-to-end against a saved fixture page
 * (`tests/fixtures/sample_aanda.html`, copied verbatim from the Python test
 * fixtures), plus direct `renderInline` unit cases.
 *
 * The Python harness builds the doc by hand (adapter → Document →
 * `_annotate_document`) with a cache-less fetcher and
 * `download_assets=False, fetch_subpages=False`; the TS version does the same
 * through `adapterFor` + `annotateHtmlDocument`, with a fetcher port that
 * fails if anything ever calls it (nothing should) and the real-pandoc
 * mathml port from `helpers/html-ports.ts`.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block, Document, ParagraphBlock } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { applyMatches } from "../src/documents/annotate.js";
import { documentToJson } from "../src/documents/document.js";
import { iterBlocks, iterSections } from "../src/documents/traverse.js";
import { adapterFor } from "../src/pipelines/html/base.js";
import { loadHtml } from "../src/pipelines/html/dom.js";
import { renderInline } from "../src/pipelines/html/inline.js";
import { annotateHtmlDocument } from "../src/pipelines/html/pipeline.js";
import { DEFAULT_HTML_CONFIG, type HtmlPagePort } from "../src/pipelines/html/ports.js";
import { testMathml } from "./helpers/html-ports.js";

// Importing the adapter modules registers them (like the Python package init).
import "../src/pipelines/html/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const BASE_URL = "https://www.aanda.org/articles/aa/full_html/x/x.html";

/** Everything the adapter is told about fetching must stay unused here. */
const neverFetcher: HtmlPagePort = {
  get: () => Promise.reject(new Error("unit test must not fetch pages")),
  download: () => Promise.reject(new Error("unit test must not download assets")),
};

/** Python `_build_html`: parse the fixture page into an annotated Document. */
async function buildHtml(): Promise<Document> {
  const soup = loadHtml(readFileSync(join(FIXTURES, "sample_aanda.html"), "utf-8"));
  const adapter = adapterFor(BASE_URL, soup);
  if (adapter === null) throw new Error("no adapter matched the fixture page");
  const assetDir = mkdtempSync(join(tmpdir(), "html-unit-assets-"));
  const parsed = await adapter.parse(soup, {
    baseUrl: BASE_URL,
    fetcher: neverFetcher,
    mathml: testMathml,
    assetDir,
    config: {
      ...DEFAULT_HTML_CONFIG,
      downloadAssets: false,
      fetchSubpages: false,
      useCache: false,
      requestDelay: 0,
    },
  });
  const doc: Document = {
    doc_id: "x",
    source: { type: "html", path: BASE_URL, filename: "x.html", n_pages: 1 },
    meta: { title: parsed.title ?? "", html: parsed.meta },
    structure: parsed.sections,
    references: parsed.references,
  };
  annotateHtmlDocument(doc, parsed);
  return doc;
}

function findParagraph(doc: Document, needle: string): ParagraphBlock | null {
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph" && b.text.includes(needle)) return b;
  }
  return null;
}

function firstBlock(doc: Document, btype: Block["type"]): Block | null {
  for (const b of iterBlocks(doc)) {
    if (b.type === btype) return b;
  }
  return null;
}

function allParagraphText(doc: Document): string {
  const parts: string[] = [];
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph") parts.push(b.text);
  }
  return parts.join(" ");
}

/** Python `_render_inline`: render a snippet and splice the anchor tokens. */
function renderSnippet(snippet: string): string {
  const soup = loadHtml(snippet);
  const found = soup("p, span, div").first().get(0);
  // Python falls back to the whole soup; walking its children is equivalent.
  const node = found ?? soup.root().get(0)?.children ?? [];
  const { text, matches } = renderInline(node, { resolve: () => undefined });
  return applyMatches(text, matches).text;
}

// --------------------------------------------------------------------------- //

describe("html pipeline (A&A fixture page)", () => {
  test("test_html_adapter_selected", () => {
    const soup = loadHtml("<html></html>");
    const a = adapterFor("https://www.aanda.org/articles/aa/full_html/x/x.html", soup);
    expect(a?.name).toBe("aanda");
  });

  test("test_html_structure_and_title", async () => {
    const doc = await buildHtml();
    expect(doc.meta?.title).toBe("A Sample A&A Paper - I. Testing the HTML pipeline");
    const headings = [...iterSections(doc)].map((s) => s.heading);
    expect(headings).toContain("Introduction");
    expect(headings).toContain("Results");
    expect(headings).toContain("Acknowledgments");
    // title/subtitle are NOT sections; References/All Figures galleries excluded
    expect(headings).not.toContain("A Sample A&A Paper");
    expect(headings.some((h) => h?.includes("All Figures"))).toBe(false);
    expect(headings).toContain("Abstract");
  });

  test("test_html_abstract_multipart", async () => {
    const doc = await buildHtml();
    const sec = [...iterSections(doc)].find((s) => s.heading === "Abstract");
    expect(sec).toBeDefined();
    const text = (sec?.blocks ?? [])
      .filter((b) => b.type === "paragraph")
      .map((b) => (b as ParagraphBlock).text)
      .join(" ");
    for (const part of ["Context.", "Aims.", "Methods.", "Results.", "Conclusions."]) {
      expect(text, `abstract missing ${part}`).toContain(part);
    }
    // affiliation / received / keywords must NOT bleed into the abstract
    expect(text).not.toContain("Received");
    expect(text).not.toContain("Key words");
    expect(text).not.toContain("Some Institute");
    expect((sec?.blocks ?? []).length).toBeGreaterThanOrEqual(5);
    // front-matter copyright line between header and first section is dropped
    expect(allParagraphText(doc)).not.toContain("ESO 2020");
  });

  test("test_html_authoritative_citation", async () => {
    const doc = await buildHtml();
    const p = findParagraph(doc, "magnitude");
    expect(p).not.toBeNull();
    expect(p?.text).toContain("[[cite:ref-1]]");
    const occ = p?.citations?.[0];
    expect(occ?.via).toBe("hyperlink");
    expect(occ?.resolved).toBe(true);
    expect(occ?.ref_ids).toEqual(["ref-1"]);
  });

  test("test_html_crossref_resolution", async () => {
    const doc = await buildHtml();
    const text = allParagraphText(doc);
    expect(text).toContain("[[xref:fig-1]]");
    expect(text).toContain("[[xref:eq-1]]");
    expect(text).toContain("[[xref:tab-1]]");
    // an unlinked "Sect. 1" still resolves via the regex fallback + XrefIndex
    const kinds = new Set<string>();
    for (const b of iterBlocks(doc)) {
      if (b.type === "paragraph") {
        for (const x of b.crossrefs ?? []) kinds.add(`${x.kind}:${x.resolved}`);
      }
    }
    expect(kinds.has("section:true")).toBe(true);
  });

  test("test_html_inline_math_conservative", async () => {
    const doc = await buildHtml();
    const p = findParagraph(doc, "magnitude");
    // single-letter var + sub -> $G_{\mathrm{BP}}$ ; prose italic 'Gaia' stays plain
    expect(p?.text).toContain("$G_{\\mathrm{BP}}$");
    expect(p?.text).toContain("Gaia");
    expect(p?.text).not.toContain("$Gaia$");
    // footnote marker dropped (no stray superscript '1' glued to the word)
    expect(p?.text).toContain("matters for");
    // unit superscript yr^{-1} (in the post-equation paragraph)
    expect(allParagraphText(doc)).toContain("\\mathrm{yr}^{-1}");
  });

  test("test_html_equation_split_from_prose", async () => {
    const doc = await buildHtml();
    const eq = firstBlock(doc, "equation");
    expect(eq).not.toBeNull();
    expect(eq && "latex" in eq ? eq.latex : "").toContain("mc^");
    expect(eq && "number" in eq ? eq.number : undefined).toBe("1");
    // the prose around the embedded equation is preserved as paragraphs
    expect(
      findParagraph(doc, "The energy is") !== null || findParagraph(doc, "as in") !== null
    ).toBe(true);
  });

  test("test_html_reference_parse", async () => {
    const doc = await buildHtml();
    expect(doc.references?.length).toBe(1);
    const r = doc.references?.[0];
    expect(r?.id).toBe("ref-1");
    expect(r?.year).toBe(2020);
    expect(r?.doi).toBe("10.1051/0004-6361/200000002");
    expect(r?.venue).toBe("A&A");
    expect(r?.volume).toBe("600");
    expect(r?.pages).toBe("A1");
    expect(r?.authors ?? []).toContain("Smith");
  });

  test("test_html_figure_and_table_floats", async () => {
    const doc = await buildHtml();
    const fig = firstBlock(doc, "figure");
    expect(fig && "number" in fig ? fig.number : undefined).toBe("1");
    expect(fig && "caption" in fig ? fig.caption?.text : undefined).toContain(
      "test figure caption"
    );
    const tab = firstBlock(doc, "table");
    expect(tab && "number" in tab ? tab.number : undefined).toBe("1");
  });

  test("test_html_no_internal_attrs_in_json", async () => {
    const doc = await buildHtml();
    const blob = JSON.stringify(documentToJson(doc, true));
    expect(blob).not.toContain("_anchor_matches");
    const stats = (documentToJson(doc, true) as { stats?: Record<string, number> }).stats;
    expect(stats?.n_citations_resolved).toBe(stats?.n_citations);
  });
});

describe("renderInline (direct snippet cases)", () => {
  test("test_html_inline_subsup_word_boundary", () => {
    // mid-word sub/sup must NOT be mathified (would mangle prose)
    expect(renderSnippet("<p>value<sub>2</sub>here</p>")).toBe("value2here");
    expect(renderSnippet("<p>equation<sub>10</sub>e done</p>")).toBe("equation10e done");
    // at a word boundary, a unit exponent IS valid math
    expect(renderSnippet("<p>0.3 mas yr<sup>&#8722;1</sup> total</p>")).toContain(
      "$\\mathrm{yr}^{-1}$"
    );
    expect(renderSnippet("<p>about 10<sup>4</sup> stars</p>")).toContain("$10^{4}$");
  });

  test("test_html_inline_variable_base", () => {
    // an explicit single-letter italic variable is a math base even before text
    expect(renderSnippet("<p><i>G</i><sub>BP</sub> band</p>")).toContain("$G_{\\mathrm{BP}}$");
    // variant Greek glyph (lunate epsilon U+03F5) is recognised as a variable
    const out = renderSnippet("<p><i>ϵ</i><sub>ACG</sub> value</p>");
    expect(out).toContain("$\\epsilon_{\\mathrm{ACG}}$");
    expect(out.replace("$\\epsilon_{\\mathrm{ACG}}$", "")).not.toContain("\\mathrm{ACG}");
  });
});
