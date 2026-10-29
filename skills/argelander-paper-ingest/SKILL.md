---
name: argelander-paper-ingest
description: Add a paper to the ArgelanderSpace library — an arXiv id or URL (LaTeX source), a DOI or ADS bibcode, a local PDF, or a local LaTeX source (.tex file / source dir / tarball) — so it can be read and queried. Use this whenever the user wants to "add a paper to the library", "ingest this paper", "下载 arxiv ... 加入文献库", "把这篇论文加进我的文献库", or provides a LaTeX source or PDF and asks for it to be processed for later LLM-based reading. Ends with a user-confirmed note (with a drafted suggestion) for every ingested paper.
---

# argelander-paper-ingest

Add a paper to the user's ArgelanderSpace library so that `argelander-read-paper` (deep reading) and `argelander-query-paper-library` (cross-library questions) can use it. A paper becomes readable in two steps: a **Work** (the library entry: identity and metadata) and a **Doc** (its body: LaTeX or PDF). The doc id and the work id are different ids; keep both.

## Two entries

This guide serves the Copilot (in the workbench) and external agents (a shell with the `argelanderspace` CLI). One operation, two ways to call it. The CLI prints one JSON answer on stdout, the same one the Copilot's tool returns.

| Step | Operation | Copilot (`library` tool, action) | External agent |
|---|---|---|---|
| Add the Work | `library.import_works` | `import_works` `{"mode":"identifier","text":"arXiv:2607.17040"}`; `"mode":"bibcode"`; `"mode":"bib"` with BibTeX text | `argelanderspace library import-works --mode identifier --text 'arXiv:2607.17040'`; `--mode bibcode`; `--mode bib` |
| Get the arXiv LaTeX source as a Doc | `library.attach_arxiv` | `attach_arxiv` `{"refId":"<workId>"}` | `argelanderspace library attach-arxiv --ref-id <workId>` |
| Get the arXiv PDF as a Doc | `library.acquire_arxiv_pdf` | `acquire_arxiv_pdf` `{"refId":…}` | `argelanderspace library acquire-arxiv-pdf --ref-id <workId>` |
| Attach a local PDF as a Doc | `library.attach_local_pdf` | `attach_local_pdf` `{"refId":…,"path":"<absolute path>"}` | `argelanderspace library attach-local-pdf --ref-id <workId> --path <absolute path>` |
| Check the jobs | `library.read_jobs` | `read_jobs` `{"refId":…}` | `argelanderspace library read-jobs --ref-id <workId>` |
| Find the Work | `library.read` | `read` `{"query":"<doi, arXiv id or title>"}` | `argelanderspace library read --query '<doi, arXiv id or title>'` |
| Local LaTeX source | none | cannot: tell the user to ingest it with the command line | `argelanderspace ingest <source>`, then `argelanderspace library build` |
| Note, tags | none | cannot: give the user the text and the command | `argelanderspace note <workId> <text>`; `argelanderspace label <workId> --tags a,b` |

Operation names are the tool and action (`library.read_jobs` = tool `library`, action `read_jobs`); the CLI command is `argelanderspace library read-jobs`.

CLI conventions for the catalog commands: exit 0 means `ok` (or `noop`); 1 means the operation answered `ok:false` (`not_found`, `conflict`, `rejected`, `error`, `workbench_required`) or failed; 2 means invalid parameters and nothing ran; 3 means the user refused a confirmation card on the workbench; 4 means the workbench went away while the card was open (read the Work before retrying); 130 means you interrupted it. `--json <file|->` takes all parameters as one object (not combined with options). A running workbench for the same project executes the command itself; without one, the command runs in its own process.

## Non-negotiable: operations and the CLI are the only interface

**Never read source code — not the ArgelanderSpace repo's, not any other project's — to answer a question about the user's papers or library.** If you catch yourself opening `.ts`/`.py` files, grepping a repository, or hand-reading `literatures/library.json` / Document JSON files, you are on the wrong path: stop and use the operations instead. Reading source to answer library questions is how stale, wrong, or fabricated answers happen. Never write inside the data folder by hand.

## When to use

Trigger whenever the user wants to make a paper available in their library:

- "add this paper to my library / 加入文献库 / 加进库里"
- "ingest the paper at <path>" / "下载 arxiv 2607.17040 加进库里"
- providing a local `.tex` file / source dir / tarball / PDF and asking you to "process" or "ingest" it

Do NOT use this skill to answer questions about a paper — that's `argelander-read-paper` (one paper) or `argelander-query-paper-library` (the whole library). To find papers that are not collected yet, use `argelander-find-papers`.

## Configuration (external agents)

- **The CLI**: run `argelanderspace`. If it is not on PATH, use the built bundle from the repo checkout by absolute path — `node /path/to/repo/packages/app/dist/bin.js`. All examples below write `argelanderspace` — substitute as needed.
- **Data directory**: one library per project, at `./literatures` under the **project root** (the directory that contains `literatures/`). The default resolves against the *current working directory* with **no upward search**, so **run every CLI command from the project root**. Do **not** pass `--data-dir`; it survives only as an escape hatch for unusual layouts (chain: `--data-dir` flag > `config.toml` `data_dir` > `./literatures`). No environment variable sets the data dir.
- **Prerequisite for LaTeX**: **TeX Live** (`latexmk` + `pdflatex`/`xelatex`) compiles arXiv and local LaTeX sources — found in the directory `tex_dir` of `config.toml` names (absolute path), else on PATH, else in the platform's usual install locations. The workbench's settings page (*TeX & environment*) shows what was found. `pdftocairo` (poppler-utils) is optional (vector PDF figures → SVG; plus `gs`/ghostscript for EPS).
- The ADS token for DOI/bibcode resolution is the one saved in the workbench's settings; never ask for it in the conversation.

## What the user can give

1. **An arXiv id** (`2607.17040`, `2607.17040v2`) or arXiv URL → Work by `import_works` (`arXiv:<id>`), then its LaTeX source by `attach_arxiv`. *The reliable path.*
2. **A DOI or ADS bibcode** → Work by `import_works` (`mode` `identifier` with the DOI, or `bibcode`). It has no Doc yet: when the Work has an arXiv id, go on as in 1; otherwise the body must come from a PDF (`attach_local_pdf`, the user's file) or a LaTeX package the user uploads on the Files tab. A publisher URL carrying a DOI works as the DOI; the CLI's `ingest <doi-or-publisher-url>` also creates such a Doc-less entry.
3. **A local PDF** → the Work must exist first (import it by DOI/bibcode/BibTeX, or find it), then `attach_local_pdf` with the absolute path. The file is only read.
4. **A local `.tex` file, source dir or tarball** → external agents: `argelanderspace ingest <source>` then `library build` (Step 4). The Copilot cannot do this.
5. **BibTeX text** → `import_works` with `mode` `bib` (complete entries); no bodies.

Publisher full text is mostly **not** machine-fetchable (bot walls: aanda.org, academic.oup.com, iopscience.iop.org, journals.aps.org all block scripts). Prefer the arXiv path; when the user hands you a DOI or publisher URL, look for the arXiv version first. When there is genuinely no arXiv version, say so and ask the user for the PDF file (or the LaTeX package) instead of retrying the publisher site.

## Workflow

### Step 1 — Verify the arXiv id BEFORE importing (arXiv inputs only)

**Never trust an arXiv id you constructed yourself** — never extrapolate one from author+year patterns. In an earlier project's first batch ingest, 3 of 10 guessed ids were unrelated particle-physics papers, and each caused a full download→convert→register→teardown cycle.

- If the user gave the id explicitly: still spot-check it — fetch `https://arxiv.org/abs/<id>` and read the `<title>`, or search the web for the id. Tell the user the matched title ("arXiv 2607.17040 = *Disentangling the Morphology of Palomar 5…*, 是这篇吗？") before or right after importing.
- If the user gave a title / DOI / bibcode instead: find the arXiv id with `discovery.search_ads` (see `argelander-find-papers`), show the user the match, then import the arXiv id.
- If the id 404s on the abs page, it does not exist. Say so; do not "fix" it by guessing a nearby id.

### Step 2 — Add the Work

```bash
argelanderspace library import-works --mode identifier --text 'arXiv:2607.17040'
```

An arXiv id needs the `arXiv:` prefix; a bare id is rejected. The answer has `results` (one per entry) with `status` `created` or `exists` (the Work was already saved: no second entry) and `ref` (the Work: `ref.id` is the **work id**, `ref.title` its title). Say which it was. `status:"rejected"` means the import would merge Works that are already in the library; nothing was written. Tell the user, who resolves them on the Library page. An `error` entry names its reason (ADS or the network did not answer): report it, do not loop.

Through a running workbench a single arXiv/bibcode import also queues the arXiv PDF job when the user's setting `auto_ingest_arxiv` is on; without a workbench nothing is queued.

Re-importing something already imported is normal and harmless; the existing note and flags stay.

### Step 3 — Get the body

A Work with an arXiv id → its LaTeX source:

```bash
argelanderspace library attach-arxiv --ref-id <workId>
```

The command waits for the job (the workbench queue: up to 240 seconds, then it answers `pending` and the job keeps running; without a workbench it waits until the job ends). A `pending` answer is not a failure: look with `argelanderspace library read-jobs --ref-id <workId>` and never submit the job again. `ok` names the job and the Doc it made. `error` carries the job's error: report it.

If the Work already has an arXiv LaTeX Doc, `attach_arxiv` refreshes it: that replaces the text and may archive the user's annotations, so it waits for the user's confirmation on a card in the workbench (CLI exit 3 = refused, 4 = the workbench left; with no workbench it answers `workbench_required`). Tell the user before asking for it; never work around the card.

An arXiv PDF as a Doc is `acquire_arxiv_pdf` (each successful call makes one more Doc, so do not repeat it after `ok` or `pending`). A local PDF is `attach_local_pdf` with an absolute path: `ok` names the new Doc, `noop` means the same bytes are already a Doc of that Work; other reasons (`too_large`, `page_limit`, `not_a_pdf`, `encrypted`, `file_tools_off`, …) say what is wrong, and `pending` means the upload job is still running (use `read_jobs`).

Local LaTeX source (external agents):

```bash
argelanderspace ingest <source>
argelanderspace library build
```

Watch the trailing summary of `ingest`: `n_sections`, `n_references`, `citations: N (M resolved)`, `crossrefs: N (M resolved)`. If resolution rates look broken (most citations unresolved), say honestly which parts of the paper will be unreliable to read. `ingest` writes only the document JSON under `literatures/output/<doc_id>/`; the paper is not a library work — and `note`/`label` fail with `error: unknown work …` — until `library build` has run. Plain `library build` enriches online (ADS ▸ Crossref ▸ OpenAlex); `--offline` skips the live Crossref/OpenAlex calls (choose it for batch ingests or when the APIs are unreachable, and mention that metadata will be thinner). These two older commands write directly and do not go through a running workbench: do not run them while the workbench is working on the same paper; an open page refreshes itself after them. The same `ingest` also takes an arXiv id or URL.

### Step 4 — Confirm the work exists

```bash
argelanderspace library read --query '<arXiv id, DOI or title word>'
```

Find the new row. Record two different ids — you will need both:

- the **work id** (`id`; canonical: `doi:...` > `arxiv:...` > `openalex:...` > `work:<slug>`) — for `note` / `label` and `library` operations;
- the **doc id(s)** (`doc_ids`, e.g. `arxiv-2607.17040`; the first is the main Doc) — for `read` / `show` / `ref` and deep links. `argelanderspace list` shows the Docs too.

If the row is missing, the import did not happen; check the answer you got. If the Work has no `doc_ids`, say so — it has no readable body yet. Never tell the user a paper is "in the library" before this step confirms it.

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

The Copilot has no operation that writes a note: it gives the user the confirmed text together with this command to run themselves. If the user explicitly declines the note, record that they declined and move on — but always offer.

### Step 6 — Optional tags

If the user gave tags (or the topic clearly maps to their existing tag conventions):

```bash
argelanderspace label <work_id> --tags tidal-tails,gaia
```

`--tags` replaces the whole set; comma-separated; empty string clears. (The Copilot hands the command to the user, as with notes.)

### Step 7 — Report

Tell the user: the work id, the doc id, title/authors/year as recorded, the note that was stored (or the command to store it), any conversion warnings worth double-checking, and the deep link to open it in the workbench:

```
http://localhost:<port>/doc/<doc_id>
```

(`<port>` is what the user's `serve` runs on; the CLI prints links using config.toml `port` > 1859.) With a workbench open, `argelanderspace open doc --doc-id <doc_id>` shows it directly; the Copilot does the same with `workspace.open_doc` when asked.

## Failure modes and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| `error: HTTP 404 for https://arxiv.org/e-print/<id>` or an `attach_arxiv` job error about the source | wrong/fake arXiv id, or the paper has no LaTeX source on arXiv | Re-verify the id (Step 1). If the id is right but source-less, ask the user for a PDF (`attach_local_pdf`) |
| `import_works` `error`, reason `ads_unavailable`, `rate_limited`, `timeout`, `unreachable` | ADS or the network | Temporary; report it and offer a retry later; do not loop |
| reason `no_token` / `unauthorized` | the ADS token in the workbench settings | Tell the user to fix it in Settings; never ask for the token |
| `import_works` `status:"rejected"` | the import would merge Works already in the library | Nothing written; the user resolves them on the Library page |
| `workbench_required` (exit 1) | a command that needs the user's card (refreshing an arXiv Doc) with no workbench running | Ask the user to open ArgelanderSpace on this project, then repeat; the command never starts it |
| `error: unknown work "<id>"` from `note`/`label` | the Work was not built into the library (`ingest` without `library build`), or a doc id was used where a work id belongs | Run `library build`; use the work id (`id`), not `doc_ids` |
| Re-ingesting an already-ingested source | normal (idempotent; the Doc is rewritten, the work merges by DOI/arXiv/title) | Tell the user before overwriting; the existing note is kept by the merge, confirm whether to keep or replace it |
| Ingest summary shows most citations/crossrefs unresolved | conversion artifacts (macro-heavy source) | Say honestly which sections will read unreliably; offer to inspect specific sections |

## Why the workflow is structured this way

- **Verify ids first**: a wrong id costs a full failed ingest cycle and can silently register the wrong paper. Ten seconds of checking is cheaper.
- **Work first, body second**: the Work carries identity and metadata, the Doc is the readable body; either can exist without the other. Never tell the user a paper is "readable" before it has a Doc.
- **Notes are required**: the query skill ranks papers by note. Skipping the note makes the library progressively less searchable.
