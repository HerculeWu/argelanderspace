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

  test("\\-glued tail drops off the author list; trailing \\thanks stays with its author", async () => {
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
      { name: "Mark D. Huisjes", email: "m.huisjes@degoudsewaarden.nl" },
      { name: "X. Hernandez" },
    ]);
    expect(meta.affiliations).toBeUndefined();
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

  test("\\email before any \\author is dropped, not mis-attached", async () => {
    const meta = await metaOf(String.raw`\documentclass{aastex62}
\email{early@x.edu}
\author{Alice A.}
\begin{document}
Hi.
\end{document}
`);
    expect(meta.authorDetails).toEqual([{ name: "Alice A." }]);
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
