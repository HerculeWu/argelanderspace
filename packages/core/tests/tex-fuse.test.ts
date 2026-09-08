/**
 * Fuse-layer tests (Stage 5 MS2, `src/pipelines/tex/fuse/` + `ir.ts`).
 *
 * Frozen-artifact suites (battery/minimal/hyperref builds from MS1) run the
 * full source→IR path compiler-free via `fuseTexDoc`. Synthetic suites drive
 * `loadTexSourceTree` + `buildTexDocIr` on hand-written sources with
 * hand-made facts (tmp dirs, no compiler, no network).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrBlock, IrSection, TexDocIr } from "@argelanderspace/contracts";
import { TexDocIrSchema } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import type { TexCitationEvent, TexMathnumEvent } from "../src/pipelines/tex/facts/events.js";
import type { TexFacts } from "../src/pipelines/tex/facts/index.js";
import { buildTexDocIr } from "../src/pipelines/tex/ir.js";
import { fuseTexDoc } from "../src/pipelines/tex/pipeline.js";
import { loadTexSourceTree } from "../src/pipelines/tex/source/tree.js";

const FX = fileURLToPath(new URL("fixtures/tex", import.meta.url));

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function* walkBlocks(sections: IrSection[]): Generator<IrBlock> {
  for (const s of sections) {
    yield* s.blocks;
    yield* walkBlocks(s.children);
  }
}

function allSections(sections: IrSection[]): IrSection[] {
  const out: IrSection[] = [];
  const walk = (list: IrSection[]): void => {
    for (const s of list) {
      out.push(s);
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

function equations(ir: TexDocIr): { id: string; number?: string; label?: string }[] {
  return [...walkBlocks(ir.sections)]
    .filter((b) => b.type === "equation")
    .map((b) => {
      const out: { id: string; number?: string; label?: string } = { id: b.id };
      if (b.type === "equation") {
        if (b.number !== undefined) out.number = b.number;
        if (b.label !== undefined) out.label = b.label;
      }
      return out;
    });
}

function xrefRaws(ir: TexDocIr): { raw: string; id: string; resolved: boolean }[] {
  const out: { raw: string; id: string; resolved: boolean }[] = [];
  for (const b of walkBlocks(ir.sections)) {
    const segs =
      b.type === "paragraph"
        ? b.segments
        : b.type === "list"
          ? b.items.flatMap((i) => i.segments)
          : [];
    for (const s of segs) {
      if (s.type === "xref") {
        out.push({ raw: s.raw ?? "", id: s.target.id, resolved: s.target.resolved });
      }
    }
  }
  return out;
}

function emptyFacts(overrides: Partial<TexFacts> = {}): TexFacts {
  return {
    labels: {},
    citations: [],
    bibcites: {},
    toc: [],
    lof: [],
    lot: [],
    inputs: [],
    references: [],
    events: [],
    warnings: [],
    ...overrides,
  };
}

function mathnum(id: number, env: string, number: string, line = 1): TexMathnumEvent {
  return {
    type: "mathnum",
    id: `math-${String(id).padStart(6, "0")}`,
    env,
    number,
    line,
    page: "1",
  };
}

/** Write a main.tex into a tmp dir and return the fuse input shell. */
function tmpSource(
  main: string,
  extra: Record<string, string> = {}
): { srcDir: string; mainTex: string } {
  const srcDir = mkdtempSync(join(tmpdir(), "tex-fuse-"));
  writeFileSync(join(srcDir, "main.tex"), main);
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(srcDir, name), content);
  }
  return { srcDir, mainTex: join(srcDir, "main.tex") };
}

async function fuseSynthetic(
  main: string,
  facts: TexFacts,
  opts: { eventsAvailable?: boolean } = {}
) {
  const { srcDir, mainTex } = tmpSource(main);
  const tree = loadTexSourceTree({ srcDir, mainTex });
  return buildTexDocIr({
    tree,
    facts,
    docId: "synthetic",
    source: { type: "latex", origin: "synthetic", main_tex: "main.tex" },
    eventsAvailable: opts.eventsAvailable ?? facts.events.length > 0,
    srcDir,
  });
}

// --------------------------------------------------------------------------- //
// Frozen battery (amsmath + natbib + bibtex + figure + \input child)
// --------------------------------------------------------------------------- //

describe("fuse frozen battery build", () => {
  let ir: TexDocIr;
  let warnings: string[];
  test("builds", async () => {
    const r = await fuseTexDoc({
      srcDir: `${FX}/battery`,
      mainTex: `${FX}/battery/main.tex`,
      docId: "battery",
      origin: "fixture",
      factFiles: {
        aux: `${FX}/battery/build/main.aux`,
        bbl: `${FX}/battery/build/main.bbl`,
        toc: `${FX}/battery/build/main.toc`,
        fls: `${FX}/battery/build/main.fls`,
        events: `${FX}/battery/build/main.argelander.jsonl`,
      },
    });
    ir = r.ir;
    warnings = r.warnings;
    expect(TexDocIrSchema.safeParse(ir).success).toBe(true);
    expect(warnings).toEqual([]);
  }, 60_000);

  test("sections with print numbers", () => {
    const secs = allSections(ir.sections);
    expect(secs.map((s) => [s.number, s.heading])).toEqual([
      ["1", "Introduction"],
      ["1.1", "Background"],
      ["2", "Math battery"],
    ]);
    expect(secs[1]?.id).toBe("sec-2");
    // subsections nest under their section
    expect(ir.sections[0]?.children.map((s) => s.id)).toEqual(["sec-2"]);
  });

  test("print-faithful equation numbers (mathnum events)", () => {
    expect(equations(ir)).toEqual([
      { id: "eq-1", number: "1", label: "eq:a" },
      { id: "eq-2", number: "2" }, // unlabeled: mathnum covers it
      { id: "eq-3", number: "A1" }, // \tag{A1}
      { id: "eq-4", number: "3,X", label: "eq:al1" }, // align rows: 3, \nonumber, \tag{X}
      { id: "eq-5", number: "4–5" }, // gather range
      { id: "eq-6", number: "6" }, // multline
      { id: "eq-7", number: "7–8" }, // eqnarray
      { id: "eq-8" }, // \[ …\]: unnumbered → NO number (Q2)
      { id: "eq-9" }, // align*: no number
      { id: "eq-10", number: "9" }, // in the \input child file
    ]);
  });

  test("xrefs resolve to true numbers with previews/headings", () => {
    const xrefs = xrefRaws(ir);
    expect(xrefs).toEqual([
      { raw: "(1)", id: "eq-1", resolved: true },
      { raw: "(3)", id: "eq-4", resolved: true }, // row-level number, not the range
      { raw: "2", id: "sec-3", resolved: true },
    ]);
  });

  test("cite segments resolve keys → ref-N with short labels", () => {
    const p = ir.sections[0]?.blocks[0];
    expect(p?.type).toBe("paragraph");
    if (p?.type !== "paragraph") return;
    const cites = p.segments.filter((s) => s.type === "cite");
    expect(cites).toHaveLength(4);
    expect(cites[0]).toMatchObject({ refs: [{ id: "ref-2", resolved: true }] });
    expect(cites[2]).toMatchObject({ refs: [{ id: "ref-1", resolved: true }] });
    // citationsByBlock for the right panel
    expect(ir.citationsByBlock["p-1"]).toEqual(["ref-2", "ref-3", "ref-1"]);
  });

  test("figure block: number + caption (battery figure draws a \\rule, no image)", () => {
    const fig = [...walkBlocks(ir.sections)].find((b) => b.type === "figure");
    expect(fig).toMatchObject({ id: "fig-1", type: "figure", number: "1", label: "Figure 1" });
    if (fig?.type === "figure") {
      expect(fig.captionSegments?.[0]).toMatchObject({
        type: "text",
        text: "A placeholder figure",
      });
      expect(fig.imgPath).toBeUndefined();
    }
  });

  test("manifests + identity", () => {
    expect(ir.title).toBe("Stage 5 Fixture Battery");
    expect(ir.meta.authors).toEqual(["ArgelanderSpace"]);
    expect(ir.version).toBe(1);
    expect(ir.source).toMatchObject({ type: "latex", origin: "fixture", main_tex: "main.tex" });
    expect(ir.bib).toHaveLength(3);
    expect(ir.bib.map((b) => b.id)).toEqual(["ref-1", "ref-2", "ref-3"]);
    const manifestKinds = ir.refsManifest.map((r) => r.kind);
    expect(manifestKinds).toContain("section");
    expect(manifestKinds).toContain("equation");
    expect(manifestKinds).toContain("figure");
    // section rows carry print numbers
    expect(ir.refsManifest.find((r) => r.id === "sec-3")).toMatchObject({
      number: "2",
      content: "Math battery",
    });
  });
});

// --------------------------------------------------------------------------- //
// Frozen hyperref (hyperref + amsmath + \tag + inline thebibliography)
// --------------------------------------------------------------------------- //

describe("fuse frozen hyperref build", () => {
  let ir: TexDocIr;
  let warnings: string[];
  test("builds", async () => {
    const r = await fuseTexDoc({
      srcDir: `${FX}/hyperref`,
      mainTex: `${FX}/hyperref/main.tex`,
      docId: "hyperref",
      origin: "fixture",
      factFiles: {
        aux: `${FX}/hyperref/build/main.aux`,
        fls: `${FX}/hyperref/build/main.fls`,
        events: `${FX}/hyperref/build/main.argelander.jsonl`,
      },
    });
    ir = r.ir;
    warnings = r.warnings;
    expect(TexDocIrSchema.safeParse(ir).success).toBe(true);
  }, 60_000);

  test("print-faithful numbers incl. \\tag{B} and subequations", () => {
    expect(equations(ir)).toEqual([
      { id: "eq-1", number: "1", label: "eq:one" },
      { id: "eq-2", number: "B" }, // \tag{B}, counter not advanced
      { id: "eq-3", number: "2", label: "eq:two" },
      { id: "eq-4" }, // align all-\nonumber: no number
      { id: "eq-5", number: "3a", label: "eq:sub-a" },
      { id: "eq-6", number: "3b" },
      { id: "eq-7", number: "4", label: "eq:aligned" },
      { id: "eq-8", number: "T1", label: "eq:tagged" }, // labeled \tag: aux "{T1}" brace-stripped
    ]);
    expect(warnings).toEqual([]);
  });

  test("labeled tag xref uses the printed tag text", () => {
    const raws = xrefRaws(ir);
    expect(raws).toContainEqual({ raw: "(T1)", id: "eq-8", resolved: true });
    expect(raws).toContainEqual({ raw: "(1)", id: "eq-1", resolved: true });
  });

  test("inline thebibliography fallback resolves cites", () => {
    expect(ir.references?.map((r) => r.id)).toEqual(["ref-1", "ref-2"]);
    const cites = [...walkBlocks(ir.sections)].flatMap((b) =>
      b.type === "paragraph" ? b.segments.filter((s) => s.type === "cite") : []
    );
    expect(cites.length).toBeGreaterThan(0);
    expect(cites.every((c) => c.type === "cite" && c.refs.every((r) => r.resolved))).toBe(true);
  });

  test("section heading with macros is plain text (math kept as $…$)", () => {
    expect(ir.sections[0]?.heading).toBe("Adversarial Math & $x^{2}$ Cases");
  });
});

// --------------------------------------------------------------------------- //
// Frozen minimal (kernel adapters, twocolumn, inline bibliography)
// --------------------------------------------------------------------------- //

describe("fuse frozen minimal build (kernel paths)", () => {
  test("kernel cite/label/mathnum + inline refs", async () => {
    const r = await fuseTexDoc({
      srcDir: `${FX}/minimal`,
      mainTex: `${FX}/minimal/main.tex`,
      docId: "minimal",
      origin: "fixture",
      factFiles: {
        aux: `${FX}/minimal/build/main.aux`,
        fls: `${FX}/minimal/build/main.fls`,
        events: `${FX}/minimal/build/main.argelander.jsonl`,
      },
    });
    expect(TexDocIrSchema.safeParse(r.ir).success).toBe(true);
    expect(equations(r.ir)).toEqual([
      { id: "eq-1", number: "1", label: "eq:k" },
      { id: "eq-2", number: "2" },
      { id: "eq-3", number: "3" },
      { id: "eq-4" },
    ]);
    expect(r.ir.sections[0]?.number).toBe("1");
    expect(r.ir.references).toHaveLength(1);
    expect(r.ir.citationsByBlock["p-1"]).toEqual(["ref-1"]);
  }, 60_000);
});

// --------------------------------------------------------------------------- //
// Synthetic sources (degraded mode, dedupe, backstop, tables, abstract, …)
// --------------------------------------------------------------------------- //

describe("fuse synthetic sources", () => {
  test("degraded mode (no events): aux for labeled, counting for the rest + warning", async () => {
    const { ir, warnings } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{One}\\label{sec:o}",
        "Text.",
        "\\begin{equation}\\label{eq:l} a=1 \\end{equation}",
        "\\begin{equation} b=2 \\end{equation}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts({
        labels: { "sec:o": { number: "7", page: "1" }, "eq:l": { number: "41", page: "1" } },
      }),
      { eventsAvailable: false }
    );
    expect(ir.sections[0]?.number).toBe("7"); // aux
    expect(equations(ir)).toEqual([
      { id: "eq-1", number: "41", label: "eq:l" }, // aux resync
      { id: "eq-2", number: "42" }, // counting continues from the resync
    ]);
    expect(
      warnings.some((w) => w.includes("no event stream") || w.includes("no instrumentation"))
    ).toBe(true);
  });

  test("\\tag* prints its tag (from source, no event consumed)", async () => {
    const { ir, warnings } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
        "\\begin{equation} a=1 \\tag*{S} \\end{equation}",
        "\\begin{equation} b=2 \\end{equation}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts({ events: [mathnum(1, "equation", "5", 5)] })
    );
    expect(equations(ir)).toEqual([
      { id: "eq-1", number: "S" }, // source tag text
      { id: "eq-2", number: "5" }, // the event joined the second equation
    ]);
    expect(warnings).toEqual([]);
  });

  test("unnumbered displays get no number even in degraded mode (Q2)", async () => {
    const { ir } = await fuseSynthetic(
      "\\documentclass{article}\n\\begin{document}\n\\[ x=1 \\]\n\\end{document}",
      emptyFacts(),
      { eventsAvailable: false }
    );
    expect(equations(ir)).toEqual([{ id: "eq-1" }]);
  });

  test("abstract env → synthetic first section", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{abstract}",
        "We show things.",
        "\\end{abstract}",
        "\\section{Body}",
        "Text.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    expect(ir.sections[0]).toMatchObject({ level: 1, heading: "Abstract" });
    expect(ir.sections[0]?.number).toBeUndefined();
    expect(ir.sections[1]?.heading).toBe("Body");
  });

  test("aa.cls 5-group \\abstract gets Context/Aims/… labels", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\abstract{Context text.}{Aims text.}{Methods text.}{Results text.}{Conclusions text.}",
        "\\section{Body}",
        "Text.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const abs = ir.sections[0];
    expect(abs?.heading).toBe("Abstract");
    const texts = abs?.blocks.map((b) =>
      b.type === "paragraph"
        ? b.segments.map((s) => (s.type === "text" ? s.text : "")).join("")
        : ""
    );
    expect(texts?.[0]).toContain("Context. Context text.");
    expect(texts?.[4]).toContain("Conclusions. Conclusions text.");
  });

  test("itemize/enumerate → list blocks", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{itemize}",
        "\\item First $x^2$",
        "\\item Second",
        "\\end{itemize}",
        "\\begin{enumerate}",
        "\\item One",
        "\\end{enumerate}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const lists = [...walkBlocks(ir.sections)].filter((b) => b.type === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ type: "list", ordered: false });
    expect(lists[1]).toMatchObject({ type: "list", ordered: true });
    if (lists[0]?.type === "list") {
      expect(lists[0].items).toHaveLength(2);
      expect(lists[0].items[0]?.segments.some((s) => s.type === "math")).toBe(true);
    }
  });

  test("plain table env keeps its caption (B1 regression)", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{table}",
        "\\caption{Pole and origin data}\\label{tab:pole}",
        "\\begin{tabular}{lc}",
        "\\hline",
        "A & 1 \\\\",
        "\\hline",
        "B & 2 \\\\",
        "\\hline",
        "\\end{tabular}",
        "\\end{table}",
        "Text \\ref{tab:pole}.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const tab = [...walkBlocks(ir.sections)].find((b) => b.type === "table");
    if (tab?.type !== "table") throw new Error("no table block");
    expect(tab.number).toBe("1");
    expect(tab.captionSegments?.map((s) => (s.type === "text" ? s.text : "")).join("")).toContain(
      "Pole and origin data"
    );
    expect(tab.tableBody).toContain("<th>");
    expect(xrefRaws(ir)).toContainEqual({ raw: "1", id: "tab-1", resolved: true });
  });

  test("center-wrapped tabular produces a non-empty tableBody (B2 regression)", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{table}",
        "\\caption{Wrapped}",
        "\\begin{center}",
        "\\begin{tabular}{ll}",
        "a & b \\\\",
        "c & d",
        "\\end{tabular}",
        "\\end{center}",
        "\\end{table}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const tab = [...walkBlocks(ir.sections)].find((b) => b.type === "table");
    if (tab?.type !== "table") throw new Error("no table block");
    expect(tab.tableBody).toBe(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
    );
    expect(tab.captionSegments?.[0]).toMatchObject({ type: "text", text: "Wrapped" });
  });

  test("comment-env content is discarded entirely (B3 regression)", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "Kept text.",
        "\\begin{comment}",
        "DELETED \\cite{ghost} text with \\begin{table}\\caption{Ghost}\\end{table}",
        "\\end{comment}",
        "More kept.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const blocks = [...walkBlocks(ir.sections)];
    expect(blocks.some((b) => b.type === "code")).toBe(false);
    expect(blocks.some((b) => b.type === "table")).toBe(false);
    const text = blocks
      .flatMap((b) => (b.type === "paragraph" ? b.segments : []))
      .map((s) => (s.type === "text" ? s.text : ""))
      .join("|");
    expect(text).not.toContain("DELETED");
    expect(text).toContain("Kept text.");
    expect(text).toContain("More kept.");
  });

  test("deluxetable → table block with caption + label + th/td body + trailing paragraphs", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{deluxetable}{lcc}",
        "\\tablecaption{Cluster parameters \\label{tab:clusters}}",
        "\\tablehead{\\colhead{Name} & \\colhead{Mass} & \\colhead{Radius}}",
        "\\startdata",
        "A & 1 & 2 \\\\",
        "B & 3 & 4",
        "\\enddata",
        "\\tablecomments{A note.}",
        "\\end{deluxetable}",
        "After.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const tab = [...walkBlocks(ir.sections)].find((b) => b.type === "table");
    expect(tab).toBeDefined();
    if (tab?.type !== "table") return;
    expect(tab.number).toBe("1");
    expect(tab.captionSegments?.map((s) => (s.type === "text" ? s.text : "")).join("")).toContain(
      "Cluster parameters"
    );
    expect(tab.tableBody).toBe(
      "<table><tr><th>Name</th><th>Mass</th><th>Radius</th></tr>" +
        "<tr><td>A</td><td>1</td><td>2</td></tr><tr><td>B</td><td>3</td><td>4</td></tr></table>"
    );
    // trailing \tablecomments became a paragraph after the table
    const last = [...walkBlocks(ir.sections)].at(-1);
    expect(last?.type).toBe("paragraph");
  });

  test("deluxetable label is xref-resolvable", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{deluxetable}{l}",
        "\\tablecaption{T}\\label{tab:t}",
        "\\tablehead{\\colhead{A}}",
        "\\startdata",
        "x",
        "\\enddata",
        "\\end{deluxetable}",
        "See Table~\\ref{tab:t}.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    expect(xrefRaws(ir)).toEqual([{ raw: "1", id: "tab-1", resolved: true }]);
  });

  test("plain tabular: hline-header heuristic + \\multicolumn colspan", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{table}",
        "\\caption{Params}\\label{tab:p}",
        "\\begin{tabular}{lcc}",
        "\\hline",
        "Name & Mass & Radius \\\\",
        "\\hline",
        "\\multicolumn{2}{c}{A} & 2 \\\\",
        "B & 3 & 4 \\\\",
        "\\hline",
        "\\end{tabular}",
        "\\end{table}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const tab = [...walkBlocks(ir.sections)].find((b) => b.type === "table");
    if (tab?.type !== "table") throw new Error("no table");
    expect(tab.number).toBe("1");
    expect(tab.tableBody).toBe(
      "<table><tr><th>Name</th><th>Mass</th><th>Radius</th></tr>" +
        '<tr><td colspan="2">A</td><td>2</td></tr>' +
        "<tr><td>B</td><td>3</td><td>4</td></tr></table>"
    );
  });

  test("moving-arg cite double-fire is deduped by source-line content", async () => {
    const main = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{S}",
      "\\begin{figure}",
      "\\caption{Result from \\cite{knuth1984texbook}}",
      "\\end{figure}",
      "\\end{document}",
    ].join("\n");
    const genuine: TexCitationEvent = {
      type: "citation",
      id: "cite-000002",
      keys: ["knuth1984texbook"],
      file: "main.tex",
      line: 5,
      page: "1",
    };
    const dup: TexCitationEvent = {
      type: "citation",
      id: "cite-000001",
      keys: ["knuth1984texbook"],
      file: "main.tex",
      line: 1, // points at \documentclass — the .lof re-typeset
      page: "1",
    };
    const { warnings, ir } = await fuseSynthetic(
      main,
      emptyFacts({
        events: [genuine, dup],
        references: [{ key: "knuth1984texbook", raw: "Knuth. The TeXbook. 1984" }],
      })
    );
    expect(warnings.some((w) => w.includes("dropped 1 generated-file duplicate"))).toBe(true);
    // the caption cite segment exists once, resolved
    const fig = [...walkBlocks(ir.sections)].find((b) => b.type === "figure");
    if (fig?.type !== "figure") throw new Error("no figure");
    const cites = (fig.captionSegments ?? []).filter((s) => s.type === "cite");
    expect(cites).toHaveLength(1);
    expect(ir.citationsByBlock["fig-1"]).toEqual(["ref-1"]);
  });

  test("macro-hidden citation backstop (unexpandable macro)", async () => {
    const main = [
      "\\documentclass{article}",
      "\\newcommand{\\mcite}[1]{\\ifx\\relax#1\\relax\\citep{x}\\else\\citep{#1}\\fi}",
      "\\begin{document}",
      "\\section{S}",
      "Hidden cite here: \\mcite{knuth1984texbook}.",
      "\\end{document}",
    ].join("\n");
    const ev: TexCitationEvent = {
      type: "citation",
      id: "cite-000001",
      keys: ["knuth1984texbook"],
      file: "main.tex",
      line: 5,
      page: "1",
    };
    const { warnings, ir } = await fuseSynthetic(
      main,
      emptyFacts({
        events: [ev],
        references: [{ key: "knuth1984texbook", raw: "Knuth. The TeXbook. 1984" }],
      })
    );
    expect(warnings.some((w) => w.includes("backstopped"))).toBe(true);
    expect(ir.citationsByBlock["p-1"]).toEqual(["ref-1"]);
  });

  test("macro expansion surfaces a \\cite as a real segment (not backstop)", async () => {
    const main = [
      "\\documentclass{article}",
      "\\newcommand{\\mcite}[1]{\\citep{#1}}",
      "\\begin{document}",
      "\\section{S}",
      "Expanded cite: \\mcite{knuth1984texbook}.",
      "\\end{document}",
    ].join("\n");
    const ev: TexCitationEvent = {
      type: "citation",
      id: "cite-000001",
      keys: ["knuth1984texbook"],
      file: "main.tex",
      line: 5,
      page: "1",
    };
    const { warnings, ir } = await fuseSynthetic(
      main,
      emptyFacts({
        events: [ev],
        references: [{ key: "knuth1984texbook", raw: "Knuth. The TeXbook. 1984" }],
      })
    );
    expect(warnings).toEqual([]);
    const p = [...walkBlocks(ir.sections)].find((b) => b.type === "paragraph");
    if (p?.type !== "paragraph") throw new Error("no paragraph");
    const cites = p.segments.filter((s) => s.type === "cite");
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ refs: [{ id: "ref-1", resolved: true }] });
  });

  test("\\appendix counting fallback produces letters", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Main}",
        "\\appendix",
        "\\section{Extra}",
        "\\section{More}",
        "\\end{document}",
      ].join("\n"),
      emptyFacts(),
      { eventsAvailable: false }
    );
    expect(allSections(ir.sections).map((s) => s.number)).toEqual(["1", "A", "B"]);
  });

  test("end-of-line comments: the space before % survives, % without space joins", async () => {
    const { ir } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "because the %various processes concerned%",
        "energy joins. Also a%x",
        "b concatenates.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts()
    );
    const p = [...walkBlocks(ir.sections)].find((b) => b.type === "paragraph");
    if (p?.type !== "paragraph") throw new Error("no paragraph");
    const text = p.segments.map((s) => (s.type === "text" ? s.text : "")).join("");
    expect(text).toContain("because the energy joins");
    expect(text).toContain("ab concatenates");
  });

  test("float numbers join the .lot/.lof (print truth beats the label-before-caption aux quirk)", async () => {
    const { ir, warnings } = await fuseSynthetic(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{S}",
        "\\begin{table}",
        "\\label{tab:quirky}", // BEFORE the caption: aux records the stale counter
        "\\caption{Real caption}",
        "\\begin{tabular}{l} x \\end{tabular}",
        "\\end{table}",
        "\\begin{figure}",
        "\\caption{A fig}",
        "\\end{figure}",
        "See Table~\\ref{tab:quirky}.",
        "\\end{document}",
      ].join("\n"),
      emptyFacts({
        // aux has the quirked number, the .lot/.lof have the printed ones
        labels: { "tab:quirky": { number: "2", page: "1" } },
        lot: [{ level: "table", number: "1", title: "Real caption", page: "1" }],
        lof: [{ level: "figure", number: "A", title: "A fig", page: "1" }],
      })
    );
    const tab = [...walkBlocks(ir.sections)].find((b) => b.type === "table");
    const fig = [...walkBlocks(ir.sections)].find((b) => b.type === "figure");
    expect(tab?.number).toBe("1"); // lot wins over the aux "2"
    expect(fig?.number).toBe("A"); // lof entry (letters via a class)
    expect(warnings.some((w) => w.includes("lot/lof") && w.includes("aux"))).toBe(true);
    // and the xref uses the printed number
    expect(xrefRaws(ir)).toContainEqual({ raw: "1", id: "tab-1", resolved: true });
  });

  test("figure materialization via injected port (stub), and no-port degradation", async () => {
    const main = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{S}",
      "\\begin{figure}",
      "\\includegraphics{plot.png}",
      "\\caption{A plot}\\label{fig:p}",
      "\\end{figure}",
      "\\end{document}",
    ].join("\n");
    // no port wired → block keeps caption, no image, warning
    const noPort = await fuseSynthetic(main, emptyFacts());
    const figBlock = [...walkBlocks(noPort.ir.sections)].find((b) => b.type === "figure");
    if (figBlock?.type !== "figure") throw new Error("no figure");
    expect(figBlock.imgPath).toBeUndefined();
    expect(noPort.warnings.some((w) => w.includes("no figure port wired"))).toBe(true);

    // stubbed port: resolve the (missing) file → degrade warning; then a
    // present file materializes
    const { srcDir, mainTex } = tmpSource(main);
    writeFileSync(join(srcDir, "plot.png"), "fakepng");
    const tree = loadTexSourceTree({ srcDir, mainTex });
    const withPort = await buildTexDocIr({
      tree,
      facts: emptyFacts(),
      docId: "synthetic",
      source: { type: "latex", origin: "synthetic", main_tex: "main.tex" },
      eventsAvailable: false,
      srcDir,
      assetsDir: join(srcDir, "assets"),
      figures: {
        materialize: (req) =>
          Promise.resolve({ ok: true, file: `${req.src.split("/").pop() ?? "x"}` }),
      },
    });
    const fig2 = [...walkBlocks(withPort.ir.sections)].find((b) => b.type === "figure");
    if (fig2?.type !== "figure") throw new Error("no figure");
    expect(fig2.imgPath).toBe("plot.png");
  });
});
