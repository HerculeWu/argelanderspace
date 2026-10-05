import { describe, expect, it } from "vitest";
import { MATH_RENDER_MAX_CHARS, renderMathToString, resetMathBudget } from "../src/lib/math";

describe("renderMathToString", () => {
  it("renders \\ensuremath via the identity macro (macro-expanded unit shorthands)", () => {
    const html = renderMathToString(
      "\\ensuremath{\\mathrm{g}_{\\mathrm{obs}}} = \\frac{V^{2}(R)}{R}",
      true
    );
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("ensuremath");
    expect(html).toContain("obs");
  });

  it("still surfaces broken latex as an error-colored render, not a throw", () => {
    const html = renderMathToString("\\notacommandatall{x}");
    expect(html).toContain("#b00020");
  });

  // Text Docs carry author-written formulas into the shared Reader (ticket 26): KaTeX runs without `trust`, so
  // link, image, raw-HTML and class/attribute commands never become active markup.
  it("never renders active markup from author-written formulas (trust is off)", () => {
    for (const latex of [
      "\\href{javascript:alert(1)}{click}",
      "\\url{javascript:alert(1)}",
      "\\includegraphics{x.png}",
      "\\htmlClass{evil}{x}",
      "\\htmlId{evil}{x}",
      "\\htmlStyle{color:red}{x}",
      "\\htmlData{a=b}{x}",
    ]) {
      const html = renderMathToString(latex);
      expect(html, latex).not.toMatch(/<a[ >]/);
      expect(html, latex).not.toMatch(/<img/);
      expect(html, latex).not.toMatch(/javascript:/);
      expect(html, latex).not.toMatch(/\sevil\b|id="evil"|data-a/);
    }
  });

  it("a huge published formula is shown as source with a notice and never sent to KaTeX (the tab must not freeze)", () => {
    const huge = `${"x+".repeat(200_000)}x`; // 400 KB: KaTeX needs over a minute for this
    const started = performance.now();
    const html = renderMathToString(huge, true);
    expect(performance.now() - started).toBeLessThan(500);
    expect(html).toContain("math-oversize");
    expect(html.startsWith('<span class="math-error')).toBe(true); // the annotation map still sees one math atom
    expect(html).not.toContain("katex");
    expect(html.length).toBeLessThan(10_000);
    // the source is escaped, never markup
    expect(renderMathToString(`<img src=x onerror=1>${"y".repeat(MATH_RENDER_MAX_CHARS)}`)).not.toContain("<img");
    // just under the limit still typesets
    expect(renderMathToString("x".repeat(100))).toContain("katex");
  });

  it("a macro bomb is shown as source immediately (a defined macro used forty times took 24 s)", () => {
    resetMathBudget();
    const bomb = `\\def\\a{${"x".repeat(4000)}}${"\\a".repeat(40)}`;
    const started = performance.now();
    const html = renderMathToString(bomb, true);
    expect(performance.now() - started).toBeLessThan(500);
    expect(html).toContain("math-oversize");
    expect(html).not.toContain("katex");
    // obfuscated definitions are caught too
    for (const cmd of ["\\global\\def", "\\expandafter\\def", "\\csname def\\endcsname", "\\newcommand", "\\let"])
      expect(renderMathToString(`${cmd}\\a{${"x".repeat(400)}}\\a`), cmd).toContain("math-oversize");
    // a short definition and a double backslash are ordinary formulas
    expect(renderMathToString("\\def\\a{x}\\a")).toContain("katex");
    expect(renderMathToString(`a\\\\def${"b".repeat(400)}`)).toContain("katex");
  });

  it("hundreds of near-limit formulas cannot freeze the tab: past the document's budget they show source", () => {
    resetMathBudget();
    const started = performance.now();
    let typeset = 0;
    let source = 0;
    for (let i = 0; i < 300; i++) {
      const html = renderMathToString(`${"x+".repeat(19_999)}${i}`, true); // 39,999 characters, each different
      if (html.includes("math-oversize")) source++;
      else typeset++;
    }
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(typeset).toBeLessThanOrEqual(4);
    expect(typeset).toBeGreaterThanOrEqual(1);
    expect(source).toBe(300 - typeset);
    // asking again for one already decided costs nothing and gives the same answer
    const again = performance.now();
    renderMathToString(`${"x+".repeat(19_999)}0`, true);
    expect(performance.now() - again).toBeLessThan(50);
    // a new document starts with a fresh budget
    resetMathBudget();
    expect(renderMathToString(`${"x+".repeat(19_999)}1`, true)).toContain("katex");
    // small formulas are never affected
    expect(renderMathToString("x^2")).toContain("katex");
  }, 60_000);
});
