/**
 * Vitest port of the LaTeX-pipeline tests from `<repo>/tests/run_tests.py`
 * (the offline Python suite is the specification; one `test(...)` per Python
 * test function, same checks, same order).
 *
 * 12 of the 13 `test_latex_*` functions live here; `test_latex_arxiv_detection`
 * covers `looks_like_arxiv` / `arxiv_id`, which are infra adapters
 * (`packages/infra/src/latex/arxiv-source.ts`), and is ported next to them in
 * `packages/infra/tests/arxiv-source.test.ts`.
 *
 * The pipeline under test is core's `ingestLatex` wired to the test-local ports
 * in `tests/helpers/latex-ports.ts` (real pandoc via PATH, fixture/local
 * acquisition, placeholder rasterization). All pandoc-dependent tests are gated
 * on the binary being present, mirroring the Python suite's `HAVE_PANDOC` guard.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block, Document, ParagraphBlock } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { documentToJson } from "../src/documents/document.js";
import { iterBlocks, iterSections } from "../src/documents/traverse.js";
import { ingestLatex } from "../src/pipelines/latex/pipeline.js";
import { extractCommandAbstract } from "../src/pipelines/latex/walk.js";
import { HAVE_PANDOC, testAcquire, testPandoc } from "./helpers/latex-ports.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

/** Ingest the self-contained LaTeX fixture (no network, no assets). */
let cachedDoc: Document | undefined;
async function buildLatex(): Promise<Document> {
  if (cachedDoc !== undefined) return cachedDoc;
  const tmp = mkdtempSync(join(tmpdir(), "bibgraph-latex-test-"));
  cachedDoc = await ingestLatex(
    join(FIXTURES, "sample-latex", "sample_latex.tex"),
    { pandoc: testPandoc, acquire: testAcquire },
    {
      outRoot: tmp,
      config: { downloadAssets: false, useCache: false, requestDelay: 0 },
      writeJson: false,
    }
  );
  return cachedDoc;
}

async function ingestLatexStr(tex: string): Promise<Document> {
  const tmp = mkdtempSync(join(tmpdir(), "bibgraph-latex-syn-"));
  writeFileSync(join(tmp, "main.tex"), tex, "utf-8");
  return ingestLatex(
    join(tmp, "main.tex"),
    { pandoc: testPandoc, acquire: testAcquire },
    {
      outRoot: join(tmp, "out"),
      config: { downloadAssets: false, useCache: false, requestDelay: 0 },
      writeJson: false,
    }
  );
}

function findParagraph(doc: Document, needle: string): ParagraphBlock | undefined {
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph" && b.text.includes(needle)) return b;
  }
  return undefined;
}

function blockCitations(b: Block) {
  return "citations" in b ? (b.citations ?? []) : [];
}

function blockCrossrefs(b: Block) {
  return "crossrefs" in b ? (b.crossrefs ?? []) : [];
}

describe.skipIf(!HAVE_PANDOC)("latex pipeline (test_latex_*, pandoc-gated)", () => {
  test("structure and title", async () => {
    const doc = await buildLatex();
    expect(doc.source?.type).toBe("latex");
    expect(doc.meta?.title ?? "").toContain("Sample LaTeX Paper");
    const heads = [...iterSections(doc)].map((s) => s.heading);
    expect(heads).toContain("Abstract");
    expect(heads).toContain("Introduction");
    expect(heads).toContain("Methods");
    const nums = new Map([...iterSections(doc)].map((s) => [s.heading, s.number]));
    expect(nums.get("Introduction")).toBe("1");
    expect(nums.get("Methods")).toBe("2");
    expect(nums.get("Abstract")).toBeUndefined();
  });

  test("authoritative citation", async () => {
    const doc = await buildLatex();
    const p = findParagraph(doc, "magnitude");
    expect(p).toBeDefined();
    expect(p?.text).toContain("[[cite:ref-1]]");
    const occ = p?.citations?.[0];
    expect(occ?.via).toBe("hyperlink");
    expect(occ?.resolved).toBe(true);
    expect(occ?.raw).toContain("Smith");
    expect(occ?.raw).toContain("(2020)");
  });

  test("citation multi-key merged into one token", async () => {
    const doc = await buildLatex();
    const both = [...iterBlocks(doc)].some((b) =>
      blockCitations(b).some(
        (c) => (c.ref_ids ?? []).includes("ref-1") && (c.ref_ids ?? []).includes("ref-2")
      )
    );
    expect(both).toBe(true);
  });

  test("crossref resolution", async () => {
    const doc = await buildLatex();
    const alltext = [...iterBlocks(doc)]
      .filter((b) => b.type === "paragraph")
      .map((b) => (b as ParagraphBlock).text)
      .join(" ");
    for (const tok of ["[[xref:eq-1]]", "[[xref:fig-1]]", "[[xref:tab-1]]"]) {
      expect(alltext).toContain(tok);
    }
    const kinds = new Set(
      [...iterBlocks(doc)].flatMap((b) => blockCrossrefs(b).map((x) => `${x.kind}:${x.resolved}`))
    );
    expect(kinds.has("section:true")).toBe(true);
    expect(kinds.has("equation:true")).toBe(true);
  });

  test("equation numbering and cleanup", async () => {
    const doc = await buildLatex();
    const eqs = new Map(
      [...iterBlocks(doc)].filter((b) => b.type === "equation").map((b) => [b.id, b] as const)
    );
    expect(eqs.size).toBe(4);
    const eq1 = eqs.get("eq-1");
    expect(eq1 && "number" in eq1 ? eq1.number : undefined).toBe("1");
    // every display-math block is numbered in order — equation* included
    const eq2 = eqs.get("eq-2");
    expect(eq2 && "number" in eq2 ? eq2.number : undefined).toBe("2");
    // align numbers every row → "3–4"
    const eq3 = eqs.get("eq-3");
    expect(eq3 && "number" in eq3 ? eq3.number : undefined).toBe("3–4");
    // …and so does \[ … \]
    const eq4 = eqs.get("eq-4");
    expect(eq4 && "number" in eq4 ? eq4.number : undefined).toBe("5");
    const eq1Latex = eq1 && "latex" in eq1 ? eq1.latex : "";
    expect(eq1Latex).not.toContain("\\begin{equation}");
    expect(eq1Latex).not.toContain("\\label");
    const eq3Latex = eq3 && "latex" in eq3 ? eq3.latex : "";
    expect(eq3Latex).toContain("\\begin{aligned}");
  });

  test("\\tag overrides the number and does not advance the counter", async () => {
    const doc = await ingestLatexStr(
      "\\documentclass{article}\\usepackage{amsmath}\n\\begin{document}\n" +
        "\\section{S}\\label{sec:s}\nSee \\eqref{eq:tagged} and \\eqref{eq:after}.\n" +
        "\\begin{equation}\\label{eq:before} a=1\\end{equation}\n" +
        "\\begin{equation}\\tag{S1}\\label{eq:tagged} b=2\\end{equation}\n" +
        "\\begin{equation}\\label{eq:after} c=3\\end{equation}\n\\end{document}\n"
    );
    const eqs = [...iterBlocks(doc)].filter((b) => b.type === "equation");
    expect(eqs.map((b) => ("number" in b ? b.number : undefined))).toEqual(["1", "S1", "2"]);
    // the tag text is the display number and is stripped from the KaTeX body
    const tagged = eqs[1];
    expect(tagged && "latex" in tagged ? tagged.latex : "").not.toContain("\\tag");
    const json = documentToJson(doc);
    const crossrefs = (json.crossrefs ?? []) as Array<{ kind?: string; raw?: string }>;
    const xr = new Set(crossrefs.filter((x) => x.kind === "equation").map((x) => x.raw));
    expect(xr.has("(S1)")).toBe(true);
    expect(xr.has("(2)")).toBe(true);
  });

  test("per-row \\tag in align: tagged row shows the tag, next row continues the count", async () => {
    const doc = await ingestLatexStr(
      "\\documentclass{article}\\usepackage{amsmath}\n\\begin{document}\n" +
        "\\section{S}\\label{sec:s}\nSee \\eqref{eq:r1} and \\eqref{eq:r2}.\n" +
        "\\begin{align} a&=b \\tag{A1}\\label{eq:r1}\\\\ c&=d\\label{eq:r2}\\end{align}\n" +
        "\\begin{equation}\\label{eq:r3} e=f\\end{equation}\n\\end{document}\n"
    );
    const eqs = [...iterBlocks(doc)].filter((b) => b.type === "equation");
    // one align block covering A1 + 1, then the equation at 2
    expect(eqs.map((b) => ("number" in b ? b.number : undefined))).toEqual(["A1–1", "2"]);
    const tagged = eqs[0];
    expect(tagged && "latex" in tagged ? tagged.latex : "").not.toContain("\\tag");
    const json = documentToJson(doc);
    const crossrefs = (json.crossrefs ?? []) as Array<{ kind?: string; raw?: string }>;
    const xr = new Set(crossrefs.filter((x) => x.kind === "equation").map((x) => x.raw));
    expect(xr.has("(A1)")).toBe(true);
    expect(xr.has("(1)")).toBe(true);
  });

  test("katex cleanup", async () => {
    const doc = await buildLatex();
    const p = findParagraph(doc, "magnitude");
    const txt = p?.text ?? "";
    expect(txt).not.toContain("\\textsubscript");
    expect(txt).toContain("_{c}");
    expect(txt).toContain("M_\\odot");
    expect(txt).not.toContain("\\arcsec");
    expect(txt).not.toContain("\\ $");
    expect(txt).not.toContain("\\$");
    expect(txt).not.toContain("\\ pc");
  });

  test("references from thebibliography (.bbl path)", async () => {
    const doc = await buildLatex();
    expect(doc.references?.length).toBe(2);
    const r1 = doc.references?.[0];
    expect(r1?.year).toBe(2020);
    expect(r1?.doi).toBe("10.1051/0004-6361/200000001");
    expect(r1?.authors?.[0]).toContain("Smith");
    expect(r1?.raw).toContain("MNRAS");
  });

  test("footnote dropped, external link kept", async () => {
    const doc = await buildLatex();
    const alltext = [...iterBlocks(doc)]
      .filter((b) => b.type === "paragraph")
      .map((b) => (b as ParagraphBlock).text)
      .join(" ");
    expect(alltext).not.toContain("must be dropped");
    expect(alltext).toContain("example.org");
  });

  test("title math and literal dollar", async () => {
    const doc = await ingestLatexStr(
      "\\documentclass{article}\\usepackage{amsmath}\n" +
        "\\title{The $z>6$ Universe}\n\\begin{document}\\maketitle\n" +
        "\\section{S}\\label{sec:s}\nA gadget costs \\$5 today.\n\\end{document}\n"
    );
    expect(doc.meta?.title ?? "").toContain("$z>6$");
    const txt = [...iterBlocks(doc)]
      .filter((b) => b.type === "paragraph")
      .map((b) => (b as ParagraphBlock).text)
      .join(" ");
    expect(txt).toContain("\\char36");
  });

  test("per-row equation numbering", async () => {
    const doc = await ingestLatexStr(
      "\\documentclass{article}\\usepackage{amsmath}\n\\begin{document}\n" +
        "\\section{S}\\label{sec:s}\nSee \\eqref{eq:second} and \\eqref{eq:after}.\n" +
        "\\begin{align} a&=b\\label{eq:first}\\\\ c&=d\\label{eq:second}\\\\ " +
        "e&=f\\label{eq:third}\\end{align}\n" +
        "\\begin{equation}\\label{eq:after} g=h\\end{equation}\n\\end{document}\n"
    );
    const json = documentToJson(doc);
    const crossrefs = (json.crossrefs ?? []) as Array<{ kind?: string; raw?: string }>;
    const xr = new Set(crossrefs.filter((x) => x.kind === "equation").map((x) => x.raw));
    expect(xr.has("(2)")).toBe(true);
    expect(xr.has("(4)")).toBe(true);
  });

  test("no internal attrs in JSON", async () => {
    const doc = await buildLatex();
    const s = JSON.stringify(documentToJson(doc, true));
    expect(s).not.toContain("_inl");
    expect(s).not.toContain("_anchor_matches");
    expect(doc.references?.length).toBeGreaterThan(0);
    expect(doc.structure?.length).toBeGreaterThan(0);
  });
});

describe("latex pipeline pure helpers (no pandoc needed)", () => {
  test("abstract command extraction (A&A style)", () => {
    const raw = "\\abstract  % header comment\n  {Ctx text}\n  {Aims text}{Meth}{Res}{Concl}\n";
    const groups = extractCommandAbstract(raw);
    expect(groups.length).toBe(5);
    expect(groups[0]).toContain("Ctx text");
    expect(groups[1]).toContain("Aims text");
  });
});
