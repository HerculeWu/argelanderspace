---
name: argelander-query-paper-library
description: Answer research questions using the user's ArgelanderSpace library — rank works by relevance with `search` (the note field is the primary signal), show a shortlist, hand each pick to the argelander-read-paper skill with a targeted sub-question, then synthesize. Use whenever the user asks a substantive question that should be answered with reference to their collected papers — "based on my library, what does X mean", "我文献库里关于 Y 有什么相关论文", "find papers about Z in my library", "用我收藏的文献回答...". Do NOT use when the user names a specific paper (use argelander-read-paper) or wants to add one (use argelander-paper-ingest).
---

# argelander-query-paper-library

The entry point for question-driven reading: rank the library against the user's question, drive `argelander-read-paper` on the top candidates, and synthesize an answer with traceable evidence.

## When to use vs. when NOT to use

**Use when:**
- The user asks a substantive question and expects you to consult their library ("用我文献库回答 …", "我文献库里关于 Y 有什么").
- "Which of my papers cover X?" / open-ended questions the library was built for.

**Don't use when:**
- The user names a specific paper → go straight to `argelander-read-paper`.
- The user wants to add a paper → that's `argelander-paper-ingest`.
- The library is empty (`search` prints nothing) → say so and suggest ingesting; stop.

## Configuration

`argelanderspace` CLI (or `node packages/app/dist/bin.js` in the repo), always with an explicit `--data-dir <root>` matching the user's server. The old `LITERATURE_LIBRARY` env var is dead.

## Why notes are the primary signal

When a paper was ingested, the user (with the ingest skill) wrote a **note**: "in what kind of question/scenario would I want to look at this paper again". That note is the highest-quality, human-curated relevance signal in the library. The title is the paper's view of itself; the note is the user's view of why the paper matters in **their** context. Always weigh notes first.

`search` returns the full index with **no server-side filtering** — relevance ranking is *your* judgment call, by design.

## Workflow

### Step 1 — Load the whole index

```bash
argelanderspace search --data-dir <root>
```

One JSON object per line, per work:

```json
{"id":"doi:10.1051/0004-6361/202453302","title":"Tidal tails of nearby open clusters - I. …","year":2025,"venue":"A&A","authors":"Risbud et al.","arxiv_id":"2501.17225","doi":"10.1051/…","cited_by_count":10,"note":"在…场景下回查此文","tags":["tidal-tails"],"label":null,"read":false,"star":false,"doc_ids":["aa53302-24","arxiv-2501.17225"]}
```

Read **every** row — the library is sized for tens-to-low-hundreds of papers, so a full read is the intended use. Don't pre-filter with grep before reading; keyword filtering is exactly the failure mode this design avoids.

### Step 2 — Rank candidates (judgment, not regex)

Score relevance of each row to the question, weighing signals in this order:

1. **`note`** — the user's own curation. Strongest signal.
2. **`tags`** — the user's second-layer curation; also a good fast pre-filter when the question maps to an obvious tag.
3. **`title` / `venue` / `authors` / `cited_by_count`** — secondary expansion.

Avoid keyword-only matching in both directions: a note about "luminosity-to-mass conversion in old populations" is relevant to a "stellar mass functions" question without sharing a token; a note that mentions the query words only as a one-line aside is not a strong match.

Also weigh **`doc_ids`**: a work with an ingested doc can be deep-read immediately; a work without one (`doc_ids: []`) can only contribute its index-row metadata — flag that difference when it matters.

Pick a shortlist of **2–5** works. Clearly more than 5 strong matches → surface the count and ask whether to read all or trim.

### Step 3 — Show the shortlist BEFORE reading

```
Found N candidate papers:

1. <work id> — <title> (<year>)
   note: "<note>"
   why relevant: <one line — your reasoning>

2. …
```

Then ask "Read all of these, or narrow further?" — unless the user's framing already authorized proceeding ("用文献库回答…" usually does; "看看库里有没有相关的" leans toward listing first). One round-trip is cheap; reading 5 wrong papers is not.

### Step 4 — Hand off to `argelander-read-paper` per pick

For each chosen work, take a doc id from its `doc_ids` and invoke the **argelander-read-paper** skill with `(doc id, targeted sub-question)` — the specific aspect of the user's question you want answered *from that paper*. Don't replicate its reading logic here; it knows how to resolve refs/citations correctly. If the question decomposes ("compare how A and B handle X"), give each paper a different sub-question rather than one generic prompt.

### Step 5 — Synthesize across papers

- Present per-paper findings briefly, each with its work id.
- Then synthesize: **agreements, disagreements, complementary contributions, gaps**.
- Cite work ids **and the deep links** the read skill produced (`http://localhost:<port>/doc/<docId>#<anchor>`) so every claim is one click from its evidence.
- Papers disagree on a fact → surface the disagreement explicitly; never quietly pick one.
- A top candidate that turns out irrelevant after reading → say so honestly and move on, or pull a replacement from the shortlist's tail.

If the shortlist can't fully answer the question, say so and suggest: ingesting a specific missing paper (argelander-paper-ingest), loosening the ranking (weigh titles/tags more), or accepting that the library doesn't cover this aspect.

## The empty-note caveat (and backfill)

Works with `note: null` are nearly invisible to note-driven ranking — they can only match on title/tags. If you notice many strong-looking candidates have empty notes, tell the user and offer to backfill. Backfilling uses the same discipline as ingest: **you draft a suggested note** from the title (and, if a doc exists, a quick `read` of the abstract), the user confirms or edits, then:

```bash
argelanderspace note <work_id> <confirmed text> --data-dir <root>
```

Never silently write your own drafts as if they were the user's words — the note's value is that it's user-curated.

## Practical notes

- **Scale**: ranked-by-reading-every-row assumes tens-to-low-hundreds of works. Well beyond that, flag it and propose tag conventions before reaching for embeddings.
- **Tags as pre-filter**: use them to speed up ranking, but don't filter so hard that relevant un-tagged works disappear.
- **Re-ranking after reading is normal** — better to admit a miss than to force a synthesis from the wrong papers.

## Example session shape

User: "我想了解 CP 方法测潮汐尾的现状，我文献库里有相关的吗？"

You:
1. `search` → read all rows.
2. Shortlist 3 works whose notes/tags mention tidal-tail detection, CP/CCP methods, or Gaia cluster mapping.
3. Show the shortlist with one-line reasons; proceed (framing authorized it).
4. Hand each doc id to argelander-read-paper with a targeted sub-question ("这篇如何用 CP 方法定义成员/尾巴？", "它的样本和完备性怎样？").
5. Synthesize: "A 用 CP+DBSCAN 在 10 个近邻 OC 上…；B 把 CP 扩展成 CCP 并用 N-body 验证…；C 提供了 46 个 OC 的对照样本但方法不同（ML 形态学）…；分歧：A 与 B 对 Hyades 尾长的估计差 2 倍，原因在成员选择…；空白：三篇都没碰小样本 regime。" — each claim followed by its work id + deep link.
