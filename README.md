# ArgelanderSpace

Ingest research papers into a structured **render IR** — section tree,
floats (figures / tables / equations / code / algorithms), a structured
bibliography, and natively segmented citations and cross-references — and manage
them in a **citation-graph library** with a local **reader workspace** (web UI
with document reader, force-directed citation graph, and live ingest progress
over WebSocket).

One ingestion pipeline emits the IR:

| Pipeline | Input | Status |
|---|---|---|
| **arXiv LaTeX** | arXiv id / URL / local `.tex` / dir / tarball | ✅ the working fully-automatic source |

PDF (MinerU OCR) and publisher-HTML ingestion are **in development** — the code
is archived on the `ocr-features` branch and not part of `main` right now.

Each source tree is compiled in an isolated workspace (latexmk, pdflatex
first with an automatic xelatex retry) and fused with its own source AST
(unified-latex): the compiler's artifacts (.aux/.bbl/.toc/.fls plus an
instrumentation event stream of citations/labels/sections/equation numbers)
anchor print-faithful numbering — displayed numbers are the paper's true
printed numbers; unnumbered displays get none. Compile failures surface with
the error taxonomy and the `!`-line log excerpt. Figures materialize via
`dvisvgm` to SVG (optional; missing or failed conversions degrade the figure
gracefully, never the ingest). No Python anywhere.

ArgelanderSpace is a local single-user tool: the server binds `127.0.0.1` and
there is no authentication. LLM agents integrate through the CLI plus the pi
skills in `skills/` — see **Agent integration (skills)** below.

## Requirements

- **Node.js ≥ 20**
- **TeX Live** (`latexmk` + `pdflatex`/`xelatex` + `bibtex`/`biber` on PATH) —
  required for ingest.
- Optional: **dvisvgm** (vector PDF/EPS figures → SVG; figures degrade without
  it, ingests still succeed).

## Quickstart

```bash
npx argelanderspace serve          # → http://127.0.0.1:8000
```

Then ingest a paper and open it in the reader:

```bash
npx argelanderspace ingest 2501.17225            # arXiv id → LaTeX pipeline
npx argelanderspace library build                # seed + enrich the citation graph
```

## CLI

```
argelanderspace ingest <input>      arXiv id/URL | local .tex/dir/tarball
argelanderspace library build       rebuild the library (seed → enrich ADS▸Crossref▸OpenAlex → plan → graph)
                                    [--offline] [--bib refs.bib]
argelanderspace acquire <refs.bib>  add a .bib's works and print the acquisition plan
                                    [--dry-run] [--fetch] [--fetch-remaining] [--offline]
argelanderspace serve               API + web UI + WebSocket progress  [--port N] [--web-dist DIR]
```

Global option: `--data-dir <dir>` (may appear before or after the subcommand).
Useful ingest flags: `--no-assets` (skip figure materialization), `--no-cache`,
`-o out.json` (also write the stored IR — a `TexDocIr` document — to a path).
(`--figure-dpi` is still accepted for compatibility but ignored: figures are
vector SVG now.)

## Agent integration (skills)

LLM agents (pi-style CLI agents) drive ArgelanderSpace through the same CLI —
no MCP. The repo ships three pi skills under `skills/` that encode the
workflows:

| Skill | What it does |
|---|---|
| `argelander-paper-ingest` | arXiv id / local LaTeX → `ingest` → `library build` → confirm in `search` → asks the user for a note (agent drafts the suggestion) for every paper |
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
| `search` | every work as one JSON line — full index, the agent judges relevance (no server-side filtering); an empty-note `hint:` goes to stderr when applicable | JSONL |
| `list` | library overview + one line per ingested doc | text |
| `read <docId> [--section id] [--manifest refs\|bib]` | LLM-friendly markdown, or JSONL manifests | markdown / JSONL |
| `show <docId> <floatId>` | one figure/table/equation/code/algorithm as JSON (+ `link`) | JSON |
| `ref <docId> <refIdOrKey>` | one bibliography entry as JSON (+ `cited_in`, `link`) | JSON |
| `note <workId> [text...]` | set / print a work's note | JSON |
| `label <workId> [--label c] [--read b] [--star b] [--tags a,b]` | patch user state | JSON |

Every doc-referencing command prints a deep link
`http://localhost:<port>/doc/<docId>[#<anchor>]` (anchors: `#sec-N`, floats
`#eq-N`/`#fig-N`/`#tab-N`/`#code-N`/`#alg-N`, `#ref-N`) that opens the web
reader at exactly that spot.

## Data directory

One library per project: the default is `./literatures` under the project
root, resolved against the current working directory (no upward search — run
the CLI and `serve` from the project root). Override with `--data-dir`,
`ARGELANDERSPACE_DATA_DIR`, or the config file (below).

```
literatures/
  output/    one <doc_id>/ per ingested paper: <doc_id>.json + src/ + build/ + assets/ + fetch caches
  library/   library.json (source of truth), library.bib, cache/ (graph.json + ads/crossref/openalex)
  jobs/      asynchronous refresh/ingest job records and the upload spool
```

The server polls the data dir and broadcasts `library.changed`, so a running
web UI picks up out-of-band CLI writes (`note`, `label`, `library build`)
without a manual reload. Notes render full-text (read-only) in the web UI's
note tab; color labels and read markers are rendered in the library view.

## Configuration

Precedence, everywhere: **CLI flag > environment variable > config file >
default.**

The config file is optional: `$XDG_CONFIG_HOME/argelanderspace/config.toml`
(default `~/.config/argelanderspace/config.toml`). Unknown keys are ignored; a
known key with a wrong type is a startup error naming the key (values are
never logged or echoed).

```toml
data_dir = "/srv/papers"     # default ./literatures
port = 8000                  # server port

# API-key fallbacks (the env vars win when both are set):
openalex_api_key = "..."     # env OPENALEX_API_KEY
ads_dev_key = "..."          # env ADS_DEV_KEY, itself a fallback for ~/.ads/dev_key
```

Environment variables:

| Variable | Purpose |
|---|---|
| `ARGELANDERSPACE_DATA_DIR` | data directory |
| `ARGELANDERSPACE_PORT` | server port (default 8000) |
| `ARGELANDERSPACE_WEB_DIST` | override the bundled web UI directory |
| `OPENALEX_API_KEY` | OpenAlex premium pool (sent as `api_key`; optional) |
| `OPENALEX_MAILTO` | polite-pool identity for OpenAlex/Crossref |
| `ADS_DEV_KEY` | NASA ADS token; without any token ADS degrades to `no-token` and the rest of the library keeps working |

ADS additionally reads `~/.ads/dev_key` (the ADS convention), after the env var
and the config file.

## Stored IR (sketch)

Each `<doc_id>.json` IS the render IR (`version: 1`) — the same object the web
reader and the CLI markdown consume:

```jsonc
{
  "version": 1,
  "docId": "arxiv-2501.17225",
  "title": "...",
  "source":  { "type": "latex", "origin": "...", "main_tex": "...", "arxiv_id": "..." },
  "meta":    { "title": "...", "authors": [...], "engine": "pdflatex" },
  "sections": [ /* ordered section tree with print-faithful numbers; blocks:
                   paragraph/list/figure/table/equation/code/algorithm with
                   native text|math|cite|xref segments */ ],
  "refsManifest": [ /* section + float anchors for the refs manifest */ ],
  "bib":          [ /* bibliography manifest rows */ ],
  "references": [ { "id": "ref-1", "raw": "...", "authors": [...], "year": 2021,
                    "doi": "10...", "arxiv_id": null, ... } ],
  "citationsByBlock": { "p-7": ["ref-6"] }
}
```

In the agent-facing markdown (the `read` command), citations and
cross-references render as:

| token | meaning |
|---|---|
| `[cite: ref-12 | Author Year]` | citation → reference `ref-12` |
| `[ref: fig-3 | figure | number: 3 | <preview>]` | cross-ref → figure/equation/section |
| `[ref: figure-9 | unresolved]` | detected but unresolved cross-ref |
| `[Figure omitted | id: fig-3 | number: 3 | caption: … | path: …]` | a figure/table placeholder |

## Development

pnpm workspace (use `corepack pnpm`; Node ≥ 20):

| Package | Role |
|---|---|
| `packages/contracts` | zod contracts: stored render IR (`TexDocIr`), library payloads, job/WS DTOs |
| `packages/core` | pure domain logic: the tex ingest pipeline (compile ports, source tree, fusion, IR assembly), library/graph/planner (no I/O) |
| `packages/infra` | side-effect adapters: latexmk compile + dvisvgm figures, arXiv fetcher, ADS/Crossref/OpenAlex, config file |
| `packages/server` | Hono server: REST endpoints, static SPA, job runner, `/ws` |
| `packages/cli` | the commander program (`ingest` / `library build` / `acquire` / `serve`) |
| `packages/web` | React reader workspace (vite) |
| `packages/app` | the publishable `argelanderspace` npm package: bundles cli+server+core+infra into one ESM file + the built SPA + the `argelander.sty` instrumentation asset |

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

- **Golden-file policy**: frozen stored-IR documents under `tests/golden/tex/`
  (two arXiv LaTeX papers, re-frozen from real latexmk compiles by the tex
  pipeline) are regression fixtures; a compiler-free re-run gate replays the
  fusion half over the frozen compile artifacts. Most fusion/parser unit tests
  consume frozen compile artifacts and need no TeX toolchain; real-compile
  tests gate on a `HAVE_LATEXMK`-style availability probe.
- The pre-migration Python tree (`bibgraph/`, `server/`, `tests/run_tests.py`)
  was removed after the manual smoke test of the TS app (2026-08); it lives on
  in git history.

## License

MIT (see `LICENSE`; copyright holder: Wenjie Wu).
