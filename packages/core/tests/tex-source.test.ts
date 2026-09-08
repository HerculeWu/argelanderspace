/**
 * Source-tree layer tests (Stage 5 MS2, `src/pipelines/tex/source/`):
 * parse + `\input` merge + .fls cross-check + bounded macro expansion.
 * All ungated (no TeX toolchain needed); the battery fixture doubles as the
 * frozen-artifact source.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type * as Ast from "@unified-latex/unified-latex-types";
import { describe, expect, test } from "vitest";
import { expandTexMacros, extractMacroDefs } from "../src/pipelines/tex/source/macros.js";
import {
  envName,
  flsSourceFiles,
  lastArgText,
  loadTexSourceTree,
  printRawNodes,
  texParser,
} from "../src/pipelines/tex/source/tree.js";

const TEX_FIXTURES = fileURLToPath(new URL("fixtures/tex", import.meta.url));

function parseBody(src: string): Ast.Node[] {
  return texParser().parse(src).content as Ast.Node[];
}

function macroNamed(content: Ast.Node[], name: string): Ast.Macro | undefined {
  return content.find((n): n is Ast.Macro => n.type === "macro" && n.content === name);
}

describe("loadTexSourceTree", () => {
  test("battery: main + child merged, files tagged, no warnings w/o fls", () => {
    const tree = loadTexSourceTree({
      srcDir: `${TEX_FIXTURES}/battery`,
      mainTex: `${TEX_FIXTURES}/battery/main.tex`,
    });
    expect(tree.files).toEqual(["main.tex", "child.tex"]);
    expect(tree.warnings).toEqual([]);
    expect(tree.body.length).toBeGreaterThan(0);
    // child nodes carry their own file + line
    const childNodes = tree.body.filter((n) => tree.fileOf(n) === "child.tex");
    expect(childNodes.length).toBeGreaterThan(0);
    const childMath = childNodes.find((n) => n.type === "mathenv");
    expect(childMath?.position?.start.line).toBe(3); // \begin{equation} on child line 3
  });

  test("fls cross-check is clean for the frozen battery build", () => {
    const fls = readFileSync(`${TEX_FIXTURES}/battery/build/main.fls`, "utf8");
    const inputs = flsSourceFiles(
      fls
        .split("\n")
        .filter((l) => l.startsWith("INPUT "))
        .map((l) => l.slice(6))
    );
    const tree = loadTexSourceTree({
      srcDir: `${TEX_FIXTURES}/battery`,
      mainTex: `${TEX_FIXTURES}/battery/main.tex`,
      flsInputs: inputs,
    });
    expect(tree.warnings).toEqual([]);
  });
});

describe("flsSourceFiles filtering", () => {
  test("drops wrapper/sty/absolute/generated, keeps user .tex", () => {
    expect(
      flsSourceFiles([
        "/etc/texmf/web2c/texmf.cnf",
        "./__argelander_wrap.tex",
        "__argelander_wrap.tex",
        "argelander.sty",
        "./main.tex",
        "main.tex",
        "main.aux",
        "main.bbl",
        "sub/child.tex",
        "main.argelander.jsonl",
        "main.pdf",
        "refs.bib",
      ])
    ).toEqual(["main.tex", "sub/child.tex", "refs.bib"]);
  });
});

describe("macro signature table (parse)", () => {
  test("cite/ref/label/section args attach with content", () => {
    const content = parseBody(
      "\\section{Intro}\\label{sec:i}\nText \\citep[see][chap.~2]{a,b} and \\eqref{eq:x}."
    );
    const sec = macroNamed(content, "section");
    expect(sec).toBeDefined();
    expect(sec === undefined ? undefined : lastArgText(sec)).toBe("Intro");
    const citep = macroNamed(content, "citep");
    expect(citep).toBeDefined();
    expect(citep?.args?.map((a) => printRawNodes(a.content))).toEqual([
      "",
      "see",
      "chap.~2",
      "a,b",
    ]);
  });

  test("figure/tabular env args attach; math envs parse as mathenv", () => {
    const content = parseBody(
      "\\begin{figure}[ht]\\includegraphics{a.pdf}\\end{figure}\n" +
        "\\begin{tabular}{lc} a & b \\end{tabular}\n" +
        "\\begin{align} x &= 1 \\end{align}"
    );
    const fig = content.find((n) => n.type === "environment" && envName(n) === "figure");
    expect(fig).toBeDefined();
    const align = content.find((n) => n.type === "mathenv");
    expect(align).toBeDefined();
    expect(align === undefined ? undefined : envName(align)).toBe("align");
  });
});

describe("bounded macro expansion", () => {
  function expand(src: string): { raw: string; warnings: string[]; count: number } {
    const content = parseBody(src);
    const warnings: string[] = [];
    const defs = extractMacroDefs(texParser().parse(src), warnings);
    const count = expandTexMacros(content, defs, warnings);
    return { raw: printRawNodes(content), warnings, count };
  }

  test("simple zero-arg \\newcommand expands at usage", () => {
    const r = expand("\\newcommand{\\kms}{km s$^{-1}$}\nSpeed 100 \\kms\\ fast.");
    expect(r.count).toBe(1);
    expect(r.raw).toContain("km s");
    expect(r.raw).not.toContain("\\kms\\ fast");
    expect(r.warnings).toEqual([]);
  });

  test("args + optional default substitute correctly", () => {
    const r = expand("\\newcommand{\\vec}[2][x]{#1 \\times #2}\n\\vec{y} and \\vec[z]{w}.\n");
    expect(r.raw).toContain("x \\times y");
    expect(r.raw).toContain("z \\times w");
    expect(r.warnings).toEqual([]);
  });

  test("pathological bodies are left raw with warnings", () => {
    const r = expand(
      "\\newcommand{\\bad}{\\bad loops}\n\\newcommand{\\cond}{\\iftrue x\\fi}\n\\bad and \\cond.\n"
    );
    expect(r.count).toBe(0);
    expect(r.warnings.some((w) => w.includes("self-recursive"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("constructs"))).toBe(true);
    expect(r.raw).toContain("\\bad");
  });

  test("structure macro names are protected from redefinition", () => {
    const r = expand("\\renewcommand{\\cite}[1]{BOGUS #1}\nText \\cite{key}.\n");
    expect(r.count).toBe(0);
    expect(r.warnings.some((w) => w.includes("structure macro"))).toBe(true);
    expect(r.raw).toContain("\\cite{key}");
  });

  test("nested macros reach a fixpoint (expansion chains)", () => {
    const r = expand(
      "\\newcommand{\\base}{42}\n\\newcommand{\\derived}{\\base\\ plus}\n\\derived.\n"
    );
    expect(r.raw).toContain("42");
  });

  test("mutual recursion terminates bounded (left raw after pass cap)", () => {
    const r = expand("\\newcommand{\\ping}{\\pong}\n\\newcommand{\\pong}{\\ping}\n\\ping.\n");
    expect(r.count).toBeGreaterThan(0);
    expect(r.count).toBeLessThanOrEqual(2000);
    expect(r.raw).toMatch(/\\(ping|pong)/); // something raw remains
    expect(r.warnings.some((w) => w.includes("did not reach a fixpoint"))).toBe(true); // N1
  });

  test("verbatim bodies are never expanded", () => {
    const r = expand(
      "\\newcommand{\\kms}{km}\n\\begin{verbatim}\n\\kms stays\n\\end{verbatim}\n\\kms.\n"
    );
    expect(r.raw).toContain("\\kms stays");
    expect(r.raw).toMatch(/km\s*\./);
  });
});
