---
name: argelander-find-papers
description: Find published papers on a topic through NASA ADS — search for seed papers (by topic, author, year), expand from them with ADS `similar` / `useful`, then rank and trim to the size the user asked for. Use when the user wants a reading list or related literature that is not yet in any library — "find papers on X", "find 10-15 papers about Y starting from Z's work", "what else is like this paper", "找一些关于 X 的文献", "以这几篇为种子扩展". Do NOT use to answer questions from papers the user already collected (argelander-query-paper-library), to read one paper (argelander-read-paper) or to add a paper to the library (argelander-paper-ingest).
---

# argelander-find-papers

Turn a request like *"papers on tidal tails; start from a few that Pavel Kroupa co-authored, expand to 10–15"* into a ranked list of real papers, using NASA ADS as the only source.

The search is read-only: it saves nothing, touches no library and writes no file. Adding a found paper to the library is a separate step the user asks for (`argelander-paper-ingest`).

## Two entries

This guide serves the Copilot (in the workbench) and external agents (a shell with the `argelanderspace` CLI). One operation, two ways to call it:

| Operation | Copilot | External agent |
|---|---|---|
| `discovery.search_ads` | `library` tool, action `search_ads` `{"query":…,"limit":…,"fields":…}` | `argelanderspace discovery search-ads --query '<ADS query>' --limit 20 --fields title,author,year,pub,citation_count,doi,abstract` |
| `discovery.explore` | no such action | `argelanderspace discovery explore --bibcode <bibcode>` (optional) |

Both answer the same JSON. The CLI prints it on stdout; `--json <file|->` takes the parameters as one object instead of options.

The ADS token is the one saved in the workbench (Settings, literature services and credentials). Neither entry reads `~/.ads/dev_key` or any environment variable, and the token never appears in a command, an answer or a file. If the answer is `no_token`, the user saves the key on the settings page; never ask for it in the conversation.

## Non-negotiable: every paper comes from an ADS answer

List only papers that `search_ads` returned in this session, with the bibcode it printed. Never add a paper from memory, never guess or repair a bibcode, and never fall back to web search when ADS fails — a list that mixes real and remembered papers is worse than a short one.

## The search

`query` is an ADS query string, sent as is (single-quote it for the shell). Useful fields: `author:"Kroupa, P"`, `first_author:"…"`, `abs:"tidal tails"` (title, abstract and keywords), `title:"…"`, `year:2015-2025`, `property:refereed`.

- `limit` is 1–50 (default 10); `fields` picks from `title,author,year,pub,citation_count,doi,arxiv_id,abstract` (`bibcode` is always there). Ask for `abstract` when you must judge relevance; it is cut at 1500 characters.
- Records come in ADS's own order. Each carries at most 10 authors and the real `authorCount`.
- **Expansion uses the same operation with ADS operators in the query**: `similar(bibcode:"2024ApJ...970...94K")` lists papers ADS ranks as similar to that one; `useful(bibcode:"A" OR bibcode:"B")` lists the references most often cited by those papers — expect well-known background works (textbooks, methods papers) rather than the narrow topic.
- Result: `{"ok":true,"status":"ok","query":…,"numFound":…,"returned":…,"records":[{"bibcode":…,"title":…,"authors":[…],"authorCount":…,"year":…,"venue":…,"citationCount":…,"doi":…}]}`.
- A failed search is an answer, not a crash: `{"ok":false,"status":"error","reason":…,"detail":…}`. The CLI exits 1 for it (2 for invalid parameters, nothing sent).

`discovery.explore` is what the workbench's exploration page asks ADS for one seed: the seed, its top 18 similar papers, the 6 most useful references of those, and the citations among them, each marked with the library work it already is. Use it when the user wants to see how a seed relates to their library; it is not needed for a reading list.

## Workflow

### 1. Read the request

Pull out the topic, any seed constraint (an author, a named paper, a year range), and the target size. If the user gave no size, aim for 10–15.

### 2. Find the seeds

Run `discovery.search_ads` with a query that encodes the user's constraints, read the titles and abstracts, and pick the few (typically 2–5) that are really about the topic. A co-author constraint is `author:`, not `first_author:`.

If the user named seed papers, look each one up to get its bibcode rather than choosing your own.

If nothing fits, say so and stop. Do not quietly drop a constraint (for example the author) to get results; offer that as an option instead.

### 3. Expand

Search `similar(bibcode:"…")` from the seeds — once per seed, on the whole seed set, or both; choose what serves the request. Per-seed searches show which seed led to which paper. Add `useful(…)` only when the user wants background or foundational reading as well.

Expand from seeds only. Do not expand again from an expanded paper unless the user asks for it.

### 4. Rank and trim

Merge by bibcode. The ranking is your judgement, with the ADS order as evidence: a paper that ranks high, or that several seeds lead to, is a strong candidate; read the abstract before keeping it, and drop papers that are off-topic however well they rank. Scores and ranks are only comparable within one search.

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
- Found via: the query for a seed; for the others, which seed or seeds and at what position.

Below the table, say in a few sentences why these seeds were chosen, what you dropped as off-topic, where you departed from the ADS order, and whether the list is shorter than asked for and why.

Saving a paper from the list into the library is `library.import_works` with `mode: "bibcode"` (see `argelander-paper-ingest`), and only for the papers the user names.

## When ADS fails

Report the answer's `reason` and `detail` and stop.

- `no_token` — the user must save their ADS key in the workbench's settings; nothing was sent.
- `unauthorized` — the saved key is wrong or expired; the user checks it in Settings.
- `rate_limited` — wait for `retryAfter`; do not retry in a loop.
- `bad_query` — your query is malformed; fix the syntax and search again.
- `timeout`, `unreachable` — ADS did not answer; retry once, then report.
- `interrupted` — the user pressed Stop; do not retry unless asked.
