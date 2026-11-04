# LaTeX ingest

Back to the [README](../../README.md).

Ingest turns a paper's LaTeX source into a structured **render IR** (section tree,
floats, a structured bibliography, citations and cross-references) that the
reader, the annotations and the agent-facing `read` command all use. One
ingestion pipeline emits the IR:

| Pipeline | Input | Status |
|---|---|---|
| **arXiv LaTeX** | arXiv id / URL / local `.tex` / dir / tarball | ✅ the working fully-automatic source |

A PDF is not converted: it is read as the original file (see the README).
PDF (MinerU OCR) and publisher-HTML ingestion are archived on the
`ocr-features` branch and not part of `main`.

Each source tree is compiled in an isolated workspace (latexmk, pdflatex
first with an automatic xelatex retry) and fused with its own source AST
(unified-latex): the compiler's artifacts (.aux/.bbl/.toc/.fls plus an
instrumentation event stream of citations/labels/sections/equation numbers)
anchor print-faithful numbering — displayed numbers are the paper's true
printed numbers; unnumbered displays get none. Compile failures surface with
the error taxonomy and the `!`-line log excerpt. Figures materialize to SVG
via `pdftocairo` (poppler; Ghostscript for EPS) — optional; missing or failed
conversions degrade the figure gracefully, never the ingest. No Python anywhere.
