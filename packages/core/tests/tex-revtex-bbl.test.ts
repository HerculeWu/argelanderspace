/**
 * revtex/aps pasted-.bbl cleaning (Stage 6 smoke R1): an inline
 * thebibliography carries its bibtex-era \providecommand header soup and
 * \bibinfo/\bibfield/\citenamefont markup; the expansion layer must leave the
 * environment untouched and the IR-boundary cleaning must turn entries into
 * readable text (correct first authors, \doibase DOIs preserved).
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

// faithful miniature of the apsrev4-1 pasted .bbl shape (PRL_RAR_arXiv.tex)
const MAIN = String.raw`\documentclass{revtex4-2}
\newcommand{\gobs}{\ensuremath{\mathrm{g}_{\mathrm{obs}}}}
\begin{document}
The acceleration $\gobs$ is measured \cite{vera,bosma}.
\begin{thebibliography}{2}%
\makeatletter
\providecommand \bibinfo  [0]{\@secondoftwo}%
\providecommand \bibfield  [0]{\@secondoftwo}%
\providecommand \citenamefont [1]{#1}%
\providecommand \BibitemShut  [1]{\csname bibitem#1\endcsname}%
%</preamble>
\bibitem [{\citenamefont {{Rubin}}\ \emph {et~al.}(1978)\citenamefont
  {{Rubin}}, \citenamefont {{Thonnard}},\ and\ \citenamefont {{Ford}}}]{vera}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {V.~C.}\ \bibnamefont
  {{Rubin}}}, \bibinfo {author} {\bibfnamefont {N.}~\bibnamefont {{Thonnard}}},
  \ and\ \bibinfo {author} {\bibfnamefont {W.~K.}\ \bibnamefont {{Ford}},
  \bibfnamefont {Jr.}},\ }\href {\doibase 10.1086/182804} {\bibfield  {journal}
  {\bibinfo  {journal} {Astrophys. J.}\ }\textbf {\bibinfo {volume} {225}},\
  \bibinfo {pages} {L107} (\bibinfo {year} {1978})}\BibitemShut {NoStop}%
\bibitem [{\citenamefont {{Bosma}}(1981)}]{bosma}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {A.}~\bibnamefont
  {{Bosma}}},\ }\href@noop {} {\bibfield  {journal} {\bibinfo  {journal}
  {Astron. J.}\ }\textbf {\bibinfo {volume} {86}},\ \bibinfo {pages} {1791}
  (\bibinfo {year} {1981})}\BibitemShut {NoStop}%
\end{thebibliography}
\end{document}
`;

describe("revtex pasted-.bbl references (smoke R1)", () => {
  async function build() {
    const srcDir = mkdtempSync(join(tmpdir(), "tex-revtex-"));
    const mainTex = join(srcDir, "main.tex");
    writeFileSync(mainTex, MAIN);
    const tree = loadTexSourceTree({ srcDir, mainTex });
    return buildTexDocIr({
      tree,
      facts: emptyFacts(),
      docId: "synthetic",
      source: { type: "latex", origin: "synthetic", main_tex: "main.tex" },
      eventsAvailable: false,
      srcDir,
    });
  }

  test("entries are readable: no bibtex markup soup anywhere in raw/authors", async () => {
    const { ir } = await build();
    expect(ir.references).toHaveLength(2);
    for (const r of ir.references ?? []) {
      const blob = JSON.stringify([r.authors, r.raw]);
      expect(blob).not.toMatch(
        /secondoftwo|citenamefont|bibinfo|bibfield|Bibitem|makeatletter|providecommand/
      );
    }
  });

  test("first authors + years + doibase DOI survive cleaning", async () => {
    const { ir } = await build();
    const [vera, bosma] = ir.references ?? [];
    expect(vera?.authors?.slice(0, 3)).toEqual(["Rubin", "Thonnard", "Ford"]);
    expect(vera?.year).toBe(1978);
    expect(vera?.doi).toBe("10.1086/182804");
    expect(bosma?.authors?.[0]).toBe("Bosma");
    expect(bosma?.year).toBe(1981);
  });

  test("the bibliography env is NOT macro-expanded, while body macros are", async () => {
    const { ir } = await build();
    // \gobs (body) expanded: the cite paragraph carries \ensuremath, and no
    // \providecommand from the header soup got applied to bibinfo/bibfield
    const paraText = JSON.stringify(ir.sections[0]?.blocks ?? []);
    expect(paraText).toContain("ensuremath");
    expect(paraText).toContain("Rubin et al. 1978");
  });
});
