/**
 * pandoc adapter tests. Gated on `pandoc` being on PATH — the astro conda env
 * ships it, so the suite prepends that bin dir to PATH before probing
 * (`.kimi-code` environment note). Pure transforms run unconditionally.
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ASTRO_BIN_HINT,
  bibtexToCsl,
  fragmentToBlocks,
  havePandoc,
  katexify,
  latexToAst,
  mathmlToLatex,
  pandocPath,
  stripMathDelims,
} from "../src/latex/pandoc.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

// Make the astro env's pandoc discoverable BEFORE collection: `skipIf` is
// evaluated when this module loads, so a beforeAll would run too late.
if (!havePandoc() && existsSync(`${ASTRO_BIN_HINT}/pandoc`)) {
  process.env.PATH = `${ASTRO_BIN_HINT}${delimiter}${process.env.PATH ?? ""}`;
}
const PANDOC = havePandoc();
if (!PANDOC) {
  console.warn(`pandoc not on PATH (looked also in ${ASTRO_BIN_HINT}) — pandoc tests skipped`);
}

describe("pure KaTeX-cleanup transforms (no pandoc needed)", () => {
  test("stripMathDelims drops one delimiter layer", () => {
    expect(stripMathDelims("\\[x^2\\]")).toBe("x^2");
    expect(stripMathDelims("\\(x^2\\)")).toBe("x^2");
    expect(stripMathDelims("$$x^2$$")).toBe("x^2");
    expect(stripMathDelims("$x^2$")).toBe("x^2");
    expect(stripMathDelims("x^2")).toBe("x^2");
    expect(stripMathDelims("")).toBe("");
    // "$$x$$" is longer than "$$"+"$$" so it strips to "x"
    expect(stripMathDelims("$$x$$")).toBe("x");
    // too short to wrap anything: Python `len(s) > len(lo)+len(hi)` guard
    expect(stripMathDelims("$$")).toBe("$$");
  });

  test("katexify maps pandoc-only spacing commands to KaTeX ones", () => {
    expect(katexify("a \\mspace{6mu} b")).toBe("a \\; b");
    expect(katexify("a\\medspace b")).toBe("a\\; b");
    expect(katexify("a\\thickspace b")).toBe("a\\; b");
    expect(katexify("x^2")).toBe("x^2");
  });
});

describe("pandoc discovery", () => {
  test.skipIf(!PANDOC)("pandoc is found (astro env on PATH)", () => {
    expect(pandocPath(), `pandoc not on PATH; expected it in ${ASTRO_BIN_HINT}`).not.toBeNull();
  });
});

describe.skipIf(!PANDOC)("pandoc-backed conversions", () => {
  test("mathmlToLatex: <mfrac> → \\frac (delimiters stripped)", () => {
    const out = mathmlToLatex("<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>");
    expect(out).toBe("\\frac{a}{b}");
  });

  test("mathmlToLatex: \\mspace is katexified", () => {
    const out = mathmlToLatex(
      '<math><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mspace width="6mu"/><mi>y</mi></math>'
    );
    expect(out).toBe("x^{2} + \\; y");
  });

  test("mathmlToLatex: no <math> input short-circuits to undefined", () => {
    expect(mathmlToLatex("<p>no math</p>")).toBeUndefined();
    expect(mathmlToLatex("")).toBeUndefined();
  });

  test("latexToAst parses the fixture paper", () => {
    const ast = latexToAst(`${FIXTURES}/paper.tex`) as {
      "pandoc-api-version"?: unknown;
      blocks?: Array<{ t?: string }>;
      meta?: Record<string, unknown>;
    };
    expect(ast["pandoc-api-version"]).toBeDefined();
    expect(Array.isArray(ast.blocks)).toBe(true);
    // \maketitle title lands in meta; \section produces a Header block
    expect(ast.blocks?.some((b) => b.t === "Header")).toBe(true);
    expect(ast.meta?.title).toBeDefined();
  });

  test("fragmentToBlocks wraps a fragment into blocks", () => {
    const blocks = fragmentToBlocks("Some text with $x^2$ math.");
    expect(blocks.length).toBe(1);
    expect((blocks[0] as { t?: string }).t).toBe("Para");
  });

  test("bibtexToCsl reads the fixture .bib", () => {
    const entries = bibtexToCsl([`${FIXTURES}/refs.bib`]) as Array<{
      id?: string;
      type?: string;
      DOI?: string;
    }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("milgrom83");
    expect(entries[0]?.DOI).toBe("10.1086/161130");
  });
});
