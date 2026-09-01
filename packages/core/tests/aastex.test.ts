/**
 * Tests for the mechanical AASTeX table pre-pandoc rewrite
 * (`src/pipelines/latex/aastex.ts`, Stage 3.1 decision #8): pure text
 * transforms plus one pandoc-gated end-to-end check that the rewritten
 * `deluxetable` survives pandoc as a proper table float (caption + label).
 */

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Document, ParagraphBlock } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { iterBlocks } from "../src/documents/traverse.js";
import { preprocessAastex } from "../src/pipelines/latex/aastex.js";
import { ingestLatex } from "../src/pipelines/latex/pipeline.js";
import { HAVE_PANDOC, testAcquire, testPandoc } from "./helpers/latex-ports.js";

describe("preprocessAastex: deluxetable → table + tabular", () => {
  test("no AASTeX constructs → input returned unchanged (same reference)", () => {
    const src = "\\begin{table}\\caption{c}\\begin{tabular}{l}x\\end{tabular}\\end{table}";
    expect(preprocessAastex(src)).toBe(src);
  });

  test("caption (label kept), colspec, colhead header, data markers removed", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{lcc}\n" +
        "\\tablecaption{Cap text \\label{tab:x}}\n" +
        "\\tablehead{\\colhead{A} & \\colhead{B} & \\colhead{C}}\n" +
        "\\startdata\n1 & 2 & 3 \\\\\n\\enddata\n" +
        "\\tablecomments{A note.}\n" +
        "\\end{deluxetable}\n"
    );
    expect(out).not.toContain("deluxetable");
    expect(out).not.toContain("startdata");
    expect(out).not.toContain("enddata");
    expect(out).toContain("\\begin{table}");
    expect(out).toContain("\\caption{Cap text \\label{tab:x}}");
    expect(out).toContain("\\begin{tabular}{lcc}");
    expect(out).toContain("A & B & C");
    expect(out).toContain("1 & 2 & 3 \\\\");
    expect(out.indexOf("\\begin{tabular}")).toBeGreaterThan(out.indexOf("\\caption"));
    // \tablecomments becomes a trailing paragraph AFTER the table
    const end = out.indexOf("\\end{table}");
    expect(out.indexOf("A note.")).toBeGreaterThan(end);
  });

  test("standalone \\label in the environment is folded into the caption", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{l}\n" +
        "\\tablecaption{Cap text}\n\\label{tab:y}\n" +
        "\\startdata\n1 \\\\\n\\enddata\n\\end{deluxetable}\n"
    );
    expect(out).toContain("\\caption{Cap text\\label{tab:y}}");
    // no leftover standalone label
    expect(out.split("\\label").length - 1).toBe(1);
  });

  test("standalone \\label with no caption synthesizes one", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{l}\n\\label{tab:z}\n" +
        "\\startdata\n1 \\\\\n\\enddata\n\\end{deluxetable}\n"
    );
    expect(out).toContain("\\caption{\\label{tab:z}}");
  });

  test("a caption that already has a label keeps an extra standalone label in place", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{l}\n" +
        "\\tablecaption{Cap \\label{tab:a}}\n\\label{tab:b}\n" +
        "\\startdata\n1 \\\\\n\\enddata\n\\end{deluxetable}\n"
    );
    expect(out).toContain("\\caption{Cap \\label{tab:a}}");
    expect(out).toContain("\\label{tab:b}"); // content never dropped
  });

  test("multi-row \\tablehead keeps the row separator", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{ll}\n" +
        "\\tablehead{\\colhead{A} & \\colhead{B} \\\\ \\colhead{C} & \\colhead{D}}\n" +
        "\\startdata\n1 & 2 \\\\\n\\enddata\n\\end{deluxetable}\n"
    );
    expect(out).toContain("A & B \\\\");
    expect(out).toContain("C & D");
    expect(out).not.toContain("colhead");
  });

  test("formatting-only commands dropped, \\tableline → \\hline", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{l}\n" +
        "\\tabletypesize{\\small}\\rotate\\tablewidth{0pt}\n" +
        "\\tablecaption{C}\n" +
        "\\startdata\n\\tableline\n1 \\\\\n\\enddata\n\\end{deluxetable}\n"
    );
    expect(out).not.toContain("tabletypesize");
    expect(out).not.toContain("\\rotate");
    expect(out).not.toContain("tablewidth");
    expect(out).toContain("\\hline");
    expect(out).not.toContain("tableline");
  });

  test("\\tablenotetext / \\tablerefs degrade to trailing paragraphs (in order)", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable}{l}\n\\tablecaption{C}\n" +
        "\\startdata\n1$^{a}$ \\\\\n\\enddata\n" +
        "\\tablenotetext{a}{First note.}\n\\tablerefs{Some ref.}\n\\end{deluxetable}\n"
    );
    const end = out.indexOf("\\end{table}");
    const note = out.indexOf("(a) First note.");
    const refs = out.indexOf("Some ref.");
    expect(note).toBeGreaterThan(end);
    expect(refs).toBeGreaterThan(note);
  });

  test("deluxetable* is rewritten by the deluxe rule (not the table* rule)", () => {
    const out = preprocessAastex(
      "\\begin{deluxetable*}{ll}\n\\tablecaption{Wide}\n" +
        "\\startdata\n1 & 2 \\\\\n\\enddata\n\\end{deluxetable*}\n"
    );
    expect(out).not.toContain("deluxetable");
    expect(out).not.toContain("table*");
    expect(out).toContain("\\begin{table}");
    expect(out).toContain("\\begin{tabular}{ll}");
  });
});

describe("preprocessAastex: table* → table", () => {
  test("starred env renamed, placement arg and inner tabular kept", () => {
    const out = preprocessAastex(
      "\\begin{table*}[t]\n\\caption{Wide \\label{tab:w}}\n" +
        "\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n\\end{table*}\n"
    );
    expect(out).toContain("\\begin{table}[t]");
    expect(out).toContain("\\end{table}");
    expect(out).not.toContain("table*");
    expect(out).toContain("\\caption{Wide \\label{tab:w}}");
    expect(out).toContain("\\begin{tabular}{ll}");
  });

  test("unstarred table untouched", () => {
    const src = "\\begin{table}[h]\n\\caption{C}\n\\end{table}\n";
    expect(preprocessAastex(src)).toBe(src);
  });
});

describe.skipIf(!HAVE_PANDOC)("preprocessAastex end-to-end (pandoc-gated)", () => {
  async function ingestTex(tex: string): Promise<{ doc: Document; dir: string }> {
    const tmp = mkdtempSync(join(tmpdir(), "bibgraph-aastex-"));
    writeFileSync(join(tmp, "main.tex"), tex, "utf-8");
    const doc = await ingestLatex(
      join(tmp, "main.tex"),
      { pandoc: testPandoc, acquire: testAcquire },
      {
        outRoot: join(tmp, "out"),
        config: { downloadAssets: false, useCache: false, requestDelay: 0 },
        writeJson: false,
      }
    );
    return { doc, dir: tmp };
  }

  test("a deluxetable becomes a captioned, labelled table float", async () => {
    const { doc, dir } = await ingestTex(
      "\\documentclass{article}\n\\begin{document}\n" +
        "\\section{S}\nSee Table~\\ref{tab:pot}.\n" +
        "\\begin{deluxetable}{lc}\n" +
        "\\tablecaption{Potential models \\label{tab:pot}}\n" +
        "\\tablehead{\\colhead{Model} & \\colhead{$M$}}\n" +
        "\\startdata\nNFW & 5 \\\\\n\\enddata\n" +
        "\\tablecomments{Units are nominal.}\n\\end{deluxetable}\n" +
        "\\end{document}\n"
    );
    const blocks = [...iterBlocks(doc)];
    const table = blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    expect(table && "caption" in table ? table.caption?.text : "").toContain("Potential models");
    // the crossref resolved against the folded-in label with the table number
    const p = blocks.find(
      (b): b is ParagraphBlock => b.type === "paragraph" && b.text.includes("Table")
    );
    expect(p?.text).toContain("[[xref:tab-1]]");
    const occ = p?.crossrefs?.find((x) => x.kind === "table");
    expect(occ?.resolved).toBe(true);
    expect(occ?.number).toBe(table && "number" in table ? table.number : undefined);
    // tablecomments survived as a paragraph
    expect(
      blocks.some((b) => b.type === "paragraph" && b.text.includes("Units are nominal."))
    ).toBe(true);
    // the temp rewrite file is cleaned up
    expect(readdirSync(dir).filter((f) => f.startsWith(".aastex-"))).toEqual([]);
  });
});
