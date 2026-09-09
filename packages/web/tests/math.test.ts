import { describe, expect, it } from "vitest";
import { renderMathToString } from "../src/lib/math";

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
});
