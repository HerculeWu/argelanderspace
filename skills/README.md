# ArgelanderSpace agent skills

A three-skill suite that gives a pi-style CLI agent a **personal, queryable
paper library** on top of the `argelanderspace` CLI: ingest papers, deep-read
single papers with correct cross-reference/citation resolution, and answer
research questions across the whole library.

These replace the old `literature-library-skills/` suite (which drove
pandoc/latexmk and a file-layout contract directly). The methodology is the
same; the mechanics are now plain CLI calls.

## The trio

| Skill | Role | Entry point for |
|---|---|---|
| `argelander-paper-ingest/` | **A — write path.** Ingest an arXiv id / local LaTeX source, rebuild the library, then register a user-confirmed note (the agent drafts the suggestion) for every paper. (DOI/URL/PDF ingestion is in development, archived on the `ocr-features` branch.) | "add/ingest this paper", "下载 arxiv ... 加入文献库" |
| `argelander-read-paper/` | **B — deep read.** Answer questions about one ingested paper: resolves `[ref: ...]` floats via `show`, expands `[cite: ...]` via `ref`, separates the paper's own claims from cited-work metadata, cites evidence with deep links. | a specifically named paper; also the hand-off target of C |
| `argelander-query-paper-library/` | **C — retrieval across the library.** Ranks works against a research question (note is the primary signal), shows a shortlist, dispatches B per pick, synthesizes. | open-ended "用我文献库回答 ..." questions |

Data flow: **A** builds the library → **C** selects from it → **B** reads what
C selected. B and C never ingest; A never answers questions.

## Install

pi discovers skills in `~/.pi/agent/skills/` (global) or `.pi/skills/`
(project-local). Symlink (preferred — stays in sync with the repo) or copy:

```bash
# global, symlinked from this repo
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library; do
  ln -sfn "$PWD/skills/$s" ~/.pi/agent/skills/$s
done

# …or project-local (run from the project you work in, not this repo):
mkdir -p .pi/skills && cp -r /path/to/bibgraph/skills/argelander-* .pi/skills/
```

## Prerequisites

- **The `argelanderspace` CLI**: either installed (`npm i -g argelanderspace`)
  or from a built repo checkout — `corepack pnpm -r build`, then the skills use
  `node <repo>/packages/app/dist/bin.js` (absolute path) in place of
  `argelanderspace`.
- **TeX Live** (`latexmk` + `pdflatex`/`xelatex`) on PATH for the LaTeX (arXiv) ingest pipeline; optional `pdftocairo` (poppler-utils) + `gs` (ghostscript, EPS only) for vector figures.
- Optional: `ADS_DEV_KEY` / `OPENALEX_API_KEY` for richer library enrichment.
- A running server (`argelanderspace serve`) only for the deep links to open —
  the CLI itself works without it.

## The CLI–agent contract

| Command | Purpose | Output |
|---|---|---|
| `ingest <source>` | arXiv id/URL \| .tex/dir/tarball → Document JSON under `<data>/output/` | human summary |
| `library build [--offline]` | seed works from ingested docs → enrich (ADS▸Crossref▸OpenAlex) → plan → graph. **Required after ingest** — `note`/`label`/`search` only see works | JSON summary |
| `search` | every work as one JSON line (id/title/year/venue/authors/note/tags/read/star/doc_ids) — full index, the agent judges relevance | JSONL |
| `list` | library overview + one line per ingested doc (doc ids + deep links) | text |
| `read <docId> [--section id] [--manifest refs\|bib]` | LLM-friendly markdown (whole doc / section subtree), or JSONL manifests | markdown / JSONL |
| `show <docId> <floatId>` | one float (fig/tab/eq/code/alg) as JSON: full latex/caption/body/image + `link` | JSON |
| `ref <docId> <refIdOrKey>` | one bibliography entry as JSON: metadata + `cited_in` + `link` | JSON |
| `annot <docId>` | a doc's current annotations (the user's reading notes/requests) as JSONL rows `{id, doc_id, target, context, body, created_at, updated_at, link}` in reading order, document-level first — read-only; annotations bound to a since-replaced document are hidden (fixed `note:` on stderr, exit 0), archived ones are never exposed | JSONL |
| `note <workId> [text...]` | set (or print) a work's note | JSON |
| `label <workId> [--label c] [--read b] [--star b] [--tags a,b]` | patch user state, print the result | JSON |

Conventions the skills rely on:

- **The CLI is the only interface**: agents never read repo source code or the
  JSON files under `literatures/` to answer library questions — each skill
  carries this as a hard rule up front.
- **One library per project**: the default data dir is `./literatures` under
  the project root, resolved against the *current working directory* with **no
  upward search** — run the CLI from the project root and don't pass
  `--data-dir` (it survives only as an escape hatch; chain: flag >
  `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`). The
  old `LITERATURE_LIBRARY` env var is dead.
- **Two id families**: works (`arxiv:…` / `doi:…` — `search`, `note`, `label`)
  vs docs (`arxiv-…` — `read`, `show`, `ref`, `list`). `search` rows map one to
  the other via `doc_ids`.
- **Deep links**: every doc-referencing command prints
  `http://localhost:<port>/doc/<docId>[#<anchor>]` (anchors: `#sec-N`,
  `#eq-N`/`#fig-N`/`#tab-N`/`#code-N`/`#alg-N`, `#ref-N`, `#ann-<id>`). Port:
  `ARGELANDERSPACE_PORT` > config `port` > 8000 — if `serve` runs on a custom
  `--port`, export `ARGELANDERSPACE_PORT` so printed links match.
- **Machine-clean stdout**: JSONL streams (`search`, `read --manifest`) stay
  pure; headers go to stderr. `search` also prints
  `hint: N/M works have empty notes` on stderr when any works lack notes — the
  query skill treats it as the cue to offer note backfill. Errors are
  `error: <message>` on stderr with exit code 1, and "unknown id" errors list
  the available candidates.
- **Out-of-band writes are picked up automatically**: the server polls
  `library.json` + `output/` and broadcasts `library.changed`, so a running
  webui refreshes itself after CLI writes (`note` / `label` /
  `library build`) — no manual reload needed.

## Operational lessons carried over (still true)

1. **Verify arXiv ids before ingest** — never guess an id from author+year.
2. **arXiv is the only fully-automatic source** — publisher HTML/PDF ingestion
   is in development (archived on the `ocr-features` branch); a LaTeX source
   package upload (zip) in the web UI is being rebuilt.
3. **Notes are load-bearing** — every ingested paper gets a user-confirmed
   note, or C can't rank it.
