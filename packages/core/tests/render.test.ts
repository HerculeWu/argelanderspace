/**
 * Renderer tests (Stage 2 / MS1): `renderDocMarkdown` / `renderSectionMarkdown`
 * / `renderRefsManifest` / `renderBibManifest` against the 6 frozen golden
 * Documents (latex / pdf / html pipelines).
 *
 * The assertions are agent-perspective: the token formats an agent greps for
 * (`[cite: …]` / `[ref: …]` / `[Figure omitted | …]`), the heading structure,
 * the manifest row shapes, and determinism — not a byte-frozen snapshot (the
 * renderer is new code, not a bug-for-bug port).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Document, DocumentSchema } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import {
  type BibManifestRow,
  type RefManifestRow,
  renderBibManifest,
  renderDocMarkdown,
  renderRefsManifest,
  renderSectionMarkdown,
} from "../src/documents/render.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");

const DOC_IDS = [
  "arxiv-2501.17225", // latex
  "arxiv-2012.05220", // latex (code blocks)
  "2603.03522", // pdf (unresolved xrefs)
  "ads-1983ApJ...270..365M", // pdf (OCR)
  "962260", // html
  "aa39341-20", // html
] as const;

function loadDoc(docId: string): Document {
  const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, `${docId}.json`), "utf8"));
  return DocumentSchema.parse(raw);
}

const DOCS = new Map(DOC_IDS.map((id) => [id, loadDoc(id)]));

// --------------------------------------------------------------------------- //
// Whole-doc markdown, all 6 goldens
// --------------------------------------------------------------------------- //

describe("renderDocMarkdown (all goldens)", () => {
  test.each(DOC_IDS)("%s: no pipeline tokens survive, output is deterministic", (id) => {
    const doc = DOCS.get(id) as Document;
    const md = renderDocMarkdown(doc);
    expect(md).not.toContain("[[cite:");
    expect(md).not.toContain("[[xref:");
    expect(md).not.toContain("]]");
    expect(renderDocMarkdown(doc)).toBe(md);
    expect(md.endsWith("\n")).toBe(true);
  });

  test.each(DOC_IDS)("%s: every section heading becomes a markdown heading", (id) => {
    const doc = DOCS.get(id) as Document;
    const md = renderDocMarkdown(doc);
    for (const line of md.split("\n")) {
      if (!line.startsWith("#")) continue;
      expect(line).toMatch(/^#{1,6} \S/);
    }
    // top-level sections produce at least one level-1 heading each when headed
    // (`\n` prefix guards against substring matches; the doc starts at offset 0)
    const headed = (doc.structure ?? []).filter((s) => s.heading !== undefined);
    const padded = `\n${md}`;
    for (const s of headed) {
      const want = s.number !== undefined ? `# ${s.number} ${s.heading}` : `# ${s.heading}`;
      expect(padded).toContain(`\n${want}\n`);
    }
  });
});

// --------------------------------------------------------------------------- //
// Token conversion formats (regex-level, one latex + one pdf golden)
// --------------------------------------------------------------------------- //

describe("inline token conversion (arxiv-2501.17225, latex)", () => {
  const md = renderDocMarkdown(DOCS.get("arxiv-2501.17225") as Document);

  test("single cite: [cite: <ref-id> | <AuthorYear short>]", () => {
    expect(md).toMatch(/\[cite: ref-6 \| Bok 1934\]/);
    expect(md).toMatch(/\[cite: ref-2 \| Belokurov et al\. 2006\]/);
  });

  test("group cite: one bracket per ref, adjacent", () => {
    expect(md).toContain(
      "[cite: ref-21 | Grillmair et al. 1995][cite: ref-45 | Lehmann & Scholz 1997]"
    );
  });

  test("unresolved cite: [cite: ? | unresolved]", () => {
    expect(md).toContain("[cite: ? | unresolved]");
  });

  test("xref to figure / section resolves with kind, number, preview", () => {
    expect(md).toMatch(/\[ref: fig-1 \| figure \| number: 1 \| \$X-Y\$ plot of all/);
    expect(md).toContain("[ref: sec-3 | section | number: 2 | Data]");
  });

  test("section xref inside a table caption is converted in the manifest, plain in markdown", () => {
    // tab-1's caption carries [[xref:sec-28]]; the markdown placeholder strips
    // tokens (nested brackets would corrupt the line), the manifest expands
    const rows = renderRefsManifest(DOCS.get("arxiv-2501.17225") as Document);
    const tab1 = rows.find((r) => r.id === "tab-1");
    expect(tab1?.content).toContain("[ref: sec-28 | section | number: 5.1 |");
    expect(md).toMatch(/\[Table omitted \| id: tab-1 \| number: 1 \| caption: /);
  });

  test("figure placeholder: id, number, full caption, /images/ path", () => {
    expect(md).toContain(
      "[Figure omitted | id: fig-1 | number: 1 | caption: $X-Y$ plot of all the clusters " +
        "and their tidal tails. The Galactic centre is in the positive $X$ direction (to the " +
        "right), the Galactic rotation is towards the positive $Y$ direction (upwards), and " +
        "the Sun is at the origin. A 3D interactive display can be found in the supplementary " +
        "material of this article. | path: /images/arxiv-2501.17225/figures__All_in_one_XY__pdf.png]"
    );
  });

  test("equation: display math + [ref: …] anchor line", () => {
    expect(md).toContain(
      "$$\n\\sigma_{\\text{Dist}} = \\frac{1000\\sigma_{\\omega}}{\\omega_{2}} \\quad [pc],\n$$\n" +
        "[ref: eq-1 | equation | number: 1 | \\sigma_{\\text{Dist}} = " +
        "\\frac{1000\\sigma_{\\omega}}{\\omega_{2}} \\quad (pc),]"
    );
  });

  test("heading structure: numbered levels become # / ##", () => {
    expect(md.startsWith("# Abstract\n")).toBe(true);
    expect(md).toContain("\n# 1 Introduction\n");
    expect(md).toContain("\n## 2.1 Gaia data\n");
    expect(md).toContain("\n## 5.1 Analysis in $\\phi_1$ - $\\phi_2$ space\n");
  });

  test("lists render as markdown lists", () => {
    expect(md).toMatch(/^- We analysed 21 nearby clusters/m);
  });
});

describe("unresolved xrefs (2603.03522, pdf)", () => {
  const md = renderDocMarkdown(DOCS.get("2603.03522") as Document);

  test("[[xref:figure-3?]] → [ref: figure-3 | unresolved]", () => {
    expect(md).toContain("[ref: figure-3 | unresolved]");
    expect(md).toContain("[ref: equation-3 | unresolved]");
  });
});

describe("code blocks (arxiv-2012.05220, latex)", () => {
  const md = renderDocMarkdown(DOCS.get("arxiv-2012.05220") as Document);

  test("code renders as anchor line + fenced body", () => {
    expect(md).toContain("[ref: code-1 | code]");
    expect(md).toMatch(/```\nSELECT \n {2}source_id, ra, dec,/);
  });
});

// --------------------------------------------------------------------------- //
// renderSectionMarkdown
// --------------------------------------------------------------------------- //

describe("renderSectionMarkdown", () => {
  const doc = DOCS.get("arxiv-2501.17225") as Document;

  test("one section subtree, not the whole doc", () => {
    const md = renderSectionMarkdown(doc, "sec-2");
    expect(md).toContain("# 1 Introduction");
    expect(md).toContain("[cite: ref-6 | Bok 1934]");
    expect(md).not.toContain("# Abstract");
    expect(md).not.toContain("# 2 Data");
  });

  test("a subsection subtree includes its own children only", () => {
    const md = renderSectionMarkdown(doc, "sec-3"); // "2 Data" with child "2.1"
    expect(md).toContain("# 2 Data");
    expect(md).toContain("## 2.1 Gaia data");
    expect(md).not.toContain("# 1 Introduction");
  });

  test("unknown section id throws with the available ids", () => {
    expect(() => renderSectionMarkdown(doc, "sec-999")).toThrow(/unknown section "sec-999"/);
    expect(() => renderSectionMarkdown(doc, "sec-999")).toThrow(/sec-2/);
  });
});

// --------------------------------------------------------------------------- //
// Manifests
// --------------------------------------------------------------------------- //

const REF_KINDS = new Set(["figure", "table", "equation", "code", "algorithm", "section"]);
const REF_KEYS = new Set([
  "id",
  "kind",
  "number",
  "content",
  "short",
  "section",
  "context_before",
  "context_after",
]);

describe("renderRefsManifest (all goldens)", () => {
  test.each(DOC_IDS)("%s: row schema + full float/section coverage", (id) => {
    const doc = DOCS.get(id) as Document;
    const rows = renderRefsManifest(doc);
    let nSections = 0;
    let nFloats = 0;
    for (const row of rows) {
      expect(Object.keys(row).every((k) => REF_KEYS.has(k))).toBe(true);
      expect(typeof row.id).toBe("string");
      expect(REF_KINDS.has(row.kind)).toBe(true);
      expect(typeof row.content).toBe("string");
      expect(typeof row.short).toBe("string");
      expect(typeof row.section).toBe("string");
      if (row.number !== undefined) expect(typeof row.number).toBe("string");
      for (const c of [row.context_before, row.context_after]) {
        if (c !== undefined) {
          expect(typeof c).toBe("string");
          expect(c.length).toBeLessThanOrEqual(200);
        }
      }
      if (row.kind === "section") nSections += 1;
      else nFloats += 1;
      // JSONL-serializable
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    }
    const stats = doc.stats ?? {};
    expect(nSections).toBe(stats.n_sections);
    expect(nFloats).toBe(
      (stats.n_figures ?? 0) +
        (stats.n_tables ?? 0) +
        (stats.n_equations ?? 0) +
        (stats.n_code ?? 0) +
        (stats.n_algorithms ?? 0)
    );
  });

  test("fig-1 row: kind/number/content/short/section/context", () => {
    const rows = renderRefsManifest(DOCS.get("arxiv-2501.17225") as Document);
    const fig1 = rows.find((r) => r.id === "fig-1") as RefManifestRow;
    expect(fig1.kind).toBe("figure");
    expect(fig1.number).toBe("1");
    expect(fig1.content).toContain("$X-Y$ plot of all the clusters");
    expect(fig1.short.length).toBeLessThanOrEqual(80);
    expect(fig1.section).toBe("4:Results");
    expect(typeof fig1.context_before).toBe("string");
    expect(typeof fig1.context_after).toBe("string");
  });

  test("equation row content is the full latex; section row carries the heading", () => {
    const rows = renderRefsManifest(DOCS.get("arxiv-2501.17225") as Document);
    const eq1 = rows.find((r) => r.id === "eq-1") as RefManifestRow;
    expect(eq1.content).toBe(
      "\\sigma_{\\text{Dist}} = \\frac{1000\\sigma_{\\omega}}{\\omega_{2}} \\quad [pc],"
    );
    const sec2 = rows.find((r) => r.id === "sec-2") as RefManifestRow;
    expect(sec2).toMatchObject({
      kind: "section",
      number: "1",
      content: "Introduction",
      section: "1:Introduction",
    });
  });

  test("deterministic", () => {
    const doc = DOCS.get("2603.03522") as Document;
    expect(renderRefsManifest(doc)).toEqual(renderRefsManifest(doc));
  });
});

const BIB_KEYS = new Set([
  "id",
  "short",
  "title",
  "author",
  "year",
  "venue",
  "doi",
  "arxiv_id",
  "raw",
]);

describe("renderBibManifest (all goldens)", () => {
  test.each(DOC_IDS)("%s: one row per reference, schema exact", (id) => {
    const doc = DOCS.get(id) as Document;
    const rows = renderBibManifest(doc);
    expect(rows.length).toBe((doc.references ?? []).length);
    for (const row of rows) {
      expect(Object.keys(row).every((k) => BIB_KEYS.has(k))).toBe(true);
      expect(typeof row.id).toBe("string");
      expect(typeof row.short).toBe("string");
      expect(typeof row.raw).toBe("string");
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    }
  });

  test("ref-6 row: short/author/year/raw; absent optionals omitted", () => {
    const rows = renderBibManifest(DOCS.get("arxiv-2501.17225") as Document);
    const r6 = rows.find((r) => r.id === "ref-6") as BibManifestRow;
    expect(r6).toEqual({
      id: "ref-6",
      short: "Bok 1934",
      author: "Bok",
      year: 1934,
      raw: "Bok, B. J. 1934, Harvard College Observatory Circular, 384, 1",
    });
    expect("title" in r6).toBe(false);
  });
});
