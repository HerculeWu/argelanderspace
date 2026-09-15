/**
 * buildBib (Stage 10 M3): verbatim filtering of library.bib down to the cited
 * keys, citation order, missing-key warnings — plan §5.
 */

import { describe, expect, it } from "vitest";
import { buildBib, scanBibEntries } from "../src/writer-bib.js";

const LIB = `% a header comment
@article{huisjes2025,
  title   = {Most open clusters follow the {RAR}},
  author  = {Huisjes and Hernández},
  year    = {2025},
}

@book{nbody,
  title   = {Galactic Dynamics},
  author  = {Binney, J. and Tremaine, S.},
  year    = {2008},
}
@misc{paren,
  title   = {Paren style},
  note    = {uses (parens)},
}

@comment{ignored, not an entry}
`;

describe("scanBibEntries", () => {
  it("finds entries with keys, skipping comments and junk", () => {
    const keys = scanBibEntries(LIB).map((e) => e.key);
    expect(keys).toEqual(["huisjes2025", "nbody", "paren"]);
  });

  it("keeps nested braces byte-stable", () => {
    const first = scanBibEntries(LIB)[0];
    expect(first?.text).toContain("title   = {Most open clusters follow the {RAR}},");
  });
});

describe("buildBib", () => {
  it("lifts cited entries verbatim, in citation order", () => {
    const { bib, missing } = buildBib(["nbody", "huisjes2025"], LIB);
    expect(missing).toEqual([]);
    expect(bib.indexOf("@book{nbody,")).toBeLessThan(bib.indexOf("@article{huisjes2025,"));
    expect(bib).toContain("Galactic Dynamics");
    expect(bib.endsWith("\n")).toBe(true);
  });

  it("dedupes repeated citations", () => {
    const { bib } = buildBib(["nbody", "nbody"], LIB);
    expect(bib.match(/@book\{nbody,/g)).toHaveLength(1);
  });

  it("marks library-missing keys with a % missing comment and reports them", () => {
    const { bib, missing } = buildBib(["nbody", "ghost2026"], LIB);
    expect(missing).toEqual(["ghost2026"]);
    expect(bib).toContain("% missing: ghost2026");
  });

  it("an empty key list yields an empty bib", () => {
    expect(buildBib([], LIB)).toEqual({ bib: "", missing: [] });
  });
});
