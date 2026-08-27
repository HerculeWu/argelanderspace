# ArgelanderSpace

Ingest research papers into a structured **Document JSON** — section tree,
floats (figures / tables / equations / code / algorithms), a structured
bibliography, and inline-tokenized citations and cross-references — and manage
them in a **citation-graph library** with a local **reader workspace** (web UI
with document reader, force-directed citation graph, and live ingest progress
over WebSocket).

Three ingestion pipelines emit the *same* Document JSON:

| Pipeline | Input | Status (2026-08) |
|---|---|---|
| **arXiv LaTeX** | arXiv id / URL / local `.tex` / dir / tarball | ✅ the working fully-automatic source |
| **PDF** | local PDF (born-digital or scan) | ✅ via the [MinerU](https://mineru.net) API (`MINERU_API_KEY` required); extractions are cached on disk |
| **Publisher HTML** | DOI / publisher URL | ⚠️ A&A and OUP adapters exist, but both sites are bot-walled (DataDome / Cloudflare) as of 2026-08 — kept as standby capability, not currently fetchable |

Citation/cross-reference resolution is authoritative for LaTeX (`\cite` /
`\ref`) and publisher HTML (page anchors); for PDFs it combines hyperlink
annotations (hyperref named destinations) with a regex fallback, repaired by a
text-layer pass over MinerU's OCR gaps. PDF rendering and text extraction use
the official `mupdf` WASM build — no Python anywhere.

ArgelanderSpace is a local single-user tool: the server binds `127.0.0.1` and
there is no authentication. LLM agents integrate through the CLI plus the pi
skills in `skills/` — see **Agent integration (skills)** below.

## Requirements

- **Node.js ≥ 20**
- Optional: **pandoc** (LaTeX pipeline parsing + MathML→LaTeX), **Ghostscript**
  (EPS figures in old arXiv sources)

## Quickstart

```bash
npx argelanderspace serve          # → http://127.0.0.1:8000
```

Then ingest a paper and open it in the reader:

```bash
npx argelanderspace ingest 2501.17225            # arXiv id → LaTeX pipeline
npx argelanderspace ingest paper.pdf             # PDF → MinerU pipeline
npx argelanderspace library build                # seed + enrich the citation graph
```

## CLI

```
argelanderspace ingest <input>      PDF path | DOI / publisher URL | arXiv id/URL | local .tex/dir/tarball
argelanderspace library build       rebuild the library (seed → enrich ADS▸Crossref▸OpenAlex → plan → graph)
                                    [--offline] [--bib refs.bib]
argelanderspace acquire <refs.bib>  add a .bib's works and print the acquisition plan
                                    [--dry-run] [--fetch] [--fetch-remaining] [--offline]
argelanderspace serve               API + web UI + WebSocket progress  [--port N] [--web-dist DIR]
```

Global option: `--data-dir <dir>` (may appear before or after the subcommand).
Useful ingest flags: `--ocr` / `--no-ocr` (default: auto-detect from the text
layer), `--fresh` (ignore the MinerU cache), `--no-assets`, `--no-subpages`,
`--no-cache`, `-o out.json` (also write the Document JSON to a path).

**MinerU quota**: the PDF pipeline calls the hosted MinerU API on every cache
miss, and the free tier is roughly **1000 pages/day**. Single papers are fine,
but a heavy batch of PDF ingests can burn a day's quota — plan batches
accordingly. Extractions are cached on disk, so re-ingesting an already-seen
PDF is free (unless `--fresh`).

## Agent integration (skills)

LLM agents (pi-style CLI agents) drive ArgelanderSpace through the same CLI —
no MCP. The repo ships three pi skills under `skills/` that encode the
workflows:

| Skill | What it does |
|---|---|
| `argelander-paper-ingest` | arXiv id / DOI / URL / local LaTeX / PDF → `ingest` → `library build` → confirm in `search` → asks the user for a note (agent drafts the suggestion) for every paper |
| `argelander-read-paper` | Deep-read one ingested doc: resolves equations/figures/tables via `show`, citations via `ref`, keeps paper claims vs cited work apart, cites evidence as deep links |
| `argelander-query-paper-library` | Ranks the whole library against a research question (`note` is the primary signal), shows a shortlist, hands picks to read-paper, synthesizes with work ids + deep links |

Install by symlinking into pi's skills directory (`~/.pi/agent/skills/`
globally, or `.pi/skills/` in a project):

```bash
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library; do
  ln -sfn "$PWD/skills/$s" ~/.pi/agent/skills/$s
done
```

The CLI–agent contract in one table (details + output conventions in
`skills/README.md`):

| Command | Purpose | Output |
|---|---|---|
| `search` | every work as one JSON line — full index, the agent judges relevance (no server-side filtering) | JSONL |
| `list` | library overview + one line per ingested doc | text |
| `read <docId> [--section id] [--manifest refs\|bib]` | LLM-friendly markdown, or JSONL manifests | markdown / JSONL |
| `show <docId> <floatId>` | one figure/table/equation/code/algorithm as JSON (+ `link`) | JSON |
| `ref <docId> <refIdOrKey>` | one bibliography entry as JSON (+ `cited_in`, `link`) | JSON |
| `note <workId> [text...]` | set / print a work's note | JSON |
| `label <workId> [--label c] [--read b] [--star b] [--tags a,b]` | patch user state | JSON |

Every doc-referencing command prints a deep link
`http://localhost:<port>/doc/<docId>[#<anchor>]` (anchors: `#sec-N`, floats
`#eq-N`/`#fig-N`/`#tab-N`/`#code-N`/`#alg-N`, `#ref-N`) that opens the web
reader at exactly that spot. Agents may also trigger PDF OCR freely — but see
the MinerU quota note above before letting one loose on a batch of PDFs.

## Data directory

Default `./data`; override with `--data-dir`, `ARGELANDERSPACE_DATA_DIR`, or
the config file (below).

```
data/
  output/    one <doc_id>/ per ingested paper: <doc_id>.json + assets/ + fetch caches
  library/   library.json (source of truth), library.bib, cache/ (graph.json + ads/crossref/openalex)
  jobs/      asynchronous ingest/upload job records and the upload spool
```

## Configuration

Precedence, everywhere: **CLI flag > environment variable > config file >
default.**

The config file is optional: `$XDG_CONFIG_HOME/argelanderspace/config.toml`
(default `~/.config/argelanderspace/config.toml`). Unknown keys are ignored; a
known key with a wrong type is a startup error naming the key (values are
never logged or echoed).

```toml
data_dir = "/srv/papers"     # default ./data
port = 8000                  # server port

# API-key fallbacks (the env vars win when both are set):
mineru_api_key = "..."       # env MINERU_API_KEY
openalex_api_key = "..."     # env OPENALEX_API_KEY
ads_dev_key = "..."          # env ADS_DEV_KEY, itself a fallback for ~/.ads/dev_key
```

Environment variables:

| Variable | Purpose |
|---|---|
| `ARGELANDERSPACE_DATA_DIR` | data directory |
| `ARGELANDERSPACE_PORT` | server port (default 8000) |
| `ARGELANDERSPACE_WEB_DIST` | override the bundled web UI directory |
| `MINERU_API_KEY` | MinerU v4 extraction (PDF pipeline; only needed on a cache miss) |
| `OPENALEX_API_KEY` | OpenAlex premium pool (sent as `api_key`; optional) |
| `OPENALEX_MAILTO` | polite-pool identity for OpenAlex/Crossref |
| `ADS_DEV_KEY` | NASA ADS token; without any token ADS degrades to `no-token` and the rest of the library keeps working |

ADS additionally reads `~/.ads/dev_key` (the ADS convention), after the env var
and the config file.

## Output JSON (sketch)

```jsonc
{
  "doc_id": "arxiv-2501.17225",
  "source":  { "type": "latex", ... },
  "meta":    { "title": "...", ... },
  "structure": [ /* ordered section tree; blocks: paragraph/list/figure/table/
                    equation/code/algorithm, each with text + citations +
                    crossrefs */ ],
  "references": [ { "id": "ref-1", "raw": "...", "authors": [...], "year": 2021,
                    "doi": "10...", "arxiv_id": null, ... } ],
  "stats":   { "n_sections": 6, "n_citations": 84, ... }
}
```

In-text citations and cross-references are replaced *in place* with inline
tokens and also recorded structurally:

| token | meaning |
|---|---|
| `[[cite:ref-12]]` | citation → reference `ref-12` |
| `[[cite:ref-3;ref-4]]` | grouped citation |
| `[[xref:fig-3]]` / `[[xref:eq-2]]` / `[[xref:sec-5]]` | cross-ref → figure / equation / section |
| `[[xref:figure-9?]]` | detected but unresolved cross-ref |

## Development

pnpm workspace (use `corepack pnpm`; Node ≥ 20):

| Package | Role |
|---|---|
| `packages/contracts` | zod contracts: Document JSON, library payloads, job/WS DTOs |
| `packages/core` | pure domain logic: documents, pipelines, library/graph/planner (no I/O) |
| `packages/infra` | side-effect adapters: mupdf, pandoc, MinerU, ADS/Crossref/OpenAlex, fetchers, config file |
| `packages/server` | Hono server: 8 REST endpoints, static SPA, job runner, `/ws` |
| `packages/cli` | the commander program (`ingest` / `library build` / `acquire` / `serve`) |
| `packages/web` | React reader workspace (vite) |
| `packages/app` | the publishable `argelanderspace` npm package: bundles cli+server+core+infra into one ESM file + the built SPA (mupdf stays an external dependency) |

```bash
corepack pnpm install
corepack pnpm -r build        # all packages, incl. the SPA and the app bundle
corepack pnpm -r test         # vitest suites (offline)
corepack pnpm -r typecheck
corepack pnpm lint            # biome
```

Packing the npm tarball (kept out of the repo):

```bash
corepack pnpm -r build
cd packages/app && npm pack
```

Testing notes:

- **Golden-file policy**: the TS pipelines are a bug-for-bug port of the
  original Python implementation; golden Document JSONs under `tests/golden/`
  gate the port field-by-field. The publisher-HTML fixtures are archived fetch
  caches — the live sites are bot-walled, these copies are the only ones.
- The pre-migration Python tree (`bibgraph/`, `server/`, `tests/run_tests.py`)
  was removed after the manual smoke test of the TS app (2026-08); it lives on
  in git history.

## License

MIT (see `LICENSE`; copyright holder: Wenjie Wu).

One dependency is **not** MIT: [`mupdf`](https://www.npmjs.com/package/mupdf)
is AGPL-3.0-or-later (Artifex, commercial licenses available). It is installed
as a normal npm dependency — its code is not bundled into this package — the
same relationship the Python original had with PyMuPDF. If that matters to
your use, review it before distributing.
