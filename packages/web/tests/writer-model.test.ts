/**
 * Stage 10 M1 — Writer model pure functions: crossref derivation + numbering
 * + generated labels, slug, heuristic LaTeX preview segmentation, lossy cell
 * conversion, and label auto-completion (plan §9).
 */

import { describe, expect, it } from "vitest";
import { CellSchema, type WriterCell } from "@argelanderspace/contracts";
import { highlightLatexToHtml } from "../src/writer/latexSource";
import {
  convertCellData,
  deriveCrossrefs,
  fileSlug,
  floatNumber,
  inlineSegs,
  latexBlocks,
  newCellId,
  newCommentId,
  newManuscriptId,
  randomLabel,
  slug,
  withEnsuredLabel,
  applyNumbering,
  type LatexBlock,
} from "../src/writer/model";
import type { WriterNumberingFacts } from "@argelanderspace/contracts";

/** Narrowing accessor: display-math blocks carry no segments. */
const segs = (b: LatexBlock) => (b.kind === "math" ? [] : b.segments);

const cell = (id: string, type: string, data: Record<string, unknown>): WriterCell =>
  CellSchema.parse({ id, type, data });

describe("ids", () => {
  it("generates prefixed 8-hex ids", () => {
    expect(newManuscriptId()).toMatch(/^m_[0-9a-f]{8}$/);
    expect(newCellId()).toMatch(/^c_[0-9a-f]{8}$/);
    expect(newCommentId()).toMatch(/^cm_[0-9a-f]{8}$/);
  });
});

describe("slug", () => {
  it("matches the prototype slug rules", () => {
    expect(slug("Additional validation")).toBe("additional-validation");
    expect(slug("  3D–Plots! ")).toBe("3d-plots");
    expect(slug("---")).toBe("section");
    expect(fileSlug("Stellar Streams in the Galactic Halo")).toBe("stellar-streams-in-the-galactic-halo");
    expect(fileSlug("")).toBe("manuscript");
  });
});

describe("latexBlocks / inlineSegs", () => {
  it("splits sections, subsections and paragraphs; hides \\label", () => {
    const blocks = latexBlocks(
      "\\section{Intro}\n\\label{sec:intro}\n\nFirst para with \\citep{Belokurov2006} and \\autoref{fig:a}.\nline two\n\n\\subsection{Sub}\n\nSecond.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["section", "para", "subsection", "para"]);
    expect(segs(blocks[0]!)).toEqual([{ kind: "text", text: "Intro" }]);
    const para = blocks[1]!;
    expect(segs(para)).toEqual([
      { kind: "text", text: "First para with " },
      { kind: "cite", text: "Belokurov2006" },
      { kind: "text", text: " and " },
      { kind: "xref", text: "fig:a" },
      { kind: "text", text: ". line two" },
    ]);
    expect(segs(blocks[3]!)).toEqual([{ kind: "text", text: "Second." }]);
  });

  it("handles a section command mid-chunk", () => {
    const blocks = latexBlocks("Lead-in text.\n\\section{Mid}");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "section"]);
  });

  it("inlineSegs segments only cite/ref commands", () => {
    expect(inlineSegs("plain \\textbf{bold} text")).toEqual([
      { kind: "text", text: "plain \\textbf{bold} text" },
    ]);
    expect(inlineSegs("see \\cite{a,b}")).toEqual([
      { kind: "text", text: "see " },
      { kind: "cite", text: "a,b" },
    ]);
  });
});

describe("deriveCrossrefs / floatNumber", () => {
  const cells = [
    cell("c_00000001", "latex", { source: "\\section{Intro}\n\\label{sec:intro}" }),
    cell("c_00000002", "figure", { caption: "Rotation curve", label: "fig:rc" }),
    cell("c_00000003", "latex", { source: "\\section{Method}" }),
    cell("c_00000004", "table", { caption: "Constraints", label: "" }),
    cell("c_00000005", "figure", { caption: "", label: "fig:b" }),
    cell("c_00000006", "code", { caption: "Likelihood", label: "lst:l" }),
    cell("c_00000007", "appendix", {}),
  ];

  it("derives numbered targets per kind, in order", () => {
    const xs = deriveCrossrefs(cells);
    expect(xs.map((x) => `${x.kind}:${x.number}`)).toEqual([
      "section:1",
      "figure:1",
      "section:2",
      "table:1",
      "figure:2",
      "code:1",
    ]);
  });

  it("keeps explicit labels; generates sec:<slug> for unlabeled sections", () => {
    const xs = deriveCrossrefs(cells);
    expect(xs[0]).toMatchObject({ label: "sec:intro", generated: false });
    expect(xs[2]).toMatchObject({ label: "sec:method", generated: true });
    expect(xs[3]).toMatchObject({ label: "", generated: false }); // table without label
  });

  it("section label binds only on the section line or the next (a chapter label is not grabbed)", () => {
    const xs = deriveCrossrefs([
      cell("c_00000050", "latex", {
        source: "\\chapter{First}\n\\label{ch:one}\n\n\\section{Intro}\n\\label{sec:intro}\n\nText.",
      }),
      cell("c_00000051", "latex", { source: "\\section{Method}\n\n\\label{sec:method}" }),
    ]);
    expect(xs[0]).toMatchObject({ label: "sec:intro", generated: false });
    // label two lines below → generated fallback, not grabbed
    expect(xs[1]).toMatchObject({ label: "sec:method", generated: true });
  });

  it("floatNumber counts same-kind cells only", () => {
    expect(floatNumber(cells, "c_00000002")).toBe(1);
    expect(floatNumber(cells, "c_00000005")).toBe(2);
    expect(floatNumber(cells, "c_00000007")).toBe(1); // appendix, own kind
  });
});

describe("convertCellData (lossy is intended)", () => {
  it("→ latex keeps the serialized source", () => {
    const fig = cell("c_00000010", "figure", { caption: "Cap", label: "fig:a", image: null, width: 80 });
    const data = convertCellData(fig, "latex");
    expect(String(data.source)).toContain("\\begin{figure}");
    expect(String(data.source)).toContain("\\caption{Cap}");
  });

  it("→ other types reset to defaults (no round-trip restore)", () => {
    const tex = cell("c_00000011", "latex", { source: "\\section{X}" });
    expect(convertCellData(tex, "figure")).toMatchObject({ caption: "", label: "", width: 80, image: null });
    expect(convertCellData(tex, "latex")).toEqual({ source: "\\section{X}" });
  });
});

describe("withEnsuredLabel", () => {
  it("appends \\label to a label-less latex cell; leaves labeled ones alone", () => {
    const bare = cell("c_00000020", "latex", { source: "\\section{X}" });
    const ensured = withEnsuredLabel(bare, "sec:x");
    expect(String((ensured.data as Record<string, unknown>).source)).toBe("\\section{X}\n\\label{sec:x}");
    const labeled = cell("c_00000021", "latex", { source: "\\section{X}\\label{sec:y}" });
    expect(withEnsuredLabel(labeled, "sec:x")).toBe(labeled);
  });

  it("fills data.label on figures/tables/code; ignores other types", () => {
    const fig = cell("c_00000022", "figure", { label: "" });
    expect((withEnsuredLabel(fig, "fig:new").data as Record<string, unknown>).label).toBe("fig:new");
    const app = cell("c_00000023", "appendix", {});
    expect(withEnsuredLabel(app, "sec:a")).toBe(app);
  });

  it("randomLabel has the prototype shape ref:<6 base36>", () => {
    expect(randomLabel()).toMatch(/^ref:[a-z0-9]{6}$/);
  });
});

describe("math rendering (2026-09-15 UI review)", () => {
  it("extracts \\begin{equation}…\\end{equation} as a KaTeX display block", () => {
    const blocks = latexBlocks("Before.\n\n\\begin{equation}\n  v_c^2 = GM/r \\label{eq:vc}\n\\end{equation}\n\nAfter.");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "math", "para"]);
    const m = blocks[1]!;
    expect(m.kind).toBe("math");
    if (m.kind === "math") expect(m.tex).toContain("v_c^2 = GM/r");
  });

  it("maps align/gather/eqnarray to KaTeX-supported environments", () => {
    const [align] = latexBlocks("\\begin{align*} a &= b \\\\ c &= d \\end{align*}");
    expect(align?.kind).toBe("math");
    if (align?.kind === "math") expect(align.tex).toBe("\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}");
    const [eqn] = latexBlocks("\\begin{eqnarray} a &=& b \\end{eqnarray}");
    if (eqn?.kind === "math") expect(eqn.tex).toContain("\\begin{aligned}");
    const [gath] = latexBlocks("\\begin{gather} x \\\\ y \\end{gather}");
    if (gath?.kind === "math") expect(gath.tex).toBe("\\begin{gathered}x \\\\ y\\end{gathered}");
  });

  it("extracts $$…$$ and \\[…\\] as display blocks", () => {
    expect(latexBlocks("$$ E=mc^2 $$")[0]).toEqual({ kind: "math", tex: "E=mc^2" });
    expect(latexBlocks("\\[ \\dot{x} = 0 \\]")[0]).toEqual({ kind: "math", tex: "\\dot{x} = 0" });
  });

  it("inlineSegs picks up $…$ and \\(…\\) but leaves \\$ currency and $$ pairs alone", () => {
    expect(inlineSegs("price \\$5 and $E=mc^2$ ok")).toEqual([
      { kind: "text", text: "price \\$5 and " },
      { kind: "math", tex: "E=mc^2" },
      { kind: "text", text: " ok" },
    ]);
    expect(inlineSegs("inline \\(\\alpha\\) math")).toEqual([
      { kind: "text", text: "inline " },
      { kind: "math", tex: "\\alpha" },
      { kind: "text", text: " math" },
    ]);
    // a lone $ never pairs; $$…$$ is display-only (handled at block level)
    expect(inlineSegs("just $5 here")).toEqual([{ kind: "text", text: "just $5 here" }]);
  });
});

describe("applyNumbering (compile-truth override, M3b)", () => {
  const cells = [
    cell("c_00000040", "latex", { source: "\\section{Intro}\n\n\\begin{equation}v=1\\end{equation}" }),
    cell("c_00000041", "latex", { source: "\\section{Method}\n\n\\begin{equation}w=2\\label{eq:w}\\end{equation}" }),
    cell("c_00000042", "figure", { caption: "F", label: "fig:f" }),
  ];
  const targets = deriveCrossrefs(cells);
  const facts: WriterNumberingFacts = {
    sections: [
      { number: "1.1", title: "Intro", cell: "c_00000040", label: "sec:intro" },
      { number: "1.2", title: "Method", cell: "c_00000041", label: null },
    ],
    equations: [
      { number: "1.1", env: "equation", cell: "c_00000040", label: "eq:v" },
      { number: "3.7", env: "equation", cell: "c_00000041", label: "eq:w" },
    ],
    labels: { "sec:intro": "1.1", "eq:w": "3.7", "eq:v": "1.1" },
  };

  it("null facts pass through unchanged", () => {
    expect(applyNumbering(targets, null)).toEqual(targets);
  });

  it("sections/equations get compiled numbers; generated labels adopted", () => {
    const out = applyNumbering(targets, facts);
    const sec0 = out.find((x) => x.kind === "section" && x.cell === "c_00000040")!;
    expect(sec0).toMatchObject({ number: "1.1", label: "sec:intro", generated: false });
    const eq0 = out.find((x) => x.kind === "equation" && x.cell === "c_00000040")!;
    expect(eq0).toMatchObject({ number: "1.1", label: "eq:v", generated: false });
    // a real label wins via aux truth (3.7 ≠ the event's row number)
    const eq1 = out.find((x) => x.kind === "equation" && x.cell === "c_00000041")!;
    expect(eq1).toMatchObject({ number: "3.7", label: "eq:w", generated: false });
    // figures untouched
    expect(out.find((x) => x.kind === "figure")).toEqual(targets.find((x) => x.kind === "figure"));
  });

  it("a compiled section whose cell has no regex target is ignored (structure follows the draft)", () => {
    const extra: WriterNumberingFacts = {
      ...facts,
      sections: [...facts.sections, { number: "9.9", title: "Ghost", cell: "c_ghost9999", label: null }],
    };
    expect(applyNumbering(targets, extra)).toHaveLength(targets.length);
  });
});

describe("equation crossref targets", () => {
  const eqCells = [
    cell("c_00000030", "latex", {
      source: "Text.\n\n\\begin{equation}\n  v_c^2 = GM/r \\label{eq:vc}\n\\end{equation}\n\n\\begin{equation*}\\dot{x}=0\\end{equation*}",
    }),
    cell("c_00000031", "latex", {
      source: "\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}",
    }),
  ];

  it("derives numbered equation targets; starred envs and $$…$$ skipped", () => {
    const xs = deriveCrossrefs(eqCells).filter((x) => x.kind === "equation");
    expect(xs.map((x) => x.number)).toEqual(["1", "2"]);
    expect(xs[0]).toMatchObject({ label: "eq:vc", generated: false, envIndex: 0, cell: "c_00000030" });
    expect(xs[1]).toMatchObject({ label: "eq:2", generated: true, envIndex: 0, cell: "c_00000031" });
  });

  it("section and equation targets coexist for one latex cell", () => {
    const xs = deriveCrossrefs([
      cell("c_00000032", "latex", { source: "\\section{M}\n\n\\begin{equation}x=1\\end{equation}" }),
    ]);
    expect(xs.map((x) => x.kind)).toEqual(["section", "equation"]);
  });

  it("withEnsuredLabel inserts the label right after the env's \\begin line", () => {
    const target = eqCells[1]!;
    const ensured = withEnsuredLabel(target, "eq:2", 0);
    const src = String((ensured.data as Record<string, unknown>).source);
    expect(src).toBe("\\begin{align}\n  \\label{eq:2}\n  a &= b \\\\\n  c &= d\n\\end{align}");
    // already-labeled env: unchanged
    expect(withEnsuredLabel(eqCells[0]!, "eq:x", 0)).toBe(eqCells[0]!);
  });

  it("inlineSegs treats \\eqref as an xref segment", () => {
    expect(inlineSegs("see \\eqref{eq:vc} now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "xref", text: "eq:vc" },
      { kind: "text", text: " now" },
    ]);
  });
});

describe("highlightLatexToHtml", () => {
  it("tokenizes comments, commands, environments, braces and math", () => {
    const html = highlightLatexToHtml("\\section{A} % note\ntext $x$ {b} \\begin{equation}\\end{equation}");
    expect(html).toContain('<span class="w-tok-cmd">\\section</span>');
    expect(html).toContain('<span class="w-tok-com">% note</span>');
    expect(html).toContain('<span class="w-tok-math">$x$</span>');
    expect(html).toContain('<span class="w-tok-brace">{</span>');
    expect(html).toContain('<span class="w-tok-env">\\begin{equation}</span>');
  });

  it("escapes HTML inside tokens and plain text", () => {
    const html = highlightLatexToHtml("a <b> & \\cmd{<i>}");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });

  it("a comment swallows the rest of the line (no command highlighting inside)", () => {
    const html = highlightLatexToHtml("% \\section{nope}\n\\section{yep}");
    expect(html).toContain('<span class="w-tok-com">% \\section{nope}</span>');
    expect(html).toContain('<span class="w-tok-cmd">\\section</span><span class="w-tok-brace">{</span>yep');
  });
});
