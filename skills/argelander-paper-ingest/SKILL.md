---
name: argelander-paper-ingest
description: Ingest a paper (arXiv id / local .tex source / source dir / tarball) into the ArgelanderSpace library via the `argelanderspace` CLI. Use this whenever the user wants to "add a paper to the library", "ingest this paper", "下载 arxiv ... 加入文献库", "把这篇论文加进我的文献库", or provides a LaTeX source and asks for it to be processed for later LLM-based reading. (DOI/publisher-URL/PDF ingestion is in development — archived on the `ocr-features` branch; the CLI answers such inputs with a friendly in-development error.) Runs ingest → library build → confirmation, then asks the user for a note (with a drafted suggestion) for every ingested paper.
---

# argelander-paper-ingest

Add a paper to the user's ArgelanderSpace library so that `argelander-read-paper` (deep reading) and `argelander-query-paper-library` (cross-library questions) can use it. Everything goes through the `argelanderspace` CLI — there is no file-layout contract to maintain by hand.

## Non-negotiable: the CLI is the only interface

**Never read source code — not the ArgelanderSpace repo's, not any other project's — to answer a question about the user's papers or library.** If you catch yourself opening `.ts`/`.py` files, grepping a repository, or hand-reading `literatures/library.json` / Document JSON files, you are on the wrong path: stop and run the CLI instead. Reading source to answer library questions is how stale, wrong, or fabricated answers happen.

## When to use

Trigger whenever the user wants to make a paper available in their library:

- "add this paper to my library / 加入文献库 / 加进库里"
- "ingest the paper at <path>" / "下载 arxiv 2607.17040 加进库里"
- providing a local `.tex` file / source dir / tarball and asking you to "process" or "ingest" it

A local PDF or a DOI/publisher URL is NOT ingestible right now (that pipeline
is in development): the CLI will say so — don't retry it; look for the arXiv
version instead.

Do NOT use this skill to answer questions about a paper — that's `argelander-read-paper` (one paper) or `argelander-query-paper-library` (the whole library).

## Configuration

- **The CLI**: run `argelanderspace`. If it is not on PATH, use the built bundle from the repo checkout by absolute path — `node /path/to/repo/packages/app/dist/bin.js` (build once with `corepack pnpm -r build` inside the repo). All examples below write `argelanderspace` — substitute as needed.
- **Data directory**: one library per project, at `./literatures` under the **project root** (the directory that contains `literatures/`). The default resolves against the *current working directory* with **no upward search**, so **run every CLI command from the project root** — if your shell is somewhere else, `cd` there first. Do **not** pass `--data-dir`; it survives only as an escape hatch for unusual layouts (chain: `--data-dir` flag > `ARGELANDERSPACE_DATA_DIR` env > `config.toml` `data_dir` > `./literatures`). The old `LITERATURE_LIBRARY` env var is dead; do not look for it.
- **LaTeX pipeline prerequisite**: `pandoc` must be on PATH for arXiv / local-LaTeX ingest.

## Inputs the user might give

1. **An arXiv id** (`2607.17040`, `2607.17040v2`) or arXiv URL → LaTeX pipeline. *The reliable path.*
2. **A local `.tex` file, source directory, or tarball** → LaTeX pipeline.
3. **A DOI, publisher URL, or local PDF** → not ingestible on main (in development, archived on `ocr-features`). Find the arXiv version instead — most astro papers have one.

The CLI auto-detects the pipeline from the input form; you do not pick it yourself.

## Workflow

### Step 0 — Resolve the CLI and the working directory

Decide the `argelanderspace` invocation once, and `cd` to the project root (the directory containing `literatures/`) before running anything — use both consistently for the whole session. If you don't know which directory the user's server runs on, ask.

### Step 1 — Verify the arXiv id BEFORE ingesting (arXiv inputs only)

**Never trust an arXiv id you constructed yourself** — never extrapolate one from author+year patterns. In an earlier project's first batch ingest, 3 of 10 guessed ids were unrelated particle-physics papers, and each caused a full download→convert→register→teardown cycle.

- If the user gave the id explicitly: still spot-check it — `curl -sL https://arxiv.org/abs/<id>` and read the `<title>`, or WebSearch the id. Tell the user the matched title ("arXiv 2607.17040 = *Disentangling the Morphology of Palomar 5…*, 是这篇吗？") before or right after ingesting.
- If the user gave a title / DOI / bibcode instead: WebSearch it (or check `https://ui.adsabs.harvard.edu/abs/<bibcode>/abstract`) to find the arXiv id, show the user the match, then ingest the arXiv id.
- If the id 404s on the abs page, it does not exist. Say so; do not "fix" it by guessing a nearby id.

### Step 2 — Ingest

```bash
argelanderspace ingest <source>
```

Watch the trailing summary: `n_sections`, `n_references`, `citations: N (M resolved)`, `crossrefs: N (M resolved)`. If resolution rates look broken (e.g. most citations unresolved), say honestly which parts of the paper will be unreliable to read — don't pretend success.

### Step 3 — Library build (REQUIRED — ingest alone is not enough)

`ingest` only writes the document JSON under `literatures/output/<doc_id>/`. The paper does **not** exist as a library work — and `note`/`label` will fail with `error: unknown work ...` — until you rebuild:

```bash
argelanderspace library build
```

- Plain `library build` enriches online (ADS ▸ Crossref ▸ OpenAlex): citation counts, venue, DOI, graph edges. Prefer this when the network is fine.
- `--offline` skips the live Crossref/OpenAlex calls (ADS still runs when a token exists — inherited behavior). Offline is enough to make the work appear in `search` with the title/authors from the document itself; choose it for batch ingests or when the enrichment APIs are unreachable, and mention that metadata will be thinner.

### Step 4 — Confirm the work exists

```bash
argelanderspace search | grep -i <title word or arxiv id>
```

Find the new row. Record two different ids — you will need both:

- the **work id** (`id` field, canonical: `doi:...` > `arxiv:...` > `openalex:...` > `work:<slug>`) — for `note` / `label`;
- the **doc id(s)** (`doc_ids` field, e.g. `arxiv-2607.17040`) — for `read` / `show` / `ref` and deep links.

If the row is missing, the build didn't pick the doc up — check that the ingest summary actually printed and that both commands ran from the project root.

### Step 5 — The note (for EVERY paper, no exceptions)

The note is the primary relevance signal for `argelander-query-paper-library` ("in what scenario would I want to re-consult this paper?"). A library without notes is a library that can't be queried well. **For every ingested paper, even when the user didn't ask for one:**

1. Draft a suggested note yourself from the title + abstract, phrased as "在 X 场景下回查此文" — one or two sentences, scenario-first.
2. Present it and ask the user to confirm or edit:

   > 我建议给这篇写一条 note：**"在需要 Palomar 5 潮汐尾形态学、银河系势场（棒/旋臂/LMC）对尾形态影响时回查此文"**。这是后续按需在文献库里检索它的主要依据。直接用这条，还是你来改？

3. Write the confirmed text:

   ```bash
   argelanderspace note <work_id> <the note text>
   ```

   The text is variadic — no quoting needed. Running `note` with no text prints the current note (use this to verify the write).

If the user explicitly declines the note, record that they declined and move on — but always offer.

### Step 6 — Optional tags

If the user gave tags (or the topic clearly maps to their existing tag conventions):

```bash
argelanderspace label <work_id> --tags tidal-tails,gaia
```

`--tags` replaces the whole set; comma-separated; empty string clears.

### Step 7 — Report

Tell the user: the work id, the doc id, title/authors/year as recorded, the note that was stored, any conversion warnings worth double-checking, and the deep link to open it in the webui:

```
http://localhost:<port>/doc/<doc_id>
```

(`<port>` is what the user's `serve` runs on; the CLI prints links using `ARGELANDERSPACE_PORT` > config `port` > 8000.)

## No arXiv version? (2026-08, measured)

Publisher full text is mostly **not** machine-fetchable (bot walls), and the
PDF/HTML ingestion pipelines are off main while being reworked:

| Site | Status |
|---|---|
| aanda.org (A&A) | 403 — DataDome captcha |
| academic.oup.com (MNRAS) | 403 — Cloudflare |
| iopscience.iop.org (AAS/IOP) | human-verification page — Radware |
| journals.aps.org | 403 — Cloudflare |

So: **prefer the arXiv path.** When the user hands you a DOI/publisher URL,
first look for the arXiv version (most astro papers have one) and ingest that
instead. When there is genuinely no arXiv version, tell the user PDF ingestion
is in development and stop — do not retry the DOI in a loop.

## Failure modes and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| `error: HTTP 404 for https://arxiv.org/e-print/<id>` | wrong/fake arXiv id, or the paper has no LaTeX source on arXiv | Re-verify the id (Step 1). If the id is right but source-less, tell the user there is no ingestible source right now |
| `error: cannot ingest DOI/publisher URL … in development …` | PDF/HTML ingestion is off main | Expected — find the arXiv version; do not retry |
| `error: unknown work "<id>"` from `note`/`label` | you skipped Step 3, or used a doc id where a work id belongs | Run `library build`; use the `id` field from `search`, not `doc_ids` |
| Re-ingesting an already-ingested source | normal (idempotent; the doc is rewritten, the work merges by DOI/arXiv/title) | Tell the user before overwriting; the existing note is kept by the merge, confirm whether to keep or replace it |
| Ingest summary shows most citations/crossrefs unresolved | conversion artifacts (macro-heavy source) | Say honestly which sections will read unreliably; offer to inspect specific sections |

## Why the workflow is structured this way

- **Verify ids first**: a wrong id costs a full failed ingest cycle and can silently register the wrong paper. Ten seconds of checking is cheaper.
- **`library build` is explicit**: ingest and library registration are separate stages; the work (and therefore notes/tags) only exists after the build. Never tell the user a paper is "in the library" before Step 4 confirms it.
- **Notes are required**: the query skill ranks papers by note. Skipping the note makes the library progressively less searchable.
