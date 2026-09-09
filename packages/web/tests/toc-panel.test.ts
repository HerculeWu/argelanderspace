/**
 * TocPanel float preview/tooltip cleanup (Stage 7 MS1): the caption text
 * carries core `segmentsMarkdown` cite/xref expansion tokens, which the
 * preview must reduce to their readable short text instead of showing raw.
 */

import { describe, expect, it } from "vitest";
import { stripMath } from "../src/components/TocPanel";

describe("stripMath (TOC float preview)", () => {
  it("replaces a cite token with its short label", () => {
    expect(stripMath("see [cite: ref-1 | Bok 1934 | title: Nebular lines] for details")).toBe(
      "see Bok 1934 for details"
    );
  });

  it("drops unresolved and short-less cite tokens", () => {
    expect(stripMath("see [cite: ? | unresolved] here")).toBe("see here");
    expect(stripMath("see [cite: ref-7 | unresolved] here")).toBe("see here");
    expect(stripMath("see [cite: ref-9 | ] here")).toBe("see here");
  });

  it("separates adjacent cite tokens (\\citep{a,b}) with a space", () => {
    expect(stripMath("[cite: ref-1 | Kroupa 2001][cite: ref-2 | Bok 1934]")).toBe(
      "Kroupa 2001 Bok 1934"
    );
    expect(stripMath("models [cite: ref-1 | Kroupa 2001][cite: ref-2 | Bok 1934] compared")).toBe(
      "models Kroupa 2001 Bok 1934 compared"
    );
  });

  it("replaces an xref token with its printed number", () => {
    expect(stripMath("shown in [ref: fig-sed | figure | number: 3 | The SED plot]")).toBe(
      "shown in 3"
    );
    expect(stripMath("cf. [ref: sec-intro | section | number: 2 | Introduction]")).toBe("cf. 2");
  });

  it("drops unresolved xref tokens", () => {
    expect(stripMath("see [ref: fig-gone | unresolved] here")).toBe("see here");
  });

  it("falls back to the heading/preview text for resolved xrefs without a number", () => {
    expect(stripMath("see [ref: sec-app | section | Appendix Details] here")).toBe(
      "see Appendix Details here"
    );
    expect(stripMath("in [ref: fig-x | figure | An unnumbered plot]")).toBe(
      "in An unnumbered plot"
    );
  });

  it("handles mixed tokens in one caption", () => {
    expect(
      stripMath(
        "[ref: fig-a | figure | number: 1 | sketch] from [cite: ref-2 | Kroupa 2001], cf. $M_\\odot$ models"
      )
    ).toBe("1 from Kroupa 2001, cf. models");
  });

  it("still strips math and [[...]] links and collapses whitespace", () => {
    expect(stripMath("  the $E=mc^2$ link [[fig-1 | jump]]  caption ")).toBe("the link caption");
  });

  it("leaves token-free text unchanged", () => {
    expect(stripMath("A plain caption, no tokens.")).toBe("A plain caption, no tokens.");
  });
});
