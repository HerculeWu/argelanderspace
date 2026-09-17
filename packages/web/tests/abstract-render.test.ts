/**
 * Stage 14 follow-up — bibliographic abstract rendering (abstractHtml):
 * provider HTML sanitized to a presentational whitelist, entities decoded,
 * LaTeX math rendered in text nodes only.
 */

import { describe, expect, it } from "vitest";
import { abstractHtml } from "../src/lib/abstract";

describe("abstractHtml", () => {
  it("keeps presentational tags, unwraps the rest, decodes entities", () => {
    const out = abstractHtml(
      "Water <SUB>2</SUB>O with <SUP>+2</SUP> and <i>italic</i> &amp; <u>underlined</u> text"
    );
    expect(out).toContain("<sub>2</sub>");
    expect(out).toContain("<sup>+2</sup>");
    expect(out).toContain("<i>italic</i>");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<u>");
    expect(out).toContain("underlined");
  });

  it("drops active content with its contents; strips attributes", () => {
    const out = abstractHtml(
      'Safe <i onclick="x()">text</i><script>alert(1)</script><a href="https://x">link</a>'
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("<a");
    expect(out).toContain("link");
    expect(out).toContain("<i>text</i>");
  });

  it("renders inline LaTeX math via KaTeX inside text nodes", () => {
    const out = abstractHtml("We measure $H_{0}$ today.");
    expect(out).toContain("katex");
    expect(out).not.toContain("$H_{0}$");
  });

  it("math inside a kept tag renders too", () => {
    const out = abstractHtml("<i>$x^2$</i>");
    expect(out).toContain("katex");
  });

  it("currency-like dollar pairs stay literal (texmath boundary rules)", () => {
    const out = abstractHtml("Between $100 and $200 dollars.");
    expect(out).not.toContain("katex");
    expect(out).toContain("$100");
  });

  it("a stray $ can't pair across tags", () => {
    const out = abstractHtml("Price $<i>not</i> math $ here");
    expect(out).not.toContain("katex");
  });

  it("plain text passes through escaped and unharmed", () => {
    expect(abstractHtml("A & B < C")).toBe("A &amp; B &lt; C");
  });
});
