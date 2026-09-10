---
name: argelander-read-paper
description: Read a single ingested paper from the ArgelanderSpace library and answer questions about it accurately — resolving cross-references (equations, figures, tables, sections) via `show`, expanding citations via `ref`, and distinguishing the paper's own contributions from cited prior work. Use whenever the user asks about a specific paper in the library, e.g. "解释这篇里的方法 X", "what does <paper> say about Y", "解释这篇的式 2 / 图 1", "summarize the algorithms in this paper", or when another skill (such as argelander-query-paper-library) hands off a doc id for deep reading.
---

# argelander-read-paper

Answer questions about one specific paper that has been ingested into ArgelanderSpace. The goal is **accuracy**, not reproducing PDF layout. Everything goes through the `argelanderspace` CLI.

## Non-negotiable: the CLI is the only interface

**Never read source code — not the ArgelanderSpace repo's, not any other project's — to answer a question about a paper.** If you catch yourself opening `.ts`/`.py` files, grepping a repository, or hand-reading the Document JSON under `literatures/output/`, you are on the wrong path: stop and run the CLI instead. The rendered markdown / manifests / JSON the CLI prints are the sanctioned, tested views of the paper; reading source is how wrong answers happen.

## When to use

- The user names a specific paper (title, arXiv id, doc id, or "这篇" with an obvious referent) and asks something about its content.
- `argelander-query-paper-library` hands off a doc id with a targeted sub-question.

The paper must be ingested first. Check with `argelanderspace list` (one line per doc); if the paper only exists as a library work without a doc (or doesn't exist at all), say so and offer `argelander-paper-ingest`.

## Configuration

- **CLI**: `argelanderspace` (or, when it's not on PATH, `node /path/to/repo/packages/app/dist/bin.js` — the built bundle, by absolute path). **Run it from the project root** — the directory containing `literatures/` — and do **not** pass `--data-dir`: the default data dir is `./literatures` relative to the current working directory, with **no upward search**, so a wrong cwd silently hits an empty or wrong library. `cd` to the project root first; `--data-dir` remains only as an escape hatch for unusual layouts (chain: flag > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`).
- **Doc id vs work id**: `read` / `show` / `ref` / `annot` take a **doc id** (e.g. `arxiv-2501.17225`; see `list`, or the `doc_ids` field of `search` rows). `note` / `label` take a **work id** (`arxiv:...` / `doi:...`). Don't mix them up.
- **Deep-link port**: the CLI prints links as `http://localhost:<port>/doc/...` with port = `ARGELANDERSPACE_PORT` env > config.toml `port` > 8000. If the user's server runs on a custom `--port`, the printed port may not match — set `ARGELANDERSPACE_PORT` in your shell before running CLI commands, or rewrite the port when quoting links.

## The command surface (reading priority)

| Priority | Command | What you get |
|---|---|---|
| 1 — primary source | `read <docId>` | Whole doc as LLM-friendly markdown (`# title` + `> doc: … | link: …` header, then the body) |
| 1 | `read <docId> --section <secId>` | One section subtree as markdown (header carries the section deep link) |
| 2 — manifests | `read <docId> --manifest refs` | JSONL: every section + float (`{id, kind, number, content, short, section, context_before, context_after}`); doc header goes to stderr, stdout is pure JSONL |
| 2 | `read <docId> --manifest bib` | JSONL: every bibliography entry (`{id, short, raw, author, year, title?…}`) |
| 3 — exact lookup | `show <docId> <floatId>` | Pretty JSON for one figure/table/equation/code/algorithm: full `latex` / `caption` / `table_body` / `body` / `image` path + `link` |
| 3 | `ref <docId> <refIdOrKey>` | Pretty JSON for one bibliography entry: metadata + `raw` + `cited_in` block ids + `link`. Matches by id (`ref-6`), label, or citation key |
| 3 | `annot <docId>` | The user's own annotations on this doc as JSONL (`{id, doc_id, target, context, body, created_at, updated_at, link}` per row, reading order, document-level first) — where in the paper the user left notes/requests. Read-only; annotations written against a since-replaced document are hidden (a fixed `note:` on stderr, exit 0) and archived ones are never exposed. `context` locates each target (`section_id`/`section_path`, plus the full container text for text/paragraph/list targets); combine with `read`/`show` for the full section/float content |

Reading order: `read` the relevant section first → resolve floats with `show` → resolve citations with `ref`. Use the manifests as maps (find ids/numbers), not as the primary text.

Unknown ids produce actionable errors on stderr (exit 1): `error: unknown section "sec-99" in doc …; available: sec-1, …` — use the listed candidates instead of guessing another id.

## Core reading rules

### 1. The `read` markdown is the source of truth

It carries the prose, section hierarchy, equations, captions, and expanded citation tokens. Do not assume PDF layout or page numbers. The two inline token forms:

```
[cite: ref-6 | Bok 1934]                                   citation → reference ref-6 (+ `| title: …` when known)
[cite: ? | unresolved]                                     citation the pipeline couldn't resolve
[ref: fig-1 | figure | number: 1 | <caption preview>]      cross-ref → float fig-1
[ref: sec-3 | section | number: 2 | Data]                  cross-ref → section sec-3
[ref: figure-3 | unresolved]                               detected but unresolved cross-ref
```

Figures/tables appear as `[Figure omitted | id: fig-1 | number: 1 | caption: <full caption> | path: /images/<docId>/<img>]`; equations as `$$…$$` followed by a `[ref: eq-1 | equation | number: 1 | <latex preview>]` anchor line.

### 2. Resolve `[ref: ...]` semantically — don't answer from the preview

When a passage points at a float, look up the real content:

```
[ref: eq-2 | …]  →  show <docId> eq-2   →  full `latex`, `number`, `link`
```

- For **equations**, use the full `latex` from `show` (or the refs manifest's `content`), never the truncated inline preview.
- For **figures/tables**, use the full `caption` (+ `table_body` for tables) plus the prose that references them. Do not infer visual details that aren't described.

### 3. Equation numbers alone are not context

"Equation (2)" is not enough. Resolve it: grep the refs manifest for `"kind":"equation"` with `"number":"2"` (or spot the `[ref: eq-N | equation | number: 2 | …]` anchor in the text), then `show` it and read `context_before` / `context_after` in the manifest row. Explain variables only if the paper defines them — flag undefined symbols.

### 4. Use `ref` for citations — and keep the paper's claims separate from cited work

```
[cite: ref-6 | Bok 1934]  →  ref <docId> ref-6   →  authors/year/venue/title/doi/raw + cited_in
```

- The `cited_in` block ids tell you *where* the paper cites it; the prose around those blocks tells you *why*.
- Metadata from `ref` (title/abstract-ish fields, venue) describes the **cited work**, not this paper's claims. Never present bibliography metadata as something this paper demonstrated.
- Don't reverse-engineer a citation from author-year text when the `[cite: …]` id is right there.
- Known data quirk: many entries lack `title` (the manifest row then has only `short`/`raw`/author/year) — that's the source data, not a lookup failure.

### 5. Figures and tables are textual unless you actually look at the image

Never claim to have inspected an image you didn't open. If the user explicitly wants visual detail, the `image` field of `show` is a server path (`/images/<docId>/<img>`) — fetch `http://localhost:<port>/images/...` (server must be running) and describe what you genuinely see. Otherwise work from caption + prose and offer the image option.

## Answer workflow

1. Identify the target: topic / method / equation / figure / result.
2. `read` the whole doc when it's short, or locate first: `read --manifest refs` gives the section map (`section` rows carry titles in `content`), then `read --section <secId>` the relevant subtree.
3. Read the surrounding prose, not just isolated matches.
4. Resolve every `[ref: …]` that matters via `show`; resolve important `[cite: …]` via `ref`.
5. Classify what you found: the paper's own contribution vs. adapted/baseline/background cited work.
6. Answer with section-aware context — and **cite your evidence with deep links** (below).
7. Mention uncertainty when conversion artifacts leave gaps (unresolved tokens, missing titles, garbled author fields); if a referenced id can't be resolved even after the manifest, say so instead of inventing content.

## Common request types

- **Summarize methods/algorithms**: search for `method`, `we present/propose/develop/introduce`, plus domain terms; classify each candidate (proposed here / adapted / baseline / comparison / background); extract purpose, inputs, outputs, assumptions, key equations, stated limitations. Never describe a cited external algorithm as this paper's contribution unless the text says so.
- **Explain an equation**: locate by number/id via the manifest → `show` for full latex → read the manifest's `context_before`/`context_after` and the enclosing section → connect the equation to the method/result it serves.
- **Explain a figure/table**: `show` for the full caption → read the paragraph(s) that reference it → only described content unless the user asked for (and you actually fetched) the image.
- **"What's new in this paper"**: abstract + introduction + conclusions + explicit contribution statements; separate new data / new methods / new analyses / validation / software; check what the paper itself contrasts against prior work.
- **"What does it cite for X"**: find the citing prose (the *why*), then `ref` for the cited work's identity (the *what*). Don't overstate the cited work beyond prose + metadata.

## Citing evidence: always hand over deep links

Every `read` header, `show`, and `ref` output carries a `link`:

```
http://localhost:<port>/doc/<docId>#<anchor>
```

Anchors: `#sec-N` (section), `#eq-N` / `#fig-N` / `#tab-N` / `#code-N` / `#alg-N` (floats), `#ref-N` (bibliography entry), `#ann-<id>` (annotation — from `annot` output). Clicking one opens the webui reader at exactly that spot. **Whenever your answer rests on a specific passage, end the point with its deep link** so the user can verify you in one click:

> 式 (2) 把观测自行投影到 CP 方向：…（变量定义见紧接的下一段）。http://localhost:8000/doc/arxiv-2501.17225#eq-2

## Accuracy rules

- Do not hallucinate figure/table content that isn't in caption or prose.
- Do not treat bibliography metadata as the paper's own claims.
- Do not treat every cited algorithm as proposed by this paper.
- Do not rely on equation numbers alone — resolve the id and read the context.
- Prefer full `content`/`latex` over truncated previews.
- Do not hide conversion gaps: unresolved `[cite: ?]` / `[ref: … | unresolved]` tokens, missing reference titles, and mangled author fields exist in some docs — tell the user when your answer works around one.

## Minimal operating procedure

```bash
argelanderspace list                              # find the doc id
argelanderspace read <docId> --manifest refs      # section/float map
argelanderspace read <docId> --section <secId>    # read the relevant part
argelanderspace show <docId> <floatId>            # resolve floats
argelanderspace ref <docId> <refIdOrKey>          # resolve citations
```
