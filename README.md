# bibgraph — literature ingestion (PDF + publisher HTML)

Turns a research-paper **PDF** into a structured JSON document for a literature
reading app: section structure, floats (figures / tables / equations / code /
pseudocode), a structured reference list, and inline-tokenized in-text
**citations** and **cross-references**.

Phase 1 targets the *PDF-only* case (including scanned/old papers). Phase 4
(**publisher HTML**) is now started — see *HTML pipeline* below. LaTeX-source and
EPUB ingestion are still future phases.

## HTML pipeline (Phase 4)

Modern journals publish a clean, semantically-marked-up HTML full text — the most
stable source there is. Each publisher ships a different front-end, so each gets
its own adapter under `bibgraph/ingest_html/`; the **first is Astronomy &
Astrophysics** (`aanda.py`). The adapter walks the DOM and emits the *same*
`Document` JSON the PDF pipeline produces, so the reader UI is unchanged.

```
 DOI / URL
  ├─ fetch          → full-text HTML (cached on disk under <root>/.htmlcache)
  ├─ adapter (A&A)  → section tree + floats + references
  │                   • citations  = <a href="#R..">  → authoritative ref link
  │                   • cross-refs = <a href="#F/#T/#FD/#S/#APP">  → float/section
  │                   • equations  = MathML → pandoc → KaTeX-clean LaTeX
  │                                  (data-latex used as a fallback)
  │                   • tables      = fetched from the per-table T<n>.html sub-page
  │                   • figures     = full-res image downloaded to assets/
  ├─ annotate       → splice [[cite:..]] / [[xref:..]]; regex only for *unlinked* mentions
  └─ → Document → <root>/<doc_id>/<doc_id>.json
```

Unlike the PDF path, citation/cross-reference resolution is **authoritative**:
the page's own anchors say exactly which reference or float each one points at,
so resolution is character-precise rather than regex-guessed. Inline math is
handled *conservatively* — only `<sub>`/`<sup>` and single-letter italic
variables become `$…$`; prose italics (journal/object names) stay plain text;
footnote markers are dropped.

```bash
PY=/home/wwu/miniforge3/envs/astro/bin/python
$PY -m bibgraph 10.1051/0004-6361/202039341      # a DOI (resolves to A&A full HTML)
$PY -m bibgraph https://www.aanda.org/articles/aa/full_html/2021/02/aa39341-20/aa39341-20.html
# options: --inline-math {conservative,plain}  --no-assets  --no-subpages  --no-cache
#          --out-root DIR   (default data/output, so the reader picks it up)
```

Output lands in `<root>/<doc_id>/<doc_id>.json` with figure images in
`<doc_id>/assets/` (served by the reader's `/images/<doc_id>/<file>` route). The
HTML deps are `requests` + `beautifulsoup4` (both in the `astro` env) and
`pandoc` (system, for MathML→LaTeX).

## How it works

```
 PDF
  ├─ PyMuPDF        → text-layer probe (OCR auto-detect) + hyperlink annotations
  │                   (incl. hyperref named destinations: cite.* / figure.* / section.* …)
  ├─ MinerU v4 VLM  → content_list.json + middle.json + images/   (high-precision OCR)
  ├─ structure      → section tree + floats + captions
  ├─ references     → structured bibliography (best-effort fields)
  ├─ textfix        → repair MinerU '?'-gaps in body text from the PDF text layer
  └─ annotate       → inline [[cite:ref-N]] / [[xref:fig-N]] tokens (regex + hyperlinks)
 → Document → <out_dir>/<stem>.json
```

**Hybrid citation/cross-ref resolution.** MinerU's OCR→markdown output drops the
PDF's embedded links, so we read them straight from the original file with
PyMuPDF. For LaTeX/hyperref PDFs the named destinations are semantic
(`cite.<bibkey>`, `section.7`, `figure.3`, …): citation links point into the
bibliography (resolved spatially to the matching reference entry) and cross-ref
links point at the target float. Regex detection runs in parallel and is the
fallback for scanned PDFs that have no links. Resolution is **block-granular**
(a link overlapping a text block is paired with that block's citation/xref
sites), not character-precise.

## Setup

```bash
# interpreter (conda 'astro' env). PyMuPDF is the only extra dependency.
/home/wwu/miniforge3/envs/astro/bin/python -m pip install "PyMuPDF>=1.24"
export MINERU_API_KEY=...        # MinerU v4 token (already set in this env)
```

## Usage

```bash
PY=/home/wwu/miniforge3/envs/astro/bin/python

# full run (calls the MinerU API, then parses)
$PY -m bibgraph data/input/paper.pdf

# reuse a cached MinerU result (no API call) — handy while iterating
$PY -m bibgraph data/input/paper.pdf --reuse

# options
$PY -m bibgraph paper.pdf -o out.json --lang en --pages 1-12 \
    --no-links            # regex-only resolution
    --ocr / --no-ocr      # force OCR (default: auto-detect from text layer)
    --fresh               # ignore cache, re-call API
```

Artifacts land in `<pdf_dir>/<stem>/`: the MinerU unzip under `mineru/`
(cached) and the final `<stem>.json`.

## Output JSON

```jsonc
{
  "doc_id": "...",
  "source":  { "type": "pdf", "filename": "...", "n_pages": 12 },
  "meta":    { "title": "...", "mineru": { "model_version": "vlm", ... } },

  "structure": [                       // ordered section tree (reading order)
    { "id": "sec-2", "type": "section", "level": 1, "number": "1",
      "heading": "Introduction", "page_idx": 0,
      "blocks": [
        { "id": "p-3", "type": "paragraph", "page_idx": 0, "bbox": [...],
          "text": "As shown in [[xref:fig-1]] ... holds [[cite:ref-1;ref-2]].",
          "citations": [ { "ref_ids": ["ref-1","ref-2"], "raw": "(...)",
                           "via": "hyperlink+regex", "resolved": true } ],
          "crossrefs": [ { "kind": "figure", "target_id": "fig-1",
                           "raw": "Fig. 1", "via": "regex", "resolved": true } ] },
        { "id": "fig-1", "type": "figure", "number": "1", "label": "Figure 1",
          "caption": { "text": "...", "citations": [...], "crossrefs": [...] },
          "img_path": "images/...", "page_idx": 0, "bbox": [...] }
      ],
      "children": [ /* nested sections */ ] }
  ],

  "index":      { "figures":[...], "tables":[...], "equations":[...],
                  "code":[...], "algorithms":[...], "sections":[...] },
  "references": [ { "id": "ref-1", "raw": "...", "authors": ["Hunt","Reffert"],
                   "year": 2021, "doi": "10...", "arxiv_id": null, ... } ],
  "citations":  [ /* flattened, each + block_id */ ],
  "crossrefs":  [ /* flattened, each + block_id */ ],
  "stats":      { "n_sections": 6, "n_citations": 84,
                  "n_citations_resolved": 80, ... }
}
```

### Inline tokens

In-text citations and cross-references are replaced *in place* inside each text
body and also recorded structurally:

| token                       | meaning                                      |
|-----------------------------|----------------------------------------------|
| `[[cite:ref-12]]`           | citation → reference `ref-12`                |
| `[[cite:ref-3;ref-4]]`      | grouped citation → several references        |
| `[[xref:fig-3]]`            | cross-ref → figure block `fig-3`             |
| `[[xref:eq-2]]` / `sec-5`   | cross-ref → equation / section               |
| `[[xref:figure-9?]]`        | detected but **unresolved** cross-ref (typed)|

Block types: `paragraph`, `list`, `figure`, `table`, `equation`, `code`,
`algorithm`. `bbox` is MinerU's `[x0,y0,x1,y1]` normalized to 0–1000.

## Tests

```bash
/home/wwu/miniforge3/envs/astro/bin/python tests/run_tests.py
```

Offline suite (no API, no pytest) covering structure, references, citations,
cross-refs, text-layer `?`-gap correction, hybrid hyperlink resolution,
named-destination handling, and JSON serialization, using
`tests/fixtures/sample_content_list.json`.

## Known limitations (Phase 1)

- Link→text alignment is block-granular, not per-character.
- Reference `title`/`venue`/`volume`/`pages` are heuristic and often `null`
  (author/year/DOI/arXiv and citation linking are reliable).
- `?`-gap correction needs the PDF text layer to actually contain the glyph at
  the block's bbox; where a caption/footnote bbox overlaps the float body the
  gap is left as-is rather than risk splicing the wrong text.
- Superscript-numeral citation styles (e.g. Nature) are not yet detected by regex.
- The document title is also emitted as the first top-level section.
