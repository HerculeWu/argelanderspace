import { describe, expect, it } from "vitest";
import { MATH_RENDER_MAX_CHARS, renderMathToString } from "../src/lib/math";

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
});
