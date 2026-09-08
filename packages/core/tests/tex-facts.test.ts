/**
 * Compiler-facts parsers (Stage 5 MS1, `src/pipelines/tex/facts/`).
 *
 * Pure unit tests on hand-written artifacts plus integration tests over the
 * FROZEN real artifacts in `fixtures/tex/<name>/build/` (emitted by the
 * infra latexmk runner + argelander.sty instrumentation, then committed so
 * these tests never need a TeX toolchain).
 */

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseAux } from "../src/pipelines/tex/facts/aux.js";
import { parseBbl } from "../src/pipelines/tex/facts/bbl.js";
import { parseTexEvents } from "../src/pipelines/tex/facts/events.js";
import { parseFls } from "../src/pipelines/tex/facts/fls.js";
import { parseTexFacts } from "../src/pipelines/tex/facts/index.js";
import { parseToc } from "../src/pipelines/tex/facts/toc.js";

const FIXTURES = fileURLToPath(new URL("fixtures/tex", import.meta.url));

// --------------------------------------------------------------------------- //
// .aux
// --------------------------------------------------------------------------- //

describe("parseAux", () => {
  test("classic 2-field \\newlabel without title", () => {
    const { labels } = parseAux("\\newlabel{sec:a}{{2}{4}}");
    expect(labels["sec:a"]).toEqual({ number: "2", page: "4" });
  });

  test("hyperref 5-field \\newlabel keeps a non-empty title", () => {
    const { labels } = parseAux("\\newlabel{eq:b}{{3.1}{5}{Section Title}{subsection.3.1}{}}");
    expect(labels["eq:b"]).toEqual({ number: "3.1", page: "5", title: "Section Title" });
  });

  test("empty title field is omitted; duplicate keys: last wins", () => {
    const { labels } = parseAux(
      "\\newlabel{x}{{1}{1}{}{}{}}\n\\newlabel{x}{{2}{3}{}{}{}}\n\\newlabel{y}{{1}{2}{}{}{}}"
    );
    expect(labels.x).toEqual({ number: "2", page: "3" });
    expect(labels.y).toEqual({ number: "1", page: "2" });
  });

  test("\\citation comma lists split and dedupe in first-appearance order", () => {
    const { citations } = parseAux("\\citation{a,b}\n\\citation{c}\n\\citation{a}");
    expect(citations).toEqual(["a", "b", "c"]);
  });

  test("\\bibcite: classic single-field and natbib packed form", () => {
    const { bibcites } = parseAux(
      "\\bibcite{plain}{7}\n\\bibcite{packed}{{1}{1968}{{Dijkstra}}{{}}}"
    );
    expect(bibcites.plain).toBe("7");
    expect(bibcites.packed).toBe("{1}{1968}{{Dijkstra}}{{}}");
  });

  test("command names sharing a prefix are not matched", () => {
    const { citations } = parseAux("\\citationx{zzz}\n\\citation{real}");
    expect(citations).toEqual(["real"]);
  });

  test("malformed commands degrade to partial results, never throw", () => {
    const { labels, citations } = parseAux("\\newlabel{broken\n\\citation{ok}\n\\newlabel{{}}");
    expect(citations).toEqual(["ok"]);
    expect(Object.keys(labels)).toEqual([]);
  });

  test("\\@writefile{lof}/{lot} records parse into print-order float numbers", () => {
    const aux = [
      "\\newlabel{fig:a}{{1}{1}{}{}{}}",
      "\\@writefile{lof}{\\contentsline {figure}{\\numberline {1}First}{1}{}%}",
      "\\@writefile{lof}{\\contentsline {figure}{\\numberline {2}Second}{2}{}%}",
      "\\@writefile{lot}{\\contentsline {table}{\\numberline {A.1}Tab}{3}{}%}",
      "\\@writefile{toc}{\\contentsline {section}{\\numberline {1}Intro}{1}{}%}",
    ].join("\n");
    const { lof, lot } = parseAux(aux);
    expect(lof).toEqual([
      { level: "figure", number: "1", title: "First", page: "1" },
      { level: "figure", number: "2", title: "Second", page: "2" },
    ]);
    expect(lot).toEqual([{ level: "table", number: "A.1", title: "Tab", page: "3" }]);
  });
});

// --------------------------------------------------------------------------- //
// .toc
// --------------------------------------------------------------------------- //

describe("parseToc", () => {
  test("numbered entry, 4th anchor arg ignored", () => {
    const toc = parseToc("\\contentsline {section}{\\numberline {1}Introduction}{1}{}%");
    expect(toc).toEqual([{ level: "section", number: "1", title: "Introduction", page: "1" }]);
  });

  test("unnumbered heading gets empty number", () => {
    const toc = parseToc("\\contentsline{section}{Appendix}{7}");
    expect(toc).toEqual([{ level: "section", number: "", title: "Appendix", page: "7" }]);
  });

  test("figure entries from a .lof-shaped file", () => {
    const toc = parseToc("\\contentsline {figure}{\\numberline {2}{\\ignorespaces Cap text}}{3}");
    expect(toc).toHaveLength(1);
    expect(toc[0]?.level).toBe("figure");
    expect(toc[0]?.number).toBe("2");
    expect(toc[0]?.title).toContain("Cap text");
  });

  test("garbage lines are skipped", () => {
    const toc = parseToc("random text\n\\contentsline{broken}\n\\contentsline{section}{T}{2}");
    expect(toc).toEqual([{ level: "section", number: "", title: "T", page: "2" }]);
  });
});

// --------------------------------------------------------------------------- //
// .fls
// --------------------------------------------------------------------------- //

describe("parseFls", () => {
  test("INPUT lines normalized, deduped, first-appearance order; PWD/OUTPUT ignored", () => {
    const fls = [
      "PWD /tmp/argelander-tex-xyz",
      "INPUT /etc/texmf/web2c/texmf.cnf",
      "INPUT ./main.tex",
      "INPUT main.tex",
      "OUTPUT main.log",
      "INPUT ./sub/chap1.tex",
      "INPUT /usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
      "INPUT main.tex",
      "",
    ].join("\n");
    expect(parseFls(fls)).toEqual([
      "/etc/texmf/web2c/texmf.cnf",
      "main.tex",
      "sub/chap1.tex",
      "/usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
    ]);
  });

  test("empty content → empty list", () => {
    expect(parseFls("")).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// .bbl
// --------------------------------------------------------------------------- //

describe("parseBbl", () => {
  const bbl = [
    "\\begin{thebibliography}{9}",
    "\\bibitem[Dijkstra(1968)]{dijkstra1968}",
    "Edsger~W. Dijkstra. \\newblock Go to statement considered harmful.",
    "",
    "\\bibitem{webref}",
    "See \\url{https://example.com/paper.pdf} and \\doi{10.1234/abc.def}.",
    "",
    "\\bibitem{preprint}",
    "Preprint at arXiv:2101.00001v2.",
    "\\end{thebibliography}",
  ].join("\n");

  test("bibitems with and without [label], raw spans between items", () => {
    const { references, warnings } = parseBbl(bbl);
    expect(warnings).toEqual([]);
    expect(references.map((r) => r.key)).toEqual(["dijkstra1968", "webref", "preprint"]);
    expect(references[0]?.label).toBe("Dijkstra(1968)"); // [label] captured
    expect(references[1]?.label).toBeUndefined();
    expect(references[0]?.raw).toContain("Go to statement considered harmful.");
    expect(references[0]?.raw).not.toContain("\\bibitem");
    expect(references[2]?.raw).toContain("arXiv:2101.00001v2.");
  });

  test("doi/arxiv/url extracted; doi.org/arxiv.org URLs not duplicated as url", () => {
    const { references } = parseBbl(bbl);
    expect(references[1]?.doi).toBe("10.1234/abc.def");
    expect(references[1]?.url).toBe("https://example.com/paper.pdf");
    expect(references[2]?.arxiv).toBe("2101.00001v2");
    expect(references[0]?.doi).toBeUndefined();
    expect(references[0]?.url).toBeUndefined();
  });

  test("doi from a doi.org URL; trailing punctuation stripped", () => {
    const { references } = parseBbl(
      "\\begin{thebibliography}{1}\n\\bibitem{k} Available at https://doi.org/10.5555/xyz.789.\n\\end{thebibliography}"
    );
    expect(references[0]?.doi).toBe("10.5555/xyz.789");
    expect(references[0]?.url).toBeUndefined();
  });

  test("bare DOI form requires a letter in the suffix (prose regression)", () => {
    // "10.1234/567" is a page-like number pair, not a DOI (MS1 review N4).
    const { references } = parseBbl(
      "\\begin{thebibliography}{2}\n" +
        "\\bibitem{prose} Journal of Examples \\textbf{10}, 1234--567 (2020).\n" +
        "\\bibitem{real} New block 10.1000/xyz123 without any marker.\n" +
        "\\bibitem{explicit} Marked \\doi{10.5555/1234} with a pure-numeric suffix.\n" +
        "\\end{thebibliography}"
    );
    expect(references[0]?.doi).toBeUndefined(); // "10}, 1234" never even forms 10.NNNN/...
    expect(references[1]?.doi).toBe("10.1000/xyz123"); // bare, letter in suffix
    expect(references[2]?.doi).toBe("10.5555/1234"); // explicit marker, no letter needed
  });

  test("bare number pair resembling a DOI is not extracted", () => {
    const { references } = parseBbl(
      "\\begin{thebibliography}{1}\n\\bibitem{k} See volume 10.1234/567 for details.\n\\end{thebibliography}"
    );
    expect(references[0]?.doi).toBeUndefined();
  });

  test("titles/authors are never guessed (absent from the fact shape)", () => {
    const { references } = parseBbl(bbl);
    const keys0 = Object.keys(references[0] ?? {}).sort();
    expect(keys0).not.toContain("title");
    expect(keys0).not.toContain("authors");
    expect(keys0).toEqual(["key", "label", "raw"]);
  });

  test("biblatex-style .bbl (no thebibliography) → empty + warning", () => {
    const { references, warnings } = parseBbl(
      "\\begin{refsection}\n\\entry{key}{book}{}\n\\end{refsection}"
    );
    expect(references).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("thebibliography");
  });

  test("empty .bbl → empty, no warning", () => {
    const { references, warnings } = parseBbl("");
    expect(references).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// .argelander.jsonl event stream
// --------------------------------------------------------------------------- //

describe("parseTexEvents", () => {
  test("round-trips every event family, file field included", () => {
    const content = [
      '{"type":"citation","id":"cite-000001","keys":["a","b"],"file":"main.tex","line":12,"page":"1"}',
      '{"type":"label","id":"label-000001","key":"sec:x","file":"child.tex","line":13,"page":"1"}',
      '{"type":"section","id":"section-000001","name":"section","number":"1","title":"Intro","file":"main.tex","line":10,"page":"1"}',
      '{"type":"mathnum","id":"math-000001","env":"align","number":"2.1","file":"main.tex","line":21,"page":"3"}',
    ].join("\n");
    const { events, warnings } = parseTexEvents(content);
    expect(warnings).toEqual([]);
    expect(events).toEqual([
      {
        type: "citation",
        id: "cite-000001",
        keys: ["a", "b"],
        file: "main.tex",
        line: 12,
        page: "1",
      },
      { type: "label", id: "label-000001", key: "sec:x", file: "child.tex", line: 13, page: "1" },
      {
        type: "section",
        id: "section-000001",
        name: "section",
        number: "1",
        title: "Intro",
        file: "main.tex",
        line: 10,
        page: "1",
      },
      {
        type: "mathnum",
        id: "math-000001",
        env: "align",
        number: "2.1",
        file: "main.tex",
        line: 21,
        page: "3",
      },
    ]);
  });

  test("file field is optional (pre-file-field streams still parse); non-string file is dropped", () => {
    const content = [
      '{"type":"label","id":"label-000001","key":"a","line":1,"page":"1"}',
      '{"type":"label","id":"label-000002","key":"b","file":42,"line":2,"page":"1"}',
    ].join("\n");
    const { events, warnings } = parseTexEvents(content);
    expect(warnings).toEqual([]);
    expect(events).toEqual([
      { type: "label", id: "label-000001", key: "a", line: 1, page: "1" },
      { type: "label", id: "label-000002", key: "b", line: 2, page: "1" },
    ]);
  });

  test("mathnum events with macro-laden numbers are dropped with a counted warning", () => {
    // Real shapes emitted by the .sty for \eqref-in-display / \tag{T\eqref{..}}:
    const content = [
      '{"type":"mathnum","id":"math-000001","env":"equation","number":"1","file":"main.tex","line":4,"page":"1"}',
      '{"type":"mathnum","id":"math-000002","env":"equation","number":"\\\\ref {eq:base}","file":"main.tex","line":6,"page":"1"}',
      '{"type":"mathnum","id":"math-000006","env":"equation","number":"2","file":"main.tex","line":6,"page":"1"}',
      '{"type":"mathnum","id":"math-000007","env":"equation","number":"T\\\\protect \\\\eqref  {eq:base}","file":"main.tex","line":7,"page":"1"}',
    ].join("\n");
    const { events, warnings } = parseTexEvents(content);
    expect(events.map((e) => (e.type === "mathnum" ? e.number : ""))).toEqual(["1", "2"]);
    // id gaps from the dropped events are expected and tolerated
    expect(events.map((e) => e.id)).toEqual(["math-000001", "math-000006"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dropped 2 mathnum");
  });

  test("malformed lines are skipped with one counted warning", () => {
    const content = [
      '{"type":"citation","id":"cite-000001","keys":["a"],"line":12,"page":"1"}',
      "not json at all",
      '{"type":"unknown","id":"x-1","line":1,"page":"1"}',
      '{"type":"label","id":"label-000001","line":13,"page":"1"}', // key missing
      '{"type":"mathnum","id":"math-000001","env":"equation","number":"1","line":5,"page":3}', // page not a string
      "",
    ].join("\n");
    const { events, warnings } = parseTexEvents(content);
    expect(events).toEqual([
      { type: "citation", id: "cite-000001", keys: ["a"], line: 12, page: "1" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("skipped 4");
  });

  test("empty stream → no events, no warnings", () => {
    const { events, warnings } = parseTexEvents("\n\n");
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// Frozen real artifacts (emitted by packages/infra/src/tex runner)
// --------------------------------------------------------------------------- //

describe("parseTexFacts on frozen battery build (amsmath + natbib + bibtex)", () => {
  const build = `${FIXTURES}/battery/build`;
  const facts = parseTexFacts({
    aux: `${build}/main.aux`,
    bbl: `${build}/main.bbl`,
    toc: `${build}/main.toc`,
    fls: `${build}/main.fls`,
    events: `${build}/main.argelander.jsonl`,
  });

  test("no warnings", () => {
    expect(facts.warnings).toEqual([]);
  });

  test("labels carry the compiler's printed numbers", () => {
    expect(facts.labels["sec:intro"]).toEqual({ number: "1", page: "1" });
    expect(facts.labels["sec:background"]).toEqual({ number: "1.1", page: "1" });
    expect(facts.labels["sec:math"]).toEqual({ number: "2", page: "1" });
    expect(facts.labels["eq:a"]).toEqual({ number: "1", page: "1" });
    expect(facts.labels["eq:al1"]).toEqual({ number: "3", page: "2" });
    expect(facts.labels["fig:placeholder"]).toEqual({ number: "1", page: "1" });
  });

  test("citations + natbib bibcites", () => {
    expect(facts.citations).toEqual([
      "knuth1984texbook",
      "lamport1994latex",
      "dijkstra1968letters",
    ]);
    expect(Object.keys(facts.bibcites).sort()).toEqual([
      "dijkstra1968letters",
      "knuth1984texbook",
      "lamport1994latex",
    ]);
  });

  test("toc entries", () => {
    expect(facts.toc).toEqual([
      { level: "section", number: "1", title: "Introduction", page: "1" },
      { level: "subsection", number: "1.1", title: "Background", page: "1" },
      { level: "section", number: "2", title: "Math battery", page: "1" },
    ]);
  });

  test("fls inputs include the main file, the .bbl and the wrapper", () => {
    expect(facts.inputs).toContain("main.tex");
    // bibtex is run by latexmk without -recorder, so refs.bib never lands in
    // the .fls — the engine's INPUT of the compiled main.bbl does.
    expect(facts.inputs).toContain("main.bbl");
    expect(facts.inputs).toContain("__argelander_wrap.tex");
    expect(facts.inputs.some((p) => p.startsWith("/"))).toBe(true); // system TeX Live files
  });

  test("references from the bibtex .bbl (doi recognized, titles not guessed)", () => {
    expect(facts.references.map((r) => r.key)).toEqual([
      "dijkstra1968letters",
      "knuth1984texbook",
      "lamport1994latex",
    ]);
    const knuth = facts.references[1];
    expect(knuth?.raw).toContain("The TeXbook");
    expect(knuth?.doi).toBe("10.1000/xyz123");
  });

  test("event stream: cite/label/section/mathnum families with stable ids", () => {
    expect(facts.events).toHaveLength(26);
    const cites = facts.events.filter((e) => e.type === "citation");
    expect(cites.map((e) => e.id)).toEqual([
      "cite-000001",
      "cite-000002",
      "cite-000003",
      "cite-000004",
      "cite-000005",
    ]);
    expect(cites[0]).toMatchObject({ keys: ["knuth1984texbook"] });
    const sections = facts.events.filter((e) => e.type === "section");
    expect(sections.map((s) => (s.type === "section" ? s.number : ""))).toEqual(["1", "1.1", "2"]);
  });

  test("mathnum: the full display-math battery with printed numbers", () => {
    const math = facts.events.filter((e) => e.type === "mathnum");
    expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
      "equation:1", // labeled
      "equation:2", // unlabeled
      "equation:A1", // \tag{A1} — counter not advanced
      "align:3", // align row 1 (\label)
      "align:X", // align row 3 (\tag{X}; row 2 \nonumber emits nothing)
      "gather:4",
      "gather:5",
      "multline:6",
      "eqnarray:7",
      "eqnarray:8",
      "equation:9", // in the \input child file
    ]);
  });

  test("file field: main.tex for master events, child.tex for \\input child events", () => {
    const childEvents = facts.events.filter((e) => e.file === "child.tex");
    expect(childEvents.map((e) => e.type)).toEqual(["citation", "label", "mathnum"]);
    const childMath = childEvents.find((e) => e.type === "mathnum");
    expect(childMath).toMatchObject({ env: "equation", number: "9", line: 5 });
    const mainEvents = facts.events.filter((e) => e.file === "main.tex");
    expect(mainEvents).toHaveLength(23);
    // every event carries a file
    expect(facts.events.every((e) => e.file !== undefined)).toBe(true);
  });

  test("child-file \\input lands in labels and the fls input list", () => {
    expect(facts.labels["child:mark"]).toEqual({ number: "2", page: "2" });
    expect(facts.inputs).toContain("child.tex");
  });
});

describe("parseTexFacts on frozen minimal build (kernel paths, twocolumn)", () => {
  const build = `${FIXTURES}/minimal/build`;
  const facts = parseTexFacts({
    aux: `${build}/main.aux`,
    fls: `${build}/main.fls`,
    events: `${build}/main.argelander.jsonl`,
  });

  test("labels + classic bibcite", () => {
    expect(facts.labels["sec:k"]).toEqual({ number: "1", page: "1" });
    expect(facts.labels["eq:k"]).toEqual({ number: "1", page: "1" });
    expect(facts.bibcites.knuth1984texbook).toBe("1");
  });

  test("kernel cite event and kernel mathnum path", () => {
    expect(facts.events).toHaveLength(7);
    const cites = facts.events.filter((e) => e.type === "citation");
    expect(cites).toHaveLength(1);
    expect(cites[0]?.file).toBe("main.tex");
    const math = facts.events.filter((e) => e.type === "mathnum");
    expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
      "equation:1",
      "equation:2",
      "eqnarray:3", // first row \\nonumber emits nothing
    ]);
  });
});

describe("parseTexFacts on frozen hyperref build (amsmath + hyperref + natbib, \\tag regression)", () => {
  const build = `${FIXTURES}/hyperref/build`;
  const facts = parseTexFacts({
    aux: `${build}/main.aux`,
    fls: `${build}/main.fls`,
    events: `${build}/main.argelander.jsonl`,
  });

  test("no warnings, 16 events, all from main.tex", () => {
    expect(facts.warnings).toEqual([]);
    expect(facts.events).toHaveLength(16);
    expect(facts.events.every((e) => e.file === "main.tex")).toBe(true);
  });

  test("mathnum under hyperref: \\tag{B} captured exactly, subequations, aligned", () => {
    const math = facts.events.filter((e) => e.type === "mathnum");
    expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
      "equation:1", // \label{eq:one}
      "equation:B", // \tag{B} — hyperref's \Hy@make@anchor wrapper neutralized (B1)
      "equation:2", // counter correctly NOT advanced by the tag
      "equation:3a", // subequations
      "equation:3b",
      "equation:4", // aligned-inside-equation: exactly one event for the outer number
      "equation:T1", // labeled \tag{T1}
    ]);
  });

  test("section title with macros is JSON-escaped, cites and labels intact", () => {
    const section = facts.events.find((e) => e.type === "section");
    expect(section).toMatchObject({ name: "section", number: "1" });
    expect(section?.type === "section" && section.title).toContain("Cases");
    expect(facts.events.filter((e) => e.type === "citation")).toHaveLength(2);
    expect(Object.keys(facts.labels).sort()).toEqual([
      "eq:aligned",
      "eq:one",
      "eq:sub-a",
      "eq:tagged",
      "eq:two",
      "sec:adv",
    ]);
    // hyperref/nameref records the current section title into every \newlabel
    const advTitle = "Adversarial \\emph {Math} \\& $x^2$ Cases";
    expect(facts.labels["eq:two"]).toEqual({ number: "2", page: "1", title: advTitle });
    expect(facts.labels["eq:sub-a"]).toEqual({ number: "3a", page: "1", title: advTitle });
    // labeled \tag: aux wraps the number in braces ("{T1}") — MS2 joins strip them
    expect(facts.labels["eq:tagged"]?.number).toBe("{T1}");
  });
});

describe("parseTexFacts degradation", () => {
  test("absent artifacts (missing files) are silent, never throw", () => {
    // ENOENT = the artifact simply wasn't produced (no .toc without
    // \tableofcontents) — normal, no warning (MS2 review N2).
    const facts = parseTexFacts({
      aux: `${FIXTURES}/does-not-exist/main.aux`,
      bbl: `${FIXTURES}/does-not-exist/main.bbl`,
    });
    expect(facts.labels).toEqual({});
    expect(facts.references).toEqual([]);
    expect(facts.warnings).toEqual([]);
  });

  test("unreadable artifacts (a directory as .aux) warn", () => {
    const facts = parseTexFacts({ aux: FIXTURES });
    expect(facts.labels).toEqual({});
    expect(facts.warnings).toHaveLength(1);
    expect(facts.warnings[0]).toContain("unreadable");
  });

  test("absent artifacts (undefined paths) are simply skipped", () => {
    const facts = parseTexFacts({});
    expect(facts.warnings).toEqual([]);
    expect(facts.events).toEqual([]);
  });
});
