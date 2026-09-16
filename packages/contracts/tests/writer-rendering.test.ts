import { describe, expect, test } from "vitest";
import {
  BUILTIN_WRITER_TEMPLATES,
  buildBib,
  buildTexDocument,
  buildTexDocumentMapped,
  CellSchema,
  extractCitedKeys,
  extractManuscriptCitedKeys,
  ManuscriptSchema,
  serializeCell,
} from "../src/index.js";

const cell = (source: string) =>
  CellSchema.parse({ id: "c_00000001", type: "latex", data: { source } });
const manuscript = () =>
  ManuscriptSchema.parse({
    version: 1,
    id: "m_00000001",
    rev: 0,
    template: "report",
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    cells: [cell("Text \\citep{a}.")],
  });
const report = BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "report");
if (!report) throw new Error("missing built-in report");

describe("citation inventory, not display reconstruction", () => {
  test("star, two notes, balanced braces/brackets, comments and multiline key groups", () => {
    expect(
      extractCitedKeys([
        cell(String.raw`% \cite{ignored}
\citep*[see {Eq. [1]}][sec.~2]{a,
% an intervening comment
b} \citet[post]{c} \\cite{escaped} \citestyle{not-a-key}`),
      ])
    ).toEqual(["a", "b", "c"]);
  });
  test("literal code is not cited, but its caption is", () => {
    const code = CellSchema.parse({
      id: "c_00000002",
      type: "code",
      data: { caption: "Code \\citep{x}", code: "\\citep{literal}" },
    });
    expect(
      extractCitedKeys([
        code,
        cell(String.raw`\verb|\cite{literal}| \begin{lstlisting}[caption={See \citep{y}}]
\cite{literal}
\end{lstlisting}`),
      ])
    ).toEqual(["x", "y"]);
  });
  test("front matter/preamble citations use the same bibliography inventory", () => {
    const doc = manuscript();
    doc.title = "Title \\citep{front}";
    doc.userPreamble = "\\newcommand{\\example}{\\citep{pre}}";
    expect(extractManuscriptCitedKeys(doc, report)).toEqual(["pre", "front", "a"]);
  });
  test("explicit nocite wildcard lifts all bibliography entries, without fabricating a missing '*' key", () => {
    const result = buildBib(["*"], "@article{a,title={A}}\n@article{b,title={B}}\n");
    expect(result.missing).toEqual([]);
    expect(result.bib).toContain("@article{a");
    expect(result.bib).toContain("@article{b");
  });
});

test("template style is explicit; a source override wins but a comment does not", () => {
  const doc = manuscript();
  doc.userPreamble = "% \\bibliographystyle{ignored}";
  expect(buildTexDocument(doc, report)).toContain("\\bibliographystyle{plainnat}");
  doc.userPreamble = "\\bibliographystyle{unsrtnat}";
  expect(buildTexDocument(doc, report)).not.toContain("\\bibliographystyle{plainnat}");
});

test("A&A abstract precedes maketitle and every cell range still selects its exact source", () => {
  const aa = BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "aa");
  if (!aa) throw new Error("missing A&A");
  const doc = manuscript();
  doc.template = "aa";
  doc.cells.push(
    CellSchema.parse({ id: "c_00000002", type: "abstract-aa", data: { Aims: "An aim." } })
  );
  const mapped = buildTexDocumentMapped(doc, aa);
  expect(mapped.tex.indexOf("\\abstract")).toBeLessThan(mapped.tex.indexOf("\\maketitle"));
  expect(mapped.tex).toBe(buildTexDocument(doc, aa));
  for (const range of mapped.cellRanges) {
    const target = doc.cells.find((c) => c.id === range.cell);
    if (!target) throw new Error("unknown mapped cell");
    expect(
      mapped.tex
        .split("\n")
        .slice(range.startLine - 1, range.endLine)
        .join("\n")
    ).toBe(serializeCell(target));
  }
});
