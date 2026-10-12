/**
 * The method for organizing a paper's argument graph, as the Copilot's argument tool hands it over on request
 * (`argument guide`, argument graph ticket 09). The tool's description stays short because tool schemas count against
 * every model window; this text is read once, when the user asks for a graph.
 *
 * It states the same rules as `skills/argelander-argument-graph/SKILL.md` (the external agents' version of the same
 * method: Toulmin definitions, the six steps, completeness, titles, granularity, sources, audit). The skill speaks of the
 * CLI and this text of the tool; the rules are the same words. `ARGUMENT_GUIDE_RULES` lists the key rules by an exact
 * phrase that must occur in both files; `copilot-argument-guide.test.ts` holds them to it, so neither can drift alone.
 */

/** Key rules: a phrase that must occur verbatim in the skill and in the guide. */
export const ARGUMENT_GUIDE_RULES: readonly { rule: string; phrase: string }[] = [
  { rule: "Claim", phrase: "what the author wants the reader to accept" },
  { rule: "Warrant", phrase: "the rule that explains why the Grounds lead to the Claim" },
  { rule: "Backing", phrase: "what shows the Warrant is reliable" },
  { rule: "Qualifier is never an edge", phrase: "A Qualifier is never an edge" },
  {
    rule: "no codes for arguments",
    phrase: "Never refer to an argument by a number or letter code",
  },
  { rule: "Native is explicit", phrase: 'never assume "no in-edges" means Native' },
  { rule: "End is explicit", phrase: 'never assume "no out-edges" means End' },
  { rule: "End: nothing else uses it", phrase: "that nothing else in the paper uses" },
  { rule: "step 1", phrase: "Find the Native arguments" },
  { rule: "step 2", phrase: "Climb the intermediate chain" },
  { rule: "step 3", phrase: "Add Qualifiers and Rebuttals" },
  { rule: "step 4", phrase: "Advance to the End arguments" },
  { rule: "step 5", phrase: "Audit" },
  { rule: "step 6", phrase: "Write" },
  {
    rule: "a compared prediction is grounds, not rebuttal",
    phrase: "it is not an exception to the discrepancy claim",
  },
  { rule: "no invented hub claims", phrase: "Do not invent" },
  {
    rule: "an inferred Warrant is written out",
    phrase: "that flag does not excuse an empty Warrant",
  },
  { rule: "titles", phrase: "descriptive and distinct" },
  { rule: "granularity", phrase: "not per paragraph" },
  { rule: "source texts", phrase: "Section 3.2" },
  { rule: "cycles are kept", phrase: "to make the graph acyclic" },
  {
    rule: "the paper's logic is not edited away",
    phrase: "Leave the items that are the paper's logic",
  },
  {
    rule: "no body: do not fill from memory",
    phrase: "do not fill the graph from memory of the paper",
  },
  { rule: "figures", phrase: "Never claim to have inspected a figure image you did not open" },
  {
    rule: "cited methods",
    phrase: "Do not describe a cited method as this paper's contribution unless the text says so",
  },
  { rule: "headline result used further stays normal", phrase: "is an intermediate" },
];

export const ARGUMENT_GUIDE = `ARGUMENT GRAPH METHOD (Toulmin). Turn one paper into an argument graph and write it with this tool.

VOCABULARY
- Argument graph: belongs to one Work, at most one per Work, may contain cycles; it is not the paper's Doc.
- Argument: one node. Claim, Grounds, Warrant, optionally Backing, Qualifier, Rebuttal, plus a short title.
  Claim: what the author wants the reader to accept. Grounds: evidence, facts, inputs. Warrant: the rule that explains why the Grounds lead to the Claim. Backing: what shows the Warrant is reliable. Qualifier: limits on scope or certainty ("typically", "for clusters within 400 pc"). Rebuttal: acknowledged exceptions under which the Claim fails.
- Argument edge: from argument A to argument B means A's Claim plays a role in B: grounds, warrant, backing or rebuttal. A Qualifier is never an edge; it is text on the argument.
- Native argument: its Grounds/Warrant/Backing come entirely from outside this paper (citations, established datasets, physical laws, standard domain knowledge). Mark it explicitly (kind native); never assume "no in-edges" means Native.
- End argument: a final contribution or conclusion that nothing else in the paper uses, so it has no out-edges. Mark it explicitly (kind end); never assume "no out-edges" means End.
- Source: where in the paper an argument comes from; reference only.
- Audit: the problems computed from the graph (cycles, no path to an End, ...); never stored.
Never refer to an argument by a number or letter code (A1, E3, "node 4"). Say its short title, to the user and in titles. The id is only an internal label that edges point at (a readable slug such as cp-method is fine). Report in the user's language; the field names, kind values and edge roles are always the English ones; argument text follows the paper's language unless the user asks otherwise.

FIRST
1. The Work: argument read {workId} gives its id, title, Docs (the first is the main Doc, read it by default unless the user names another) and the current graph with its rev. Remember rev; every write sends it back as expectedRev.
2. If the graph is not empty, say how many arguments it has: replace and clear wait for the user's confirmation card (you cannot approve it; a reply in chat does not). You may do the analysis meanwhile. One-by-one create/update/delete/add_edge/remove_edge do not need a card.
3. The body: read it with the reader tool (reader read {docId}: a LaTeX or text Doc comes as entries, a PDF Doc as page text and page images; follow the parts it says are unread before you rely on them). Read the prose, not just matches; resolve the equations and citations that matter. Metadata of a cited reference describes the cited work, which is what makes a Native argument native, never something this paper demonstrated. Do not describe a cited method as this paper's contribution unless the text says so. Never claim to have inspected a figure image you did not open; work from caption and prose. Say in your report where conversion left gaps.
4. No body: if the Work has no Doc (docs is empty), or its only Doc cannot be read, say plainly that there is no readable body. Work only from what the user gives you (pasted text, an abstract) and say that this is the basis; do not fill the graph from memory of the paper. If the user supplies nothing, ask.

THE SIX STEPS (work bottom-up; keep a running list of arguments and edges before you write)
1. Find the Native arguments: in the introduction, background and methods, statements backed entirely by citations, standard data, laws or domain knowledge. Each becomes an argument with kind native. Example: Claim "Feature extraction via ResNet-50 is robust for image classification"; Grounds "baseline accuracy scores from Smith 2020"; Warrant (implicit) "high accuracy on a standard benchmark indicates robust features".
2. Climb the intermediate chain: read methods, results, discussion; how does the paper build new claims on those foundations? Create the intermediate arguments and connect them: an edge from each supporting argument, with the role its Claim plays in the target. Ask of each edge: is this Claim used as evidence, as the rule that licenses the step, as support for that rule, or as an exception? Use the definitions strictly: grounds = the facts, data or results the Claim is inferred from; warrant = the general rule that licenses the step from Grounds to Claim; backing = what shows that rule is reliable or appropriate; rebuttal = a condition under which the target's Claim would fail. Three cases that are easy to get wrong:
   - A prediction the result is compared with (a theory predicts S-shaped tails; the data show only 4 of 19): the argument "the tails contradict the theory" gets both the observation and the prediction as grounds (the prediction is typically a Native argument); its Warrant is the comparison rule. It is not a rebuttal: it is not an exception to the discrepancy claim. A prediction used as the rule to interpret data is a warrant.
   - Motivation ("model-dependent methods may be biased, so we use a model-independent one"): its own argument (Native if it rests on cited work), connected as backing of the argument that applies the method. With no logical use further on, draw no edge; keep it only as a source.
   - Corroborating checks: a check that bears on this result (an independent test of the very objects the Claim is about) is an extra grounds of that result. A check that bears on whether the method can be trusted in general (it reproduces known tails, validated on a benchmark) is backing of the method's Warrant. A check that reveals a limit goes to the target's qualifier or rebuttal text.
3. Add Qualifiers and Rebuttals from limitations, edge cases, error margins and scope statements. If the sentence says how far or how strongly the Claim holds ("mostly", "within 400 pc", "+-10 %") it is a qualifier; if it names a condition under which the Claim would be false ("unless field-star contamination is large") it is a rebuttal. Put them in the text fields; where an exception is itself an argument of the paper, add a rebuttal edge too.
4. Advance to the End arguments: keep linking (Lemma -> Theorem; experiment A + experiment B -> conclusion) until the chains reach the final contributions and conclusions. A candidate is every claim the paper presents as its own final contribution or conclusion (abstract, promises in the introduction, items of the conclusions). An End is a candidate that no other argument of the paper uses: mark exactly those kind end. A result that is both a contribution and used to derive other conclusions (the headline discovery the scaling relations are built on) is an intermediate (kind normal) with edges to the arguments that use it; the conclusions that use it and are not used further are the Ends. Say so in the report. Do not invent an argument the paper does not state (a "hub" claim) just to keep a headline result free of out-edges; a real intermediate product the paper states (a released catalogue) may be its own argument. Never mark a used claim end to make it prominent; if the paper's logic leaves no unused conclusion, leave the graph without an End and report it.
5. Audit (for your report): cycles (keep a real circular argument and report it; do not delete edges or reshape arguments to make the graph acyclic); arguments with no path to an End (keep, report; re-read once before concluding you missed an edge); no End at all; an End with an out-edge (your marking is wrong: fix it); a Native with an in-edge; incomplete arguments (empty Claim; Grounds or Warrant with neither text nor an in-edge of that role). Fix the items that are your mistakes (a missing edge, a wrong kind, an empty field you could fill from the paper). Leave the items that are the paper's logic. The workbench shows its own audit of the saved graph; argument read returns it too.
6. Write (below).

EACH ARGUMENT
- Complete: a Claim, Grounds and a Warrant, as non-empty text or (Grounds, Warrant) an incoming edge with that role, which then carries it. If the paper leaves the Warrant unstated, write the one you infer and set warrant_implicit true; that flag does not excuse an empty Warrant. When an incoming edge carries Grounds or Warrant the text may stay empty and warrant_implicit is false. Write claims as complete statements, not labels; keep the paper's symbols and numbers (Markdown and $math$ are fine).
- Title: at most 80 characters, descriptive and distinct ("CP method locates co-moving stars", "Nineteen of 21 clusters have tidal tails"); not "A1", "Step 3", "Claim 2".
- Granularity: one argument per step of the paper's reasoning, not per paragraph: a claim the paper states, supports, and that either feeds a later claim or is a conclusion. Per-object subsections (twelve clusters) become one argument with several sources unless one object carries a distinct claim that others use. A 30-40-section paper gives roughly 15-40 arguments, a short letter 8-15; far above 60 usually means you are summarising paragraphs. Hard limits: 500 arguments, 5000 edges.
- Sources: sources [{text, target?}]. text is display text: Section 3.2, Figure 4, Equation 7, Table 2, Page 5 (English words, no section sign, no Eq./Fig. abbreviations; the number printed in the paper; an unnumbered part uses its title: Abstract; appendix floats keep their printed numbers: Table A.3). target {doc_id, anchor} for a LaTeX or text Doc (the structural id exactly as the reading prints it: sec-N, eq-N, fig-N, tab-N, code-N, alg-N), or {doc_id, page} (from 1) for a PDF Doc. Without a target the source is only text; copy ids, never guess them (a wrong anchor silently points nowhere). At most 50 per argument.
- Edges: from -> to means the Claim of from plays role in to. No self-loops; at most one edge per (from, to, role).

WRITE
- A graph that is empty now: argument replace {workId, expectedRev, graph:{arguments, edges}} writes it at once (no card). For a few changes use create / update / delete / add_edge / remove_edge instead, one at a time; an edit never replaces the rest.
- A graph that is not empty: replace and clear show the user a confirmation card (title, arguments and edges lost, arguments and edges after) and return after their decision. declined or expired: nothing was written; do not ask again unless the user wants it.
- A conflict (rev changed): read again, look at what is there now (the user may have edited), then form a new edit; never resend the stale one. If the graph meanwhile became non-empty, treat it as the non-empty case.
- A refused edit or a validation failure writes nothing and says why; fix exactly that and send again.
- After writing, argument read once and check the counts match what you meant.

REPORT (short, in the user's language, arguments by title only)
1. Counts: N arguments, M edges, how many Native and End. 2. The End arguments, each with its claim in a sentence. 3. The main chain(s) leading to them, naming each hop's role when it is not grounds. 4. Audit findings by title (or none), saying which are the paper's logic and left as they are. 5. Caveats: Warrants you inferred (warrant_implicit), sources without a jump target, conversion gaps, a PDF or no-body basis, which Doc you read, headline results you kept as intermediates because the paper uses them.`;
