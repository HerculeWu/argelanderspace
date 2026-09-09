/**
 * Author-block extraction tests (Stage 6 MS3, `extractAuthorBlock` in
 * `src/pipelines/tex/ir.ts`): AASTeX/revtex sequential affiliation/email
 * attachment, aa.cls \institute positional linking, flat degradation.
 * Driven through `buildTexDocIr` so the meta lands under schema validation.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TexFacts } from "../src/pipelines/tex/facts/index.js";
import { buildTexDocIr } from "../src/pipelines/tex/ir.js";
import { loadTexSourceTree } from "../src/pipelines/tex/source/tree.js";

function emptyFacts(): TexFacts {
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
  };
}

async function metaOf(main: string) {
  const srcDir = mkdtempSync(join(tmpdir(), "tex-author-"));
  const mainTex = join(srcDir, "main.tex");
  writeFileSync(mainTex, main);
  const tree = loadTexSourceTree({ srcDir, mainTex });
  const { ir } = await buildTexDocIr({
    tree,
    facts: emptyFacts(),
    docId: "synthetic",
    source: { type: "latex", origin: "synthetic", main_tex: "main.tex" },
    eventsAvailable: false,
    srcDir,
  });
  return ir.meta;
}

const AASTEX = String.raw`\documentclass{aastex62}
\title{Paper}
\author{Alice A.}
\affiliation{Institute of X, University Y}
\author{Bob B.}
\email{bob@y.edu}
\affiliation{Observatory Z}
\author{Carol C.}
\affiliation{Observatory Z}
\begin{document}
Hello.
\end{document}
`;

describe("author block: AASTeX/revtex sequential", () => {
  test("affiliations attach to the current author group, deduped; email to the last author", async () => {
    const meta = await metaOf(AASTEX);
    expect(meta.affiliations).toEqual(["Institute of X, University Y", "Observatory Z"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [2], email: "bob@y.edu" },
      { name: "Carol C.", affiliations: [2] },
    ]);
    expect(meta.email).toBeUndefined();
  });

  test("the plain name list stays affiliation-free (regression)", async () => {
    const meta = await metaOf(AASTEX);
    expect(meta.authors).toEqual(["Alice A.", "Bob B.", "Carol C."]);
  });

  test("email from \\thanks inside \\author", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\author{Alice A.\thanks{email: alice@x.edu}}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A.", email: "alice@x.edu" }]);
    expect(meta.affiliations).toBeUndefined();
  });

  test("no affiliation macros → flat author list without links", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A. \and Bob B.}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A." }, { name: "Bob B." }]);
    expect(meta.affiliations).toBeUndefined();
  });
});

describe("author block: hand-rolled math-superscript family", () => {
  test("sup markers link authors to \\-split \\affil entries; top-level \\thanks email", async () => {
    const meta = await metaOf(String.raw`\documentclass{revtex4-2}
\author{Federico Lelli$^{1, 2,\star}$}\thanks{$^{\star}$ESO Fellow; e-mail: flelli@eso.org}
\author{Stacy S. McGaugh$^{1}$}
\author{James M. Schombert$^{3}$}
\affil{$^{1}$Department of Astronomy, Case Western Reserve University, Cleveland, OH\\
$^{2}$European Southern Observatory, Garching, Germany\\
$^{3}$Department of Physics, University of Oregon, Eugene, OR}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Federico Lelli", affiliations: [1, 2], email: "flelli@eso.org" },
      { name: "Stacy S. McGaugh", affiliations: [1] },
      { name: "James M. Schombert", affiliations: [3] },
    ]);
    expect(meta.affiliations).toEqual([
      "Department of Astronomy, Case Western Reserve University, Cleveland, OH",
      "European Southern Observatory, Garching, Germany",
      "Department of Physics, University of Oregon, Eugene, OR",
    ]);
  });

  test("\\-glued tail inside \\author parses as affiliations; trailing \\thanks stays with its author", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author[H \& X]{
Mark D. Huisjes,$^{1}$\thanks{E-mail: m.huisjes@degoudsewaarden.nl}
X. Hernandez$^{2}$
\\
$^{1}$CSG De Goudse Waarden Lyceum, Heemskerkstraat 105, 2805SN Gouda\\
$^{2}$Universidad Nacional, Instituto de Astronomía\\
}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      {
        name: "Mark D. Huisjes",
        affiliations: [1],
        email: "m.huisjes@degoudsewaarden.nl",
      },
      { name: "X. Hernandez", affiliations: [2] },
    ]);
    expect(meta.affiliations).toEqual([
      "CSG De Goudse Waarden Lyceum, Heemskerkstraat 105, 2805SN Gouda",
      "Universidad Nacional, Instituto de Astronomía",
    ]);
  });

  test("out-of-order \\affil markers resolve by printed number, not appearance order", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A.$^{2}$ \and Bob B.$^{1}$ \and Carol C.$^{3}$}
\affil{$^{2}$Institute Y\\
$^{1}$Institute X\\
$^{3}$Institute Z}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.affiliations).toEqual(["Institute Y", "Institute X", "Institute Z"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [2] },
      { name: "Carol C.", affiliations: [3] },
    ]);
  });

  test("skipped printed numbers resolve through the marker map", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A.$^{1}$ \and Bob B.$^{3}$}
\affil{$^{1}$Institute X\\
$^{3}$Institute Z}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.affiliations).toEqual(["Institute X", "Institute Z"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [2] },
    ]);
  });
});

describe("author block: attachment boundaries (review N6)", () => {
  test("\\altaffiliation attaches like \\affiliation", async () => {
    const meta = await metaOf(String.raw`\documentclass{revtex4-2}
\author{Alice A.}
\altaffiliation{Also at Institute X}
\affiliation{University Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A.", affiliations: [1, 2] }]);
    expect(meta.affiliations).toEqual(["Also at Institute X", "University Y"]);
  });

  test("affiliation dedupe normalizes case and whitespace", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\author{Alice A.}
\affiliation{Institute   X}
\author{Bob B.}
\affiliation{institute X}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.affiliations).toEqual(["Institute X"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [1] },
    ]);
  });

  test("\\email before any \\author falls back to the document level when no \\correspondingauthor matches", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\email{early@x.edu}
\author{Alice A.}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A." }]);
    expect(meta.email).toBe("early@x.edu");
  });

  test("pre-\\author \\email attaches to the \\correspondingauthor-named author (AASTeX 6.x/7)", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{Bob B.}
\email{bob@y.edu}
\author{Alice A.}
\affiliation{Institute X}
\author{Bob B.}
\affiliation{Observatory Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [2], email: "bob@y.edu" },
    ]);
    expect(meta.email).toBeUndefined();
  });

  test("pre-\\author \\email stays document-level when the \\correspondingauthor name matches no author", async () => {
    // 1804.10121: \correspondingauthor{Coryn A.L.\ Bailer-Jones} vs
    // \author{C.A.L.\ Bailer-Jones} — the full first name never matches.
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{Coryn A.L.\ Bailer-Jones}
\email{calj@mpia.de}
\author{C.A.L.\ Bailer-Jones}
\affiliation{MPIA, Heidelberg}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "C.A.L. Bailer-Jones", affiliations: [1] }]);
    expect(meta.email).toBe("calj@mpia.de");
  });

  test("\\email[show]{…} optional argument does not swallow the address (AASTeX 7)", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex701}
\author{Alice A.}
\affiliation{Institute X}
\email[show]{alice@x.edu}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1], email: "alice@x.edu" },
    ]);
  });

  test("revtex grouping: \\affiliation attaches to every \\author since the previous \\affiliation", async () => {
    // 1609.05917: two authors share the first \affiliation.
    const meta = await metaOf(String.raw`\documentclass[prl]{revtex4-1}
\author{Stacy S. McGaugh}
\author{Federico Lelli}
\affiliation{Department of Astronomy, Case Western Reserve University}
\author{James M. Schombert}
\affiliation{Department of Physics, University of Oregon}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Stacy S. McGaugh", affiliations: [1] },
      { name: "Federico Lelli", affiliations: [1] },
      { name: "James M. Schombert", affiliations: [2] },
    ]);
    expect(meta.affiliations).toEqual([
      "Department of Astronomy, Case Western Reserve University",
      "Department of Physics, University of Oregon",
    ]);
  });

  test("consecutive \\affiliation macros stack on the same author group (AASTeX 7)", async () => {
    // 2607.17040: Long Wang carries two affiliations back to back.
    const meta = await metaOf(String.raw`\documentclass{aastex701}
\author{Alice A.}
\affiliation{Institute X}
\author{Bob B.}
\affiliation{Institute X}
\affiliation{Observatory Y}
\author{Carol C.}
\affiliation{Institute X}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [1, 2] },
      { name: "Carol C.", affiliations: [1] },
    ]);
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y"]);
  });

  test("\\and followed by a layout \\\\ does not eat the next author", async () => {
    // 1307.8124 (aa.cls): some authors are separated by `\and \\`, so the
    // next chunk OPENS with a line break (whitespace nodes included).
    const meta = await metaOf(String.raw`\documentclass{aa}
\author{Alice A.\inst{1}
       \and \\
       E. Schlafly\inst{1}
       \and
       J. S. Morgan\inst{2}
       \and \\
       Bob B.\inst{2}}
\institute{Institute X \and Observatory Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authors).toEqual(["Alice A.", "E. Schlafly", "J. S. Morgan", "Bob B."]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "E. Schlafly", affiliations: [1] },
      { name: "J. S. Morgan", affiliations: [2] },
      { name: "Bob B.", affiliations: [2] },
    ]);
  });

  test("'Last, First' without markers is not comma-split", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Doe, John \and Roe, Jane}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Doe, John" }, { name: "Roe, Jane" }]);
  });

  test("a bare name-suffix chunk is not a phantom author (John Doe, Jr.)", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{John Doe, Jr.$^{1}$, Jane Roe$^{2}$}
\affil{$^{1}$Institute X\\
$^{2}$Institute Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "John Doe Jr.", affiliations: [1] },
      { name: "Jane Roe", affiliations: [2] },
    ]);
    expect(meta.affiliations).toEqual(["Institute X", "Institute Y"]);
  });
});

describe("author block: aa.cls \\institute positional", () => {
  const AA = String.raw`\documentclass{aa}
\title{Paper}
\author{Alice A.\inst{1,2} \and Bob B.\inst{2} \and Carol C.}
\institute{Institute X \and Observatory Y}
\email{alice@x.de}
\begin{document}
Hello.
\end{document}
`;

  test("\\inst links resolve into the \\institute list; \\email is document-level", async () => {
    const meta = await metaOf(AA);
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1, 2] },
      { name: "Bob B.", affiliations: [2] },
      { name: "Carol C." },
    ]);
    expect(meta.email).toBe("alice@x.de");
  });

  test("out-of-range \\inst refs are dropped", async () => {
    const meta = await metaOf(String.raw`\documentclass{aa}
\author{Alice A.\inst{5}}
\institute{Institute X \and Observatory Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A." }]);
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y"]);
  });

  test("comma-separated authors (A&A style with \\orcidlink+\\inst) split per author", async () => {
    const meta = await metaOf(String.raw`\documentclass{aa}
\author{Dhanraj Risbud\orcidlink{0000-0001-9174-2883}\inst{1},
        Vikrant V. Jadhav\orcidlink{0000-0002-8672-3300}\inst{2},
        Pavel Kroupa\orcidlink{0000-0002-7301-3377}\inst{2,3}
       }
\institute{Institute X \\ \email{first@x.de}
 \and
 Observatory Y\\
 \email{second@y.edu}
 \and
 Institute Z}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Dhanraj Risbud", affiliations: [1] },
      { name: "Vikrant V. Jadhav", affiliations: [2] },
      { name: "Pavel Kroupa", affiliations: [2, 3] },
    ]);
    // \email embedded in \institute entries: stripped from the address text,
    // surfaced once at document level (first one wins)
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y", "Institute Z"]);
    expect(meta.email).toBe("first@x.de");
  });
});

describe("author block: adversarial review fixes (Stage 7 MS2 review)", () => {
  test("B1: a chunk's `\\`-tail attaches to that chunk's authors only", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A. \\ Institute X \and Bob B. \\ Observatory Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B.", affiliations: [2] },
    ]);
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y"]);
  });

  test("N1: a trailing sup-marker is stripped from a `\\`-tail piece's text", async () => {
    // The piece is structurally a second author glued after `\\` (known
    // issue); the fix only keeps the raw marker out of the text.
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A. \\ Bob B.$^{2}$}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.affiliations).toEqual(["Bob B."]);
    expect(meta.authorDetails).toEqual([{ name: "Alice A.", affiliations: [1] }]);
  });

  test("N2: exact \\correspondingauthor match wins among same-surname authors", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{Long Wang}
\email{long@x.edu}
\author{Long Wang}
\author{Gang Wang}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Long Wang", email: "long@x.edu" },
      { name: "Gang Wang" },
    ]);
    expect(meta.email).toBeUndefined();
  });

  test("N2: ambiguous surname-only \\correspondingauthor falls to the document level", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{Wang}
\email{wang@x.edu}
\author{Long Wang}
\author{Gang Wang}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Long Wang" }, { name: "Gang Wang" }]);
    expect(meta.email).toBe("wang@x.edu");
  });

  test("N2: a degenerate single-letter \\correspondingauthor never substring-matches", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{B.}
\email{b@x.edu}
\author{Alice Roberts}
\author{Bob Smith}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice Roberts" }, { name: "Bob Smith" }]);
    expect(meta.email).toBe("b@x.edu");
  });

  test("N3: a second pre-\\author \\email lands at the document level instead of evaporating", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\correspondingauthor{Alice A.}
\email{alice@x.edu}
\email{list@y.edu}
\author{Alice A.}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A.", email: "alice@x.edu" }]);
    expect(meta.email).toBe("list@y.edu");
  });

  test("N4: an unnumbered \\affil piece takes the smallest untaken printed number", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A.$^{1}$ \and Bob B.$^{2}$}
\affil{$^{2}$Institute Y\\
Institute X}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.affiliations).toEqual(["Institute Y", "Institute X"]);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [2] },
      { name: "Bob B.", affiliations: [1] },
    ]);
  });

  test("N5: an email line in the `\\`-tail routes to the last author, not the affiliation list", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A. \\ \email{alice@x.edu} \\ Institute X}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1], email: "alice@x.edu" },
    ]);
    expect(meta.affiliations).toEqual(["Institute X"]);
  });

  test("N6: a non-numeric sup marker still opts the author out of group attachment", async () => {
    const meta = await metaOf(String.raw`\documentclass{article}
\author{Alice A.$^{1}$ \and Bob B.$^{\star}$}
\affil{$^{1}$Institute X\\
$^{2}$Observatory Y}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([
      { name: "Alice A.", affiliations: [1] },
      { name: "Bob B." },
    ]);
    expect(meta.affiliations).toEqual(["Institute X", "Observatory Y"]);
  });
});
