---
name: argelander-argument-graph
description: Turn one paper in the ArgelanderSpace library into an argument graph (论证图) — Toulmin-model arguments (Claim, Grounds, Warrant, optional Backing/Qualifier/Rebuttal) linked by argument edges, with Native and End arguments marked and sources that jump into the paper — and write it into the workbench with `argument.replace`. Use whenever the user asks to "整理这篇的论证结构 / 论证图", "break down the logic of paper X", "map the argument of this paper", "explain paper X in detail as an argument graph", or "把这篇论文的论证写进工作台". Do NOT use for ordinary Q&A about a paper (use argelander-read-paper) or for ingesting one (use argelander-paper-ingest).
---

# argelander-argument-graph

Read one paper and write its **argument graph** into ArgelanderSpace, where the user sees it on the workbench canvas and can edit it. The process is a six-step Toulmin analysis; the last step writes the graph with `argument.replace`.

## Two entries

This guide serves the Copilot (in the workbench) and external agents (a shell with the `argelanderspace` CLI). The analysis is the same; reading the paper and writing the graph are operations with two ways to call them. The CLI prints one JSON answer on stdout, the same one the Copilot's tool returns; `--json <file|->` takes all parameters as one object.

| Step | Operation | Copilot (`argument` / `reader` / `library` tool, action) | External agent |
|---|---|---|---|
| Find the Work and its Docs | `library.read` | `library` `read` `{"query":…}` | `argelanderspace search` (work `id`, `doc_ids`; the first is the main Doc) |
| Read the paper | `reader.read` | `reader` `read` `{"docId":…}` | `argelanderspace read <docId> --manifest refs`, `read <docId> --section <secId>`, `show`, `ref` (see `argelander-read-paper`) |
| Read the existing graph | `argument.read` | `argument` `read` `{"workId":…}` | `argelanderspace argument read --work-id <workId>` |
| Write the whole graph | `argument.replace` | `argument` `replace` `{"workId":…,"expectedRev":…,"graph":{"arguments":[…],"edges":[…]}}` | `argelanderspace argument replace --json /tmp/replace.json` |
| Add or change one argument | `argument.create`, `argument.update` | `argument` `create` / `update` | `argelanderspace argument create --json …`, `argelanderspace argument update --json …` |
| Delete / restore one argument | `argument.delete`, `argument.undo_delete` | `argument` `delete` / `undo_delete` | `argelanderspace argument delete --work-id <workId> --expected-rev <rev> --id <id>`, `argelanderspace argument undo-delete …` |
| Edges | `argument.add_edge`, `argument.remove_edge` | `argument` `add_edge` / `remove_edge` | `argelanderspace argument add-edge --work-id <workId> --expected-rev <rev> --from <id> --to <id> --role grounds`, `argelanderspace argument remove-edge …` |
| Empty the graph | `argument.clear` | `argument` `clear` | `argelanderspace argument clear --work-id <workId> --expected-rev <rev>` |
| Show it to the user | `argument.open` (the tool's action is `open_argument_graph`) | `argument` `open_argument_graph` | `argelanderspace open argument-graph --work-id <workId>` (needs the workbench open) |

Every write carries `expectedRev` (CLI `--expected-rev`): the `rev` you read last. A stale one answers `conflict` with the graph's latest state; write nothing from the stale picture, read the latest, decide again. Nested parameters (`argument`, `patch`, `graph`, `ids`) are JSON; give them with `--json`, where the object has the same keys the Copilot's call has (without `action`).

The Copilot's `argument` tool also has a `guide` action, the tool's own summary of this method; when this guide is loaded, follow this one.

CLI exit codes: 0 `ok`/`noop`; 1 the operation answered `ok:false` (`conflict`, `invalid`, `not_found`, `expired`, `workbench_required`, `error`) or failed; 2 invalid parameters, nothing ran; 3 the user refused the confirmation card (`denied`); 4 the workbench went away while the card was open (read the graph before retrying); 130 you interrupted it.

## Non-negotiable: operations and the CLI are the only interface

**Never read source code — not the ArgelanderSpace repo's, not any other project's — and never hand-read or hand-write files under `literatures/` (library.json, Document JSON, `argument-graphs/*.json`).** Read the paper and the graph with the operations above and write the graph only with them. An external agent may write scratch files **outside the data dir** (a temp directory under your working directory, or `/tmp`): the parameter file you pass to `argument replace`, and CLI output you redirect to a file in order to read it in pieces (see "Practical reading"). Never write inside `literatures/`.

## Vocabulary (use these words with the user)

- **论证图 (argument graph)**: belongs to one Work, at most one per Work. It may contain cycles. Not the same as the paper's Doc.
- **论证 (argument)**: one node. Claim, Grounds, Warrant, and optionally Backing, Qualifier, Rebuttal, plus a **short title**.
  - **Claim**: what the author wants the reader to accept. **Grounds**: evidence, facts, inputs. **Warrant**: the rule that explains why the Grounds lead to the Claim. **Backing**: what shows the Warrant is reliable. **Qualifier**: limits on scope or certainty ("typically", "for clusters within 400 pc"). **Rebuttal**: acknowledged exceptions under which the Claim fails.
- **论证边 (argument edge)**: from argument A to argument B means *A's Claim plays a role in B*: `grounds`, `warrant`, `backing` or `rebuttal`. A Qualifier is never an edge; it is text on the argument.
- **Native 论证**: its Grounds/Warrant/Backing come entirely from outside this paper (citations, established datasets, physical laws, standard domain knowledge). Mark it explicitly (`kind: native`) — never assume "no in-edges" means Native.
- **End 论证**: a final contribution or conclusion of the paper that **nothing else in the paper uses**, so it has no out-edges. Mark explicitly (`kind: end`) — never assume "no out-edges" means End. Which claims qualify is decided in Step 4.
- **出处 (source)**: where in the paper an argument comes from; reference only.
- **论证审计 (audit)**: the list of problems computed from the graph (cycles, arguments with no path to an End, …). Not stored.

**Never refer to an argument by a number or letter code (A1, E3, "node 4").** Refer to it by its short title, in your messages, in the summary and in titles. The JSON `id` is only an internal label that edges point at; do not use it to talk about arguments (a readable slug such as `cp-method` is fine as the id, but say "the *CP method* argument").

## Language

Report in the user's language. Use the Chinese terms (论证图, 论证, 论证边, Native/End 论证, 出处, 论证审计) only when the user writes Chinese; for an English request use the English terms (argument graph, argument, argument edge, Native/End argument, source, audit). The JSON keys, `kind` values and edge roles are always the English ones. Argument text (claim, grounds, …) follows the paper's language unless the user asks otherwise.

## Configuration (external agents)

Same as `argelander-read-paper`: CLI `argelanderspace` (or `node /path/to/repo/packages/app/dist/bin.js` by absolute path); **run from the project root** (the directory containing `literatures/`) and do not pass `--data-dir` unless the layout is unusual. Printed links use the port from config.toml `port` (default 1859); if the user's server runs on another port, rewrite the port when quoting a link. If you only have the `node /path/to/bin.js` form, write it out in full in every command or wrap it in a shell **function** (`argel() { node /path/to/bin.js "$@"; }`): storing the two words in an ordinary variable (`CLI="node /path/bin.js"`) does not word-split in zsh and fails with `command not found`.

Two id families — keep them straight:

- **work id** (`arxiv:2501.17225`, `doi:…`): the `argument` operations, `search` rows' `id`.
- **doc id** (`arxiv-2501.17225`, `pdf-<uuid>`): `read` / `show` / `ref` / `reader`, and the `doc_id` inside a source target.

## Step 0: locate the Work, the Doc, and the existing graph

1. **Work**: `argelanderspace search` prints every work as one JSON line on stdout (`id`, `title`, `doc_ids`, …; a `hint: …` line goes to stderr and is not part of the data); the Copilot uses `library.read`. Pick the Work the user means; if several plausibly match, ask. The Work's `title` can differ from the Doc's title (shown by `list` and in the `read` header) — use both when matching what the user said. If it is not in the library, say so and offer `argelander-paper-ingest`.
2. **Doc**: the row's `doc_ids` lists its Docs; **the first is the main Doc**, which you read by default. If the user names another Doc, use that. A Work with an empty `doc_ids` has no readable body — see "No body" below.
3. **Kind of Doc**: a LaTeX (shared-IR) Doc is read with `read` / `show` / `ref` or `reader.read`. A PDF Doc is read with `reader.read` (the pages' text; a page without a text layer only as an image, `reader.read_page_image`), or by `argelanderspace pdf-path <docId>` (stdout: the absolute path of the original PDF) and your own PDF reading ability. `read`/`show` on a PDF Doc fail with a schema dump — expected, not a broken library; `pdf-path` on a LaTeX Doc answers `error: doc "<id>" is not a PDF doc`.
4. **Existing graph**: `argument.read` answers `rev`, `counts`, the workbench's own `audit` (`cycles`, `noPathToEnd`, `noEnd`, `endWithOutEdge`, `nativeWithInEdge`, `incomplete`), the arguments and the edges; a large graph comes in parts (`batch`, `edgesBatch`: follow the note, read the rest with `--offset` / `--edge-offset`, or particular arguments with `ids`). No graph is `rev: 0`, `counts` zero. Remember `rev`; you will send it back. If the graph is **non-empty**, tell the user now: writing a whole graph over it needs their confirmation on a card in the workbench (see Step 6). You may still do the analysis while waiting. (`argelanderspace argument get <workId>` is the older whole-graph read: the same graph as a JSON file shape, with `version`, `rev`, `work_id`; both work.)

## Reading the paper

Read it as `argelander-read-paper` describes: the section and float map first, then the sections in order, floats with their full content, citations through the bibliography.

- Read the prose, not just matches. Resolve each float that matters (equation `latex`, caption, table body); resolve important citations. Metadata of a reference describes the *cited* work — it is what makes a Native argument native, never something this paper demonstrated.
- Conversion leaves visible gaps: unresolved cross-references, bare `Fig. Z20`-style text, and author names cut short in a citation label (an accent command swallowed the rest). For any citation that matters, take the reference's **`raw`** field as the authority; never guess an author from context.
- Do not describe a cited method as this paper's contribution unless the text says so.
- Never claim to have inspected a figure image you did not open; work from caption and prose.
- Mention conversion gaps (unresolved citations, missing titles) in your final report when they affected the graph.

### Practical reading (external agents)

The whole paper (`read <docId>`) can be ~77 KB, more than fits in one tool output. Redirect to a temp file and read it in pieces with your file-reading tool, or go section by section:

```bash
mkdir -p /tmp/ag && argelanderspace read <docId> --manifest refs > /tmp/ag/manifest.jsonl
argelanderspace read <docId> > /tmp/ag/paper.md          # then read it in line ranges
```

Start with the manifest (sections, numbers, float ids), then read the sections in order. `read`, `show`, `ref` and the catalog commands print their data on stdout; `read --manifest refs` prints a `doc: <id> | <title> | <link>` line and `search` prints a `hint: …` line on **stderr** — when you redirect only stdout, stderr still shows on screen, which is harmless; do not merge `2>&1` into a file you will parse as JSON.

### No body

If the Work has no Doc (`doc_ids` empty), or the only Doc cannot be opened, **say plainly that there is no readable body**. Then work only from what the user gives you (pasted text, an abstract, a PDF they point at) and say that this is the basis — do not fill the graph from memory of the paper. If the user supplies nothing, stop and ask.

## The six steps

Work bottom-up. Keep a running list of arguments (title + the six fields) and edges before writing JSON.

1. **Find the Native arguments.** Look in the introduction, background and methods for statements backed entirely by citations, standard data, laws or domain knowledge. Each becomes an argument with `kind: native`. Example: Claim "Feature extraction via ResNet-50 is robust for image classification"; Grounds "baseline accuracy scores from Smith 2020"; Warrant (implicit) "high accuracy on a standard benchmark indicates robust features".
2. **Climb the intermediate chain.** Read methods, results, discussion: how does the paper use those foundations to build new claims? Create the intermediate arguments and connect them: add an edge from each supporting argument, with the role its Claim plays in the target (`grounds`, `warrant`, `backing`, `rebuttal`). Ask of each edge: "is this Claim used as evidence, as the rule that licenses the step, as support for that rule, or as an exception?" Use the Toulmin definitions strictly: **Grounds** = the facts/data/results the Claim is inferred from; **Warrant** = the general rule that licenses the step from Grounds to Claim; **Backing** = what shows that rule is reliable or appropriate; **Rebuttal** = a condition under which the target's Claim would fail. Three cases that are easy to get wrong:

   - **A prediction the result is compared with** (a theory predicts S-shaped tails; the data show only 4 of 19). The argument "the tails contradict the theory" gets *both* the observation and the prediction as `grounds` (the prediction is typically a Native argument); its Warrant is the comparison rule ("a prediction not borne out by the data signals a discrepancy"). It is **not** a `rebuttal`: it is not an exception to the discrepancy claim. If a prediction is instead the rule you use to *interpret* data, it is a `warrant`.
   - **Motivation** ("model-dependent methods may be biased, so we use a model-independent one"). Write the motivation as its own argument (Native if it rests on cited work) and connect it as `backing` of the argument that applies the method: it shows why that way of proceeding is the appropriate rule. If the paper's motivation has no logical use further on, do not draw an edge; keep it only as a source.
   - **Corroborating checks.** A check that bears on *this* result: an independent test of the very objects the Claim is about, is an extra `grounds` of that result. Examples: an angular-momentum–energy test of the tails found, a comparison of these clusters with literature. A check that bears on whether the *method* can be trusted in general (it reproduces known tails, validated on a benchmark) is `backing` of the method's Warrant. A check that reveals a limit goes to the target's `qualifier` or `rebuttal` text (below).
3. **Add Qualifiers and Rebuttals** from limitations sections, edge cases, error margins and scope statements. Test: if the sentence says *how far or how strongly* the Claim holds ("mostly", "within 400 pc", "±10 %", "for clusters older than 100 Myr") it is a `qualifier`; if it names a *condition under which the Claim would be false* ("unless field-star contamination is large", "if the cluster is not bound") it is a `rebuttal`. Put them in the text fields, and where an exception is itself an argument of the paper, add a `rebuttal` edge.
4. **Advance to the End arguments.** Keep linking until the chains reach the paper's final contributions and conclusions (Lemma → Theorem; experiment A + experiment B → conclusion).
   - **What is a candidate**: every claim the paper presents as its own final contribution or conclusion — statements in the abstract, promises in the introduction, and items of the conclusions section (an item found only there counts too).
   - **What is End**: a candidate that **no other argument of the paper uses**. Mark exactly those `kind: end`. This follows the source method (an End argument "can not serve as Grounds, Warrant, Backing or Rebuttal of any other argument") and the workbench audit (an End with an out-edge is a finding).
   - **A result that is both a contribution and used to derive other conclusions** (the headline discovery that later sections build the scaling relations on; a new method that the discovery rests on) is an **intermediate** (`kind: normal`) argument, with edges to the arguments that use it. The conclusions that use it, and are not used further, are the Ends. Example: *19 of 21 clusters have tidal tails* is promised in the abstract, but the paper goes on to use it (4 of those 19 are S-shaped, against theory); it stays `normal`, and *4 of 19 tails are S-shaped, against theory* is `end`. Say so in the report ("the headline result is an intermediate step because …").
   - **Do not invent** an argument the paper does not state (an extra "hub" claim) just to keep a headline result free of out-edges. A real intermediate product the paper states ("we release a catalogue of members") may be its own argument.
   - Never mark a used claim `end` to make it prominent. If the paper's own logic leaves no unused conclusion, leave the graph without an End and report it (Audit).
5. **Audit** (see below) — for your report to the user.
6. **Write** with `argument.replace` (see below). This replaces writing a canvas file: the graph lives in the workbench.

### Completeness of each argument

Every argument needs a **Claim**, **Grounds** and a **Warrant** (non-empty text, or — for Grounds and Warrant — an incoming edge with that role from another argument, which then carries it). When the paper leaves the Warrant unstated, **write the one you infer and set `warrant_implicit: true`**; that flag does not excuse an empty Warrant. When Grounds or Warrant is carried by an incoming edge, the text may stay empty; then `warrant_implicit` is `false` (the paper did state it, another argument carries it). Text *and* an incoming edge of that role together are allowed (the text adds what the edge does not say). Write claims as complete statements, not labels; keep the paper's symbols/numbers when they matter (Markdown and `$…$` math are fine).

### Short titles

Every argument has a `title` of at most **80 characters**, descriptive and distinct ("CP method locates co-moving stars", "Nineteen of 21 clusters have tidal tails"). Not "A1", "E1", "Step 3", "Claim 2".

### Granularity

Make one argument per **step of the paper's reasoning**, not per paragraph: a claim the paper states, supports, and that either feeds a later claim or is a conclusion. Per-object subsections (a separate subsection for each of twelve clusters) become **one** argument with several sources, unless one object carries a distinct claim that other arguments use. Rule of thumb: a 30–40-section research paper gives roughly 15–40 arguments (a 38-section example gave about 30); a short letter 8–15; far above 60 usually means you are summarising paragraphs. Hard limits are 500 arguments and 5000 edges — if you approach them, you are too fine.

### Sources (出处)

Each argument lists where in the paper it comes from, as `sources`: `{text, target?}`.

- `text`: human display text — `Section 3.2`, `Figure 4`, `Equation 7`, `Table 2`, `Page 5`. English words, **no `§`**, no `Eq.`/`Fig.` abbreviations. Use the number *printed in the paper*. A part without a number (the Abstract, Data availability) uses its title as text (`Abstract`, `Data availability`). Appendix floats keep their printed numbers: `Table A.3`, `Figure A.1`, even though their ids differ.
- `target` (optional but wanted whenever you know the structure id): which Doc and where. Two forms, exactly one of `anchor` / `page`:
  - shared-IR (LaTeX) Doc: `{"doc_id": "arxiv-2501.17225", "anchor": "sec-7"}` — `anchor` is the structure id exactly as `read --manifest refs` / `show` print it: `sec-N`, `eq-N`, `fig-N`, `tab-N`, `code-N`, `alg-N` (no `#`). Get the id from the manifest row whose `number` matches (`Section 3.1` → the `sec` row with `"number":"3.1"`; `Equation 2` → `eq-2` only after you checked the row's `"number":"2"`).
  - PDF Doc: `{"doc_id": "pdf-…", "page": 5}` — page counted from 1 as in the PDF viewer.
  - Without a target the source is only text; that is fine when you cannot map it.
  - Text is the paper's number; the anchor is the manifest `id` — they need not match. Example: the manifest row `{"id":"tab-3","kind":"table","number":"A.3",…}` gives `{ "text": "Table A.3", "target": { "doc_id": "arxiv-2501.17225", "anchor": "tab-3" } }`, and `Figure A.1` is `fig-6`.
  - For a series ("panel (i) of Figs. A.1 to A.19") write one source with the printed range (`Figures A.1 to A.19, panel (i)`) and point the target at the first float of the range (`fig-6`); add a second source for the last one only if it matters.
  Targets are references only and are not validated against the Work; a wrong anchor silently points nowhere, so copy ids, don't guess them.
- Up to 50 sources per argument.

## The graph JSON

This is the `graph` of `argument.replace`: the Copilot puts it in the call; an external agent writes it, inside `{"workId":…,"expectedRev":…,"graph":{…}}`, to a scratch file and gives that file to `--json`. Keys are strict: an unknown key is an error, and `graph` holds exactly `arguments` and `edges` (no `version`, `work_id` or `rev`).

```json
{
  "arguments": [
    {
      "id": "cp-method",
      "title": "CP method identifies co-moving cluster stars",
      "claim": "The convergent-point (CP) method finds co-moving members of a moving group.",
      "grounds": "Jones 1971 and de Bruijne 1999 derive and apply the method.",
      "warrant": "Stars of a cluster share a space velocity, so their proper motions converge on one point on the sky.",
      "backing": "The perspective effect of a common velocity is standard kinematics.",
      "qualifier": "Reliable when cluster priors (members, radii) are known.",
      "rebuttal": "",
      "warrant_implicit": false,
      "kind": "native",
      "sources": [
        { "text": "Section 3.1", "target": { "doc_id": "arxiv-2501.17225", "anchor": "sec-7" } },
        { "text": "Equation 2", "target": { "doc_id": "arxiv-2501.17225", "anchor": "eq-2" } }
      ]
    },
    {
      "id": "tails-found",
      "title": "19 of 21 nearby clusters have tidal tails",
      "claim": "Nineteen of the 21 clusters within 400 pc have tidal tails.",
      "grounds": "",
      "warrant": "Overdensity of co-moving stars along the orbit beyond the tidal radius indicates a tail.",
      "warrant_implicit": true,
      "kind": "normal",
      "sources": [{ "text": "Section 4" }]
    },
    {
      "id": "s-shaped",
      "title": "4 of 19 tails are S-shaped, against theory",
      "claim": "Only 4 of the 19 tails show the S shape that theory predicts.",
      "grounds": "",
      "warrant": "A prediction that most tails do not follow signals a discrepancy with the theory.",
      "warrant_implicit": true,
      "kind": "end",
      "sources": [{ "text": "Section 5.5" }]
    }
  ],
  "edges": [
    { "from": "cp-method", "to": "tails-found", "role": "grounds" },
    { "from": "tails-found", "to": "s-shaped", "role": "grounds" }
  ]
}
```

- `arguments` and `edges` are both required keys (`[]` is fine). In an argument only `id` and `title` are required; every other field has a default (`""`, `false`, `kind: "normal"`, `sources: []`). Checked: an argument written with just `id` and `title` is accepted and stored with empty texts and `kind: "normal"`; such an argument is incomplete (the audit flags it), so fill the fields.
- `kind`: `native`, `end` or `normal`.
- `edges[*]`: `from` and `to` are argument `id`s, `role` is `grounds` | `warrant` | `backing` | `rebuttal`. **Direction: `from → to` means the Claim of `from` plays that role in `to`.** In the example, the CP method's Claim is Grounds of the tidal-tail argument (so that argument's `grounds` text may stay empty — the in-edge carries it), and the tidal-tail result is in turn Grounds of the S-shape argument, which is the unused one and therefore `end`.
- No self-loops; at most one edge per (from, to, role); `id` ≤ 64 characters, unique; `title` ≤ 80 and not blank; each text field ≤ 20000 characters; ≤ 500 arguments, ≤ 5000 edges.
- Cycles and arguments that cannot reach an End are **not** write errors, and you must not change the paper's logic to avoid them (see Audit).

## Step 5: Audit (for your report)

`argument.read` answers the workbench's own audit of a saved graph; before you write, do your own pass so you can report. Check:

1. **Cycles**: follow the edges; A depends on B depends on A. If the paper really argues in a circle, keep the cycle in the graph and report it as a finding about the paper. Do not delete edges or reshape arguments to make the graph acyclic.
2. **No path to an End**: arguments from which no chain of edges reaches an End argument. Keep them; report them (they may be dead ends in the paper, or a sign you missed an edge — re-read once before concluding).
3. **No End at all**: the graph has arguments but none is `end`.
4. **End with an out-edge**: an End argument used by another argument. With the Step 4 rule this should not arise from your own marking; if it shows up, the claim is used and belongs to `normal` (or you drew a wrong edge) — fix it, do not leave it as a finding.
5. **Native with an in-edge**: a Native argument that depends on another argument of the paper.
6. **Incomplete arguments**: empty Claim, or Grounds/Warrant with neither text nor an in-edge of that role (an inferred Warrant counts as written text; `warrant_implicit` is just its flag).

Fix the items that are *your* mistakes (a missing edge, a mislabeled kind, an empty field you could fill from the paper). Leave the items that are the paper's logic. After the write, `argument.read` returns the workbench's audit of what is saved: it should list exactly the findings you meant to report.

## Step 6: Write

**There is no dry run.** `argument.replace` really writes when the graph is empty. It checks, in this order: parameters → `expectedRev` against the stored `rev` → the whole graph against every rule in "The graph JSON" (required keys, field names, `kind`/`role` values, lengths, unique ids, edges naming existing ids, no self-loop, no duplicate (from, to, role)) → for a graph that already has arguments, the user's card. While you wait for the user's answer you may prepare and check the graph yourself; do not call `argument.replace` until you mean it.

Preconditions: you have the `rev` from `argument.read` (Step 0) and, if the graph is non-empty, you have told the user what will be lost.

```bash
argelanderspace argument replace --json /tmp/replace.json
```

where `/tmp/replace.json` is `{"workId": "arxiv:2501.17225", "expectedRev": 0, "graph": {"arguments": […], "edges": […]}}`. (`--json -` reads the object from stdin.)

- **Existing non-empty graph: it needs the user.** The answer comes only after the user decides on a card in the running workbench: approved → written (exit 0); refused → `denied`, nothing changed (exit 3); no workbench running → `workbench_required`, nothing written (exit 1: ask the user to open ArgelanderSpace on this project). Before the call say how many arguments the graph has, that `replace` replaces the whole graph (not a merge), and ask whether to go on. If the user declines, write nothing: leave the existing graph untouched, offer to show your result in the conversation (or save the scratch JSON to a path they name), and stop. The card replaces no question in the conversation; do both. Never try to get around a refused card, and never use `argument.clear` to empty the graph first (it needs a card too).
- A graph without arguments is written at once, in the workbench or in the command's own process.
- Success: `{"ok":true,"status":"ok","rev":<new>,"counts":{"arguments":N,"edges":M}}`. Show the user the graph with `argument.open` (`argelanderspace open argument-graph --work-id <workId>`; it needs the workbench open) or give the deep link `http://localhost:<port>/#argument/<url-encoded work id>`.
- **Every failure writes nothing.** Read the answer:
  - `status:"invalid"`: `issues` lists what is wrong, each with a `code` and the `argumentId` / `edge` / field it concerns (`title_blank`, a `message` for a type error). Fix every listed item, then call again with the same `expectedRev`. Expect more than one round: structural rules (duplicate ids, dangling edges, self-loops, duplicate edges) are checked after the type errors are gone.
  - `status:"unsupported"` with `detail` such as `graph: Unrecognized key: "version"`: the parameters were wrong; fix them. (CLI exit 2.)
  - `status:"conflict"`: someone (the user in the workbench, or another run) changed the graph since you read it; `latest` holds its present state. **Do not just retry with the new rev.** Look at what is there now and decide: if the graph is now non-empty, treat it as the "existing graph" case; if it is still empty, retry with the fresh `rev`.
  - `status:"expired"`: the user approved the card but the graph changed meanwhile; nothing was written. Read again and ask again.
  - `status:"not_found"`: the work id is wrong; use a work id (`search`), not a doc id.
  - `status:"error"` or anything about reading or writing files: report it to the user verbatim and stop; do not touch the data dir to work around it.
- After success, run `argument.read` once and check `counts` (and the Native/End counts, and `audit`) match what you meant to write.

For a small change to a graph that is already there (rename a title, fix a Warrant, add one edge), do not replace the whole graph: use `argument.update` (`{"id":…,"patch":{…}}`), `argument.create`, `argument.add_edge`, `argument.remove_edge` or `argument.delete`, each with the latest `rev`. A deleted argument comes back with `argument.undo_delete` while the workbench that deleted it still runs and the graph is unchanged.

The workbench may be open; it refreshes itself after the write. Do not write to the same Work's graph concurrently from two places.

The older whole-graph commands `argelanderspace argument get <workId>` and `argelanderspace argument put <workId> <file|-> --rev <n> [--replace]` still exist and behave as before, but `put --replace` has no confirmation card; use `argument.replace`.

## Final report to the user

Short, in the user's language (see "Language"), referring to arguments only by title. Two shapes:

### When the graph was written

1. **The link** to the argument graph in the workbench, and counts (N arguments, M edges, how many Native/End).
2. **The End arguments** (titles, with the claim in a sentence).
3. **The main chain(s)** leading to them: e.g. *Gaia DR3 sample* → *CP method* → *19 of 21 clusters have tails* → *4 of 19 tails are S-shaped, against theory* (name each hop's role if it is not Grounds).
4. **Audit findings**: cycles, arguments with no path to an End, missing End, End used by others, Native with in-edges, incomplete arguments — each by title; or "none found". Say which are the paper's logic and not edited away. State that the workbench shows its own audit from the saved graph.
5. **Caveats**: which Warrants you inferred (`warrant_implicit`), sources without a jump target, conversion gaps, PDF/no-body basis, and which Doc you read. Mention headline results that you kept `normal` because the paper uses them (Step 4).

### When you stop to ask before writing

Nothing is written yet, so say so first, then:

1. **What is there now**: the existing graph's number of arguments and edges and a few of its short titles (from `argument.read`), and `rev`.
2. **What a save does**: `argument.replace` replaces the **whole** graph; it is not a merge, and the existing arguments are lost. The user also approves a card in the workbench.
3. **A yes/no question**: "Replace the existing graph with the one I prepared?" — nothing else bundled in.
4. **What is prepared**: number of arguments/edges/Native/End, the End arguments, the main chain, audit findings and caveats as above, and where the draft JSON is (the scratch path), so the user can read it before deciding.
5. After **yes**: read the graph again to confirm `rev` has not moved (if it has, ask again), then call `argument.replace` with that `rev`, verify with `argument.read`, and give the written-graph report. After **no**: write nothing, keep the draft where it is or show it, and stop.

## Minimal operating procedure (external agent)

```bash
argelanderspace search                                     # work id + doc_ids (first = main Doc)
argelanderspace argument read --work-id <workId>           # rev, audit; is there already a graph?
argelanderspace read <docId> --manifest refs               # (PDF Doc: argelanderspace pdf-path <docId>, then read the file)
argelanderspace read <docId> --section <secId>             # read; show/ref as needed
# ... write /tmp/replace.json: {"workId":…,"expectedRev":<rev>,"graph":{…}} ...
argelanderspace argument replace --json /tmp/replace.json  # a non-empty graph: the user decides on a card in the workbench
argelanderspace argument read --work-id <workId>           # check counts and audit; report in the user's language
```
