---
name: argelander-find-papers
description: Find published papers on a topic through NASA ADS — search for seed papers (by topic, author, year), expand from them with ADS `similar` / `useful`, then rank and trim to the size the user asked for. Use when the user wants a reading list or related literature that is not yet in any library — "find papers on X", "find 10-15 papers about Y starting from Z's work", "what else is like this paper", "找一些关于 X 的文献", "以这几篇为种子扩展". Do NOT use to answer questions from papers the user already collected (argelander-query-paper-library), to read one paper (argelander-read-paper) or to add a paper to the library (argelander-paper-ingest).
---

# argelander-find-papers

Turn a request like *"papers on tidal tails; start from a few that Pavel Kroupa co-authored, expand to 10–15"* into a ranked list of real papers, using NASA ADS as the only source.

This skill is self-contained and read-only. It needs Node 18+ and an ADS API key in `~/.ads/dev_key`; it does not need the `argelanderspace` CLI, a library or a server, and it writes no files.

`~/.ads/dev_key` and the ADS token saved in the workbench (its settings page, which can import that file once) are two separate copies: this skill reads only the file, the workbench and its CLI only their own saved token. Changing or removing one does not change the other.

## Non-negotiable: every paper comes from the script's output

List only papers that `ads.mjs` returned in this session, with the bibcode it printed. Never add a paper from memory, never guess or repair a bibcode, and never fall back to web search when ADS fails — a list that mixes real and remembered papers is worse than a short one.

## The script

`scripts/ads.mjs` sits next to this file. Call it by absolute path:

```bash
node <skill-dir>/scripts/ads.mjs search '<ADS query>' [--rows N]    # default 20
node <skill-dir>/scripts/ads.mjs similar <bibcode>... [--rows N]    # default 18
node <skill-dir>/scripts/ads.mjs useful <bibcode>... [--rows N]     # default 6
```

- `search` sends your ADS query string as is. Single-quote it for the shell. Useful fields: `author:"Kroupa, P"`, `first_author:"…"`, `abs:"tidal tails"` (title, abstract and keywords), `title:"…"`, `year:2015-2025`, `property:refereed`.
- `similar` returns papers whose text ADS ranks as similar to the given paper or papers.
- `useful` returns the references most often cited by the given papers. Expect well-known background works (textbooks, methods papers) rather than papers on the narrow topic.
- `--rows` is 1–50. Results always come in ADS relevance order.

Each stdout line is one paper:

```json
{"rank":1,"bibcode":"2024ApJ...970...94K","title":"Open Star Clusters and Their Asymmetrical Tidal Tails","authors":["Kroupa, Pavel","Pflamm-Altenburg, Jan"],"author_count":9,"year":2024,"pub":"The Astrophysical Journal","citation_count":25,"doi":"10.3847/…","score":40.46,"abstract":"…"}
```

`authors` holds at most the first 10 names; `author_count` is the full count. `rank` and `score` are only comparable within one call — a score from `similar` and a score from `search` are on different scales.

Failures print `error: <reason>` on stderr and exit non-zero (1 for a failed request, 2 for a wrong invocation). An empty result exits 0 with nothing on stdout and a `note:` on stderr.

## Workflow

### 1. Read the request

Pull out the topic, any seed constraint (an author, a named paper, a year range), and the target size. If the user gave no size, aim for 10–15.

### 2. Find the seeds

Run `search` with a query that encodes the user's constraints, then read the titles and abstracts and pick the few (typically 2–5) that are really about the topic. A co-author constraint is `author:`, not `first_author:`.

If the user named seed papers, look each one up with `search` to get its bibcode rather than choosing your own.

If nothing fits, say so and stop. Do not quietly drop a constraint (for example the author) to get results; offer that as an option instead.

### 3. Expand

Call `similar` from the seeds — once per seed, on the whole seed set, or both; choose what serves the request. Per-seed calls show which seed led to which paper. Add `useful` only when the user wants background or foundational reading as well.

Expand from seeds only. Do not expand again from an expanded paper unless the user asks for it.

### 4. Rank and trim

Merge by bibcode. The ranking is your judgement, with the ADS ranks as evidence: a paper that ranks high, or that several seeds lead to, is a strong candidate; read the abstract before keeping it, and drop papers that are off-topic however well they rank.

- Seeds are always kept, listed first, and count toward the target size.
- More candidates than the target: keep the most relevant.
- Fewer than the target: report what you found. Do not pad.

### 5. Report

Answer in the conversation with one table, seeds first:

| # | Title | Authors | Year | Bibcode | Role | Found via |
|---|---|---|---|---|---|---|

- Authors: first author, plus "et al." when there are more.
- Bibcode: link it to `https://ui.adsabs.harvard.edu/abs/<bibcode>/abstract`.
- Role: `seed`, `similar` or `useful`.
- Found via: the query for a seed; for the others, which seed or seeds and at what rank.

Below the table, say in a few sentences why these seeds were chosen, what you dropped as off-topic, where you departed from the ADS order, and whether the list is shorter than asked for and why.

## When ADS fails

Report the script's error message and stop.

- `no ADS token` — the user must put their key (from the ADS account settings page) in `~/.ads/dev_key`; a token saved in the workbench's settings does not count here. Do not ask them to paste it into the conversation.
- `rejected the token` — the key is wrong or expired.
- `rate limit exceeded` — wait for the stated time; do not retry in a loop.
- `ADS HTTP 400` — your query is malformed; fix the syntax and rerun.
- `cannot reach ADS` — no network access from this environment; retry once, then report.
