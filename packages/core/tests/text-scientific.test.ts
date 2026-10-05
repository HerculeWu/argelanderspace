import { type IrBlock, type IrSection, TextDocIrSchema } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { parseTextSource, textSourceFingerprint } from "../src/documents/text-codec.js";

const opts = { docId: "text-1", sourceRev: 7 };
const fence = "```";

function parse(md: string) {
  return parseTextSource(md, opts);
}
function codes(md: string) {
  return parse(md).diagnostics.map((d) => [d.code, d.severity, d.line, d.column]);
}
function blocksOf(md: string): IrBlock[] {
  const out: IrBlock[] = [];
  const walk = (sections: IrSection[]) => {
    for (const s of sections) {
      out.push(...s.blocks);
      walk(s.children);
    }
  };
  walk(parse(md).ir?.sections ?? []);
  return out;
}
const marker = (name: string, json: unknown) =>
  `${fence}${name}\n${typeof json === "string" ? json : JSON.stringify(json, null, 2)}\n${fence}\n`;

const FULL = [
  marker("argelander-document", {
    version: 1,
    title: "On Dark Matter",
    authors: ["Ada Lovelace", "Alan Turing"],
    authorDetails: [{ name: "Ada Lovelace", affiliations: [1], email: "ada@example.org" }],
    affiliations: ["Analytical Engine Lab"],
  }),
  "Front matter before any heading, with $E=mc^2$ inline.",
  "",
  marker("argelander-block", { id: "intro", number: "1" }),
  "# Introduction",
  "",
  "The mass obeys Eq. [ref: eq-mass | (5)] and Algorithm [ref: alg-sort]; see [cite: bok1934; belokurov | Bok 1934; Belokurov 2006].",
  "",
  marker("argelander-block", { id: "eq-mass", number: "5", label: "mass" }),
  "$$",
  "M = \\int \\rho \\, dV",
  "",
  "  + \\epsilon",
  "$$",
  "",
  marker("argelander-block", {
    id: "alg-sort",
    kind: "algorithm",
    number: "1",
    label: "Algorithm 1",
    caption: "Sort by $O(n \\log n)$ keys, after [cite: bok1934].",
  }),
  fence,
  "for i in 1..n:\n\tswap(a[i], a[j])  ",
  "",
  "  keep    spacing $x$ [cite: not-a-token]",
  fence,
  "",
  `${fence}python`,
  "print('plain code')",
  fence,
  "",
  "## Method",
  "",
  "- first $a$ item",
  "- second [ref: intro] item",
  "",
  marker("argelander-references", [
    {
      id: "bok1934",
      raw: "Bok, B. J. 1934, The Milky Way",
      authors: ["Bok"],
      year: 1934,
      title: "The Milky Way",
    },
    {
      id: "belokurov",
      raw: "Belokurov, V. et al. 2006, ApJ 642, L137",
      authors: ["Belokurov"],
      year: 2006,
      doi: "10.1086/505095",
    },
  ]),
].join("\n");

describe("argelander-text v1 scientific content (ticket 26)", () => {
  describe("the complete fixture", () => {
    const result = parse(FULL);
    const ir = result.ir;

    it("is accepted with no diagnostic and is a valid TextDocIr", () => {
      expect(result.diagnostics).toEqual([]);
      expect(ir).not.toBeNull();
      expect(TextDocIrSchema.parse(ir)).toEqual(ir);
      expect(ir?.source.source_fingerprint).toBe(textSourceFingerprint(FULL));
    });

    it("takes identity from the document block and keeps authors, details and affiliations", () => {
      expect(ir?.title).toBe("On Dark Matter");
      expect(ir?.meta).toEqual({
        title: "On Dark Matter",
        authors: ["Ada Lovelace", "Alan Turing"],
        authorDetails: [{ name: "Ada Lovelace", affiliations: [1], email: "ada@example.org" }],
        affiliations: ["Analytical Engine Lab"],
      });
    });

    it("builds the preface and the heading tree; the printed section number is only what the block gave", () => {
      const [preface, intro] = ir?.sections ?? [];
      expect(preface).toMatchObject({ id: "sec-preface", blocks: [{ id: "p-1" }] });
      expect(preface?.blocks[0]).toEqual({
        id: "p-1",
        type: "paragraph",
        segments: [
          { type: "text", text: "Front matter before any heading, with " },
          { type: "math", latex: "E=mc^2" },
          { type: "text", text: " inline." },
        ],
      });
      expect(intro).toMatchObject({ id: "intro", number: "1", heading: "Introduction", level: 1 });
      expect(intro?.children[0]).toMatchObject({ id: "sec-2", heading: "Method" });
      expect(intro?.children[0]?.number).toBeUndefined();
    });

    it("display equation keeps its exact source, number and label, independent of its id", () => {
      const eq = blocksOf(FULL).find((b) => b.type === "equation");
      expect(eq).toEqual({
        id: "eq-mass",
        type: "equation",
        number: "5",
        label: "mass",
        latex: "M = \\int \\rho \\, dV\n\n  + \\epsilon",
      });
    });

    it("code and algorithm bodies are preserved byte for byte (tabs, trailing blanks, math and token look-alikes)", () => {
      const blocks = blocksOf(FULL);
      const alg = blocks.find((b) => b.type === "algorithm");
      expect(alg).toMatchObject({
        id: "alg-sort",
        number: "1",
        label: "Algorithm 1",
        body: "for i in 1..n:\n\tswap(a[i], a[j])  \n\n  keep    spacing $x$ [cite: not-a-token]",
      });
      expect(alg && "lang" in alg).toBe(false);
      const code = blocks.find((b) => b.type === "code");
      expect(code).toMatchObject({ id: "code-1", lang: "python", body: "print('plain code')" });
    });

    it("the caption is segmented like body text: math and a citation", () => {
      const alg = blocksOf(FULL).find((b) => b.type === "algorithm");
      expect(alg?.type === "algorithm" && alg.captionSegments).toEqual([
        { type: "text", text: "Sort by " },
        { type: "math", latex: "O(n \\log n)" },
        { type: "text", text: " keys, after " },
        {
          type: "cite",
          refs: [{ id: "bok1934", resolved: true, short: "Bok 1934", title: "The Milky Way" }],
        },
        { type: "text", text: "." },
      ]);
    });

    it("cross-references and citations resolve in two passes (a forward reference works)", () => {
      const para = blocksOf(FULL).find((b) => b.id === "p-2");
      expect(para?.type === "paragraph" && para.segments).toEqual([
        { type: "text", text: "The mass obeys Eq. " },
        {
          type: "xref",
          target: {
            id: "eq-mass",
            resolved: true,
            targetType: "equation",
            number: "5",
            preview: "M = \\int \\rho \\, dV + \\epsilon",
          },
          raw: "(5)",
        },
        { type: "text", text: " and Algorithm " },
        {
          type: "xref",
          target: {
            id: "alg-sort",
            resolved: true,
            targetType: "algorithm",
            number: "1",
            preview: "Sort by $O(n \\log n)$ keys, after .",
          },
        },
        { type: "text", text: "; see " },
        {
          type: "cite",
          refs: [
            { id: "bok1934", resolved: true, short: "Bok 1934", title: "The Milky Way" },
            { id: "belokurov", resolved: true, short: "Belokurov 2006" },
          ],
          raw: "Bok 1934; Belokurov 2006",
        },
        { type: "text", text: "." },
      ]);
      const item = blocksOf(FULL).find((b) => b.type === "list");
      expect(item?.type === "list" && item.items[1]?.segments[1]).toMatchObject({
        type: "xref",
        target: {
          id: "intro",
          resolved: true,
          targetType: "section",
          number: "1",
          heading: "Introduction",
        },
      });
    });

    it("references, bib manifest, manifests and citationsByBlock are complete", () => {
      expect(ir?.references?.map((r) => r.id)).toEqual(["bok1934", "belokurov"]);
      expect(ir?.references?.[1]?.doi).toBe("10.1086/505095");
      expect(ir?.bib.map((b) => [b.id, b.short])).toEqual([
        ["bok1934", "Bok 1934"],
        ["belokurov", "Belokurov 2006"],
      ]);
      expect(ir?.citationsByBlock).toEqual({
        "p-2": ["bok1934", "belokurov"],
        "alg-sort": ["bok1934"],
      });
      const rows = Object.fromEntries((ir?.refsManifest ?? []).map((r) => [r.id, r]));
      expect(rows["eq-mass"]).toMatchObject({
        kind: "equation",
        number: "5",
        section: "1:Introduction",
      });
      expect(rows["alg-sort"]).toMatchObject({ kind: "algorithm", number: "1" });
      expect(rows.intro).toMatchObject({ kind: "section", number: "1", content: "Introduction" });
    });

    it("stats count the scientific content", () => {
      expect(result.stats).toEqual({
        sections: 2,
        paragraphs: 2,
        lists: 1,
        equations: 1,
        codeBlocks: 2,
        inlineMath: 3,
        citations: 2,
        crossRefs: 3,
        references: 2,
      });
    });

    it("is deterministic, and a changed byte changes the fingerprint but not unrelated ids", () => {
      expect(parse(FULL).ir).toEqual(ir);
      const changed = parse(FULL.replace("print('plain code')", "print('plain code!')"));
      expect(changed.ir?.source.source_fingerprint).not.toBe(ir?.source.source_fingerprint);
      expect(changed.ir?.sections).not.toEqual(ir?.sections);
      expect(changed.ir?.references).toEqual(ir?.references);
    });
  });

  describe("tokens are only recognized in ordinary inline text (A24)", () => {
    it("currency, escaped dollars, code spans, fences and URLs never become math", () => {
      const md = [
        "It costs $100 to $200, or \\$5 and \\$6. Run `a $x$ b` and see https://example.org/a$b$c now.",
        "",
        `${fence}\n$x$ and [cite: a] and [ref: b] and $$y$$\n${fence}`,
      ].join("\n");
      const r = parse(md);
      expect(r.diagnostics).toEqual([]);
      const [para, code] = blocksOf(md);
      expect(para?.type === "paragraph" && para.segments).toEqual([
        {
          type: "text",
          text: "It costs $100 to $200, or $5 and $6. Run a $x$ b and see https://example.org/a$b$c now.",
        },
      ]);
      expect(code).toMatchObject({
        type: "code",
        body: "$x$ and [cite: a] and [ref: b] and $$y$$",
      });
    });

    it("an escaped dollar never opens or closes math, even where the boundary rules alone would allow it", () => {
      const md = "Pay \\$a and \\$b, then $c$.\n";
      expect(parse(md).diagnostics).toEqual([]);
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments).toEqual([
        { type: "text", text: "Pay $a and $b, then " },
        { type: "math", latex: "c" },
        { type: "text", text: "." },
      ]);
    });

    it("code bodies keep leading and trailing whitespace, blank lines, tabs and look-alikes exactly", () => {
      const body =
        "  two leading spaces\n\n\ttab then text   \n[ref: x] $y$ <b>&amp;</b>\ntrailing   ";
      const md = `${fence}\n${body}\n${fence}\n`;
      const block = blocksOf(md)[0];
      expect(block).toMatchObject({ type: "code", body });
    });

    it("algorithm bodies keep their whitespace exactly too", () => {
      const body = "  lead\n\n\tstep   \ntrail   ";
      const md = `${marker("argelander-block", { kind: "algorithm" })}${fence}\n${body}\n${fence}\n`;
      expect(parse(md).diagnostics).toEqual([]);
      expect(blocksOf(md)[0]).toMatchObject({ type: "algorithm", body });
    });

    it("emphasis characters, braces, pipes and backslashes inside math are kept exactly", () => {
      const md = "A $a *b* c$, $\\{x\\}|y|$ and $a_1 \\star b^{2}$ end.\n";
      expect(parse(md).diagnostics).toEqual([]);
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments).toEqual([
        { type: "text", text: "A " },
        { type: "math", latex: "a *b* c" },
        { type: "text", text: ", " },
        { type: "math", latex: "\\{x\\}|y|" },
        { type: "text", text: " and " },
        { type: "math", latex: "a_1 \\star b^{2}" },
        { type: "text", text: " end." },
      ]);
    });

    it("an escaped [cite: is literal text; token escapes resolve to the literal characters", () => {
      const md = [marker("argelander-references", [{ id: "a", raw: "A" }])].join("");
      const full = `Literal \\[cite: a] stays. See [cite: a | x \\| y \\] z \\\\ w] done.\n\n${md}`;
      const para = blocksOf(full)[0];
      expect(para?.type === "paragraph" && para.segments).toEqual([
        { type: "text", text: "Literal [cite: a] stays. See " },
        { type: "cite", refs: [{ id: "a", resolved: true, short: "A" }], raw: "x | y ] z \\ w" },
        { type: "text", text: " done." },
      ]);
    });

    it("a token may wrap over a soft line break but not a blank line", () => {
      const ok = blocksOf("See [cite: a |\nsplit over\nlines] now.\n");
      expect(ok[0]?.type === "paragraph" && ok[0].segments[1]).toMatchObject({
        raw: "split over lines",
      });
      expect(codes("See [cite: a | broken\n\nnext paragraph]\n")).toEqual([
        ["cite_unclosed", "error", 1, 5],
      ]);
    });

    it("a formula can contain what looks like a token; a token's display text keeps a literal $", () => {
      const md = "Math $a[cite: x]b$ and [ref: eq-1 | cost $5 and $6].\n";
      const r = parse(md);
      expect(r.diagnostics.map((d) => d.code)).toEqual(["ref_unresolved"]);
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments[1]).toEqual({
        type: "math",
        latex: "a[cite: x]b",
      });
      expect(para?.type === "paragraph" && para.segments[3]).toMatchObject({
        raw: "cost $5 and $6",
      });
    });
  });

  describe("math diagnostics", () => {
    it("a display equation in the middle of text becomes its own block (see text-display-math.test.ts)", () => {
      expect(codes("# T\n\nWe have $$x$$ here.\n")).toEqual([]);
    });
    it("an unclosed $$ and an empty $$ are located errors", () => {
      expect(codes("# T\n\nText\n\n$$\nx = 1\n")).toEqual([["math_unclosed", "error", 5, 1]]);
      expect(codes("# T\n\n$$ $$\n")).toEqual([["math_empty", "error", 3, 1]]);
    });
    it("a formula KaTeX cannot typeset is kept as written with a located warning (no false 'correct')", () => {
      const md = "# T\n\nBad $\\notacommand{x}$ here.\n";
      const r = parse(md);
      expect(r.ir).not.toBeNull();
      expect(r.diagnostics).toMatchObject([
        { code: "math_katex", severity: "warning", line: 3, column: 5 },
      ]);
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments[1]).toEqual({
        type: "math",
        latex: "\\notacommand{x}",
      });
    });
    it("a formula that tries active content is kept as source and reported: the Reader paints it red and drops the content", () => {
      const r = parse("# T\n\nX $\\href{javascript:alert(1)}{x}$ y.\n");
      expect(r.ir).not.toBeNull();
      expect(r.diagnostics).toMatchObject([
        { code: "math_katex", severity: "warning", line: 3, column: 3 },
      ]);
      const para = blocksOf("# T\n\nX $\\href{javascript:alert(1)}{x}$ y.\n")[0];
      expect(para?.type === "paragraph" && para.segments[1]).toEqual({
        type: "math",
        latex: "\\href{javascript:alert(1)}{x}",
      });
    });
    it("a heading may contain inline math (kept as $..$ for the heading display); cite and ref cannot", () => {
      const ok = parse("# Mass $M_\\odot$ scale\n\nbody\n");
      expect(ok.ir?.sections[0]?.heading).toBe("Mass $M_\\odot$ scale");
      expect(codes("# See [ref: a]\n\nbody\n")).toContainEqual([
        "heading_token_unsupported",
        "error",
        1,
        7,
      ]);
    });
    it("a list item may hold math, cite and ref", () => {
      const md = "- $x$ and [ref: x1]\n";
      expect(parse(md).ir).not.toBeNull();
    });
  });

  describe("block metadata", () => {
    it("binds only to the next block, and only the fields that block has", () => {
      expect(codes(`${marker("argelander-block", { id: "a" })}`)).toContainEqual([
        "block_meta_dangling",
        "error",
        1,
        1,
      ]);
      expect(
        codes(
          `${marker("argelander-block", { id: "a" })}${marker("argelander-block", { id: "b" })}para\n`
        )
      ).toContainEqual(["block_meta_adjacent", "error", 6, 1]);
      expect(
        codes(`${marker("argelander-block", { number: "3" })}plain paragraph\n`)
      ).toContainEqual(["block_meta_field", "error", 3, 3]);
      expect(codes(`${marker("argelander-block", { footnote: "x" })}$$x$$\n`)).toContainEqual([
        "block_meta_field",
        "error",
        3,
        3,
      ]);
      expect(
        codes(`${marker("argelander-block", { kind: "algorithm" })}# Heading\n`)
      ).toContainEqual(["block_meta_kind", "error", 3, 3]);
    });
    it("cannot bind to the references block or to a block that is not supported", () => {
      const md = `${marker("argelander-block", { id: "x" })}${marker("argelander-references", [{ id: "a", raw: "A" }])}`;
      expect(codes(md).map((c) => c[0])).toContain("block_meta_target");
      expect(codes(`${marker("argelander-block", { id: "x" })}> quote\n`).map((c) => c[0])).toEqual(
        ["quote_unsupported"]
      );
    });
    it("unknown fields, wrong types and bad JSON are located at the field / the character", () => {
      const unknown = parse(
        `${marker("argelander-block", '{\n  "id": "a",\n  "colour": "red"\n}')}para\n`
      );
      expect(unknown.diagnostics).toMatchObject([
        {
          code: "block_meta_unknown_field",
          line: 4,
          column: 3,
          field: "colour",
          subject: "colour",
        },
      ]);
      const wrongType = parse(`${marker("argelander-block", '{\n  "id": 5\n}')}para\n`);
      expect(wrongType.diagnostics).toMatchObject([
        { code: "block_meta_invalid", line: 3, column: 3, field: "id" },
      ]);
      const bad = parse(`${marker("argelander-block", '{\n  "id": "a",\n}')}para\n`);
      expect(bad.diagnostics).toMatchObject([{ code: "block_meta_json", line: 4, column: 1 }]);
      const dup = parse(`${marker("argelander-block", '{"id":"a","id":"b"}')}para\n`);
      expect(dup.diagnostics[0]).toMatchObject({ code: "block_meta_json", line: 2, column: 11 });
      expect(
        parse(`${marker("argelander-block", '{"id":"has space"}')}para\n`).diagnostics[0]
      ).toMatchObject({
        code: "block_meta_invalid",
        field: "id",
      });
    });
    it("an unknown argelander-* fence is an error, not code", () => {
      expect(codes(`${fence}argelander-bloc\n{}\n${fence}\n`)).toEqual([
        ["fence_unknown_marker", "error", 1, 1],
      ]);
    });
    it("a marker block that is never closed is reported, not swallowed to the end of the text", () => {
      expect(
        codes(`${fence}argelander-block\n{"id":"a"}\n\nparagraph that would vanish\n`)
      ).toEqual([["fence_unclosed", "error", 1, 1]]);
      expect(codes(`${fence}python\nnever closed\n`)).toEqual([["fence_unclosed", "error", 1, 1]]);
    });
  });

  describe("ids and display numbers", () => {
    it("explicit ids are unique across headings and blocks; the duplicate is located and names the first line", () => {
      const md = [
        marker("argelander-block", { id: "dup" }),
        "# One",
        "",
        marker("argelander-block", { id: "dup" }),
        "$$x$$",
        "",
      ].join("\n");
      const diag = parse(md).diagnostics.find((d) => d.code === "id_duplicate");
      expect(diag).toMatchObject({ line: 11, column: 3, subject: "dup" });
      expect(diag?.message).toMatch(/line 3/);
    });
    it("sec-preface is reserved", () => {
      expect(
        codes(`${marker("argelander-block", { id: "sec-preface" })}# H\n`).map((c) => c[0])
      ).toEqual(["id_reserved"]);
    });
    it("implicit ids follow reading order, are deterministic, and step around explicit ones", () => {
      const md = [
        "# A",
        "",
        "para",
        "",
        marker("argelander-block", { id: "p-2" }),
        "second",
        "",
        "third",
        "",
        "$$a$$",
        "",
        `${fence}\ncode\n${fence}`,
        "",
        "## B",
        "",
      ].join("\n");
      const ir = parse(md).ir;
      expect(parse(md).diagnostics).toEqual([]);
      expect(blocksOf(md).map((b) => b.id)).toEqual(["p-1", "p-2", "p-3", "eq-1", "code-1"]);
      // the implicit third paragraph is the third paragraph (p-3), and the explicit p-2 is not reused
      expect(ir?.sections[0]?.children[0]?.id).toBe("sec-2");
      const bump = [marker("argelander-block", { id: "p-1" }), "x", "", "y", ""].join("\n");
      expect(blocksOf(bump).map((b) => b.id)).toEqual(["p-1", "p-2"]);
      const clash = [marker("argelander-block", { id: "p-2" }), "x", "", "y", ""].join("\n");
      // first paragraph explicit p-2; second implicit would be p-2 -> steps to p-2-1
      expect(blocksOf(clash).map((b) => b.id)).toEqual(["p-2", "p-2-1"]);
    });
    it("a printed number is independent of the id: eq-5 can be numbered 12 or have no number", () => {
      const md = [
        marker("argelander-block", { id: "eq-5", number: "12" }),
        "$$a$$",
        "",
        "$$b$$",
        "",
        "See [ref: eq-5] and [ref: eq-2].",
        "",
      ].join("\n");
      const blocks = blocksOf(md);
      expect(blocks[0]).toMatchObject({ id: "eq-5", number: "12" });
      expect(blocks[1]).toMatchObject({ id: "eq-2" });
      expect(blocks[1] && "number" in blocks[1]).toBe(false);
      const para = blocks[2];
      expect(para?.type === "paragraph" && para.segments).toMatchObject([
        { type: "text" },
        { type: "xref", target: { id: "eq-5", number: "12" } },
        { type: "text" },
        { type: "xref", target: { id: "eq-2", resolved: true } },
        { type: "text" },
      ]);
      const second = para?.type === "paragraph" ? para.segments[3] : undefined;
      expect(second?.type === "xref" && second.target.number).toBeUndefined();
    });
    it("a heading without an explicit number is not given one from its level", () => {
      expect(parse("# A\n\n## B\n").ir?.sections[0]?.number).toBeUndefined();
      expect(parse("# A\n\n## B\n").ir?.sections[0]?.children[0]?.number).toBeUndefined();
    });
    it("heading levels nest correctly even when a level is skipped", () => {
      const ir = parse("# A\n\n### C\n\n## B\n\n# D\n").ir;
      expect(ir?.sections.map((s) => s.heading)).toEqual(["A", "D"]);
      expect(ir?.sections[0]?.children.map((s) => [s.heading, s.level])).toEqual([
        ["C", 3],
        ["B", 2],
      ]);
    });
  });

  describe("cite and ref resolution", () => {
    it("an unresolved cite or ref keeps its display text, is marked unresolved and warns; nothing is invented", () => {
      const md = "See [cite: ghost | Ghost 1999] and [ref: nothing | Fig. 9] and [cite: z].\n";
      const r = parse(md);
      expect(r.ir).not.toBeNull();
      expect(r.diagnostics.map((d) => [d.code, d.severity, d.subject, d.column])).toEqual([
        ["cite_unresolved", "warning", "ghost", 5],
        ["ref_unresolved", "warning", "nothing", 36],
        ["cite_unresolved", "warning", "z", 64],
      ]);
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments).toEqual([
        { type: "text", text: "See " },
        { type: "cite", refs: [{ id: "ghost", resolved: false }], raw: "Ghost 1999" },
        { type: "text", text: " and " },
        { type: "xref", target: { id: "nothing", resolved: false }, raw: "Fig. 9" },
        { type: "text", text: " and " },
        { type: "cite", refs: [{ id: "z", resolved: false }] },
        { type: "text", text: "." },
      ]);
      expect(r.ir?.references).toBeUndefined();
      expect(r.ir?.bib).toEqual([]);
      expect(r.ir?.citationsByBlock).toEqual({});
      expect(r.stats.unresolved).toBe(3);
    });
    it("a ref to a paragraph or list id is an error (only sections, equations, code, algorithms can be referenced)", () => {
      const md = `${marker("argelander-block", { id: "para" })}Text.\n\nSee [ref: para].\n`;
      expect(codes(md)).toEqual([["ref_target_unsupported", "error", 8, 5]]);
    });
    it("malformed tokens are located syntax errors", () => {
      expect(codes("a [cite: bad id!] b\n")).toEqual([["cite_syntax", "error", 1, 3]]);
      expect(codes("a [cite: ] b\n")).toEqual([["cite_syntax", "error", 1, 3]]);
      expect(codes("a [ref: a;b] b\n")).toEqual([["ref_syntax", "error", 1, 3]]);
      expect(codes("a [ref: a | ] b\n")).toEqual([["ref_syntax", "error", 1, 3]]);
      expect(codes("a [ref: a never closed\n")).toEqual([["ref_unclosed", "error", 1, 3]]);
    });
    it("a repeated id in one cite is kept in order; citationsByBlock is de-duplicated", () => {
      const md = `See [cite: a;a;b].\n\n${marker("argelander-references", [
        { id: "a", raw: "A" },
        { id: "b", raw: "B" },
      ])}`;
      const r = parse(md);
      expect(r.ir?.citationsByBlock).toEqual({ "p-1": ["a", "b"] });
      const para = blocksOf(md)[0];
      expect(para?.type === "paragraph" && para.segments[1]).toMatchObject({
        refs: [{ id: "a" }, { id: "a" }, { id: "b" }],
      });
    });
  });

  describe("references block", () => {
    const refs = (items: unknown) => marker("argelander-references", items);
    it("must be last, single, unique ids, id and raw required, existing fields only, web urls only", () => {
      expect(codes(`${refs([{ id: "a", raw: "A" }])}\nafter\n`)).toEqual([
        ["references_not_last", "error", 1, 1],
      ]);
      expect(codes(`${refs([{ id: "a", raw: "A" }])}\n${refs([{ id: "b", raw: "B" }])}`)).toEqual([
        ["references_not_last", "error", 1, 1],
        ["references_duplicate", "error", 10, 1],
      ]);
      expect(
        codes(
          `x\n\n${refs([
            { id: "a", raw: "A" },
            { id: "a", raw: "B" },
          ])}`
        )
      ).toEqual([["reference_id_duplicate", "error", 10, 5]]);
      expect(parse(`x\n\n${refs([{ id: "a" }])}`).diagnostics).toMatchObject([
        { code: "references_invalid", field: "[0].raw" },
      ]);
      expect(parse(`x\n\n${refs([{ id: "a", raw: "A", colour: 1 }])}`).diagnostics).toMatchObject([
        { code: "references_unknown_field", field: "[0].colour", subject: "colour" },
      ]);
      expect(parse(`x\n\n${refs({ id: "a" })}`).diagnostics[0]?.code).toBe("references_invalid");
      expect(
        parse(`x\n\n${refs([{ id: "a", raw: "A", url: "javascript:alert(1)" }])}`).diagnostics
      ).toMatchObject([{ code: "references_invalid", field: "[0].url" }]);
    });
    it("a second references block that is last still reports the first", () => {
      const md = `${refs([{ id: "a", raw: "A" }])}\n${refs([{ id: "b", raw: "B" }])}`;
      expect(parse(md).ir).toBeNull();
    });
    it("every field of a reference is kept verbatim (full raw text included)", () => {
      const full = {
        id: "r1",
        raw: "Raw entry, with | pipes ] and [brackets] and $math$ kept whole.",
        label: "12",
        authors: ["A. One", "B. Two"],
        year: 2001,
        title: "T",
        venue: "V",
        volume: "3",
        pages: "1-9",
        doi: "10.1/x",
        arxiv_id: "2101.00001",
        url: "https://example.org/p",
        keys: ["one2001"],
      };
      const r = parse(`x\n\n${refs([full])}`);
      expect(r.diagnostics).toEqual([]);
      expect(r.ir?.references).toEqual([full]);
    });
    it("a document with only a references block and a heading is fine", () => {
      expect(parse(`# T\n\n${refs([])}`).diagnostics).toEqual([]);
    });
  });

  describe("document block", () => {
    const doc = (json: unknown) => marker("argelander-document", json);
    it("must be the first thing, once; defaults apply without it", () => {
      expect(codes(`# T\n\n${doc({ version: 1 })}`)).toContainEqual([
        "document_meta_position",
        "error",
        3,
        1,
      ]);
      expect(codes(`${doc({ version: 1 })}${doc({ version: 1 })}x\n`)).toContainEqual([
        "document_meta_duplicate",
        "error",
        6,
        1,
      ]);
      expect(parse("# Only a heading\n").ir?.title).toBe("Only a heading");
    });
    it("validates fields with their paths; version is required", () => {
      expect(parse(`${doc({ title: "T" })}x\n`).diagnostics).toMatchObject([
        { code: "document_meta_invalid", field: "version" },
      ]);
      expect(parse(`${doc({ version: 2 })}x\n`).diagnostics[0]?.code).toBe("document_meta_invalid");
      expect(parse(`${doc({ version: 1, docId: "text-evil" })}x\n`).diagnostics).toMatchObject([
        { code: "document_meta_unknown_field", field: "docId" },
      ]);
      expect(parse(`${doc({ version: 1, authors: ["ok", ""] })}x\n`).diagnostics).toMatchObject([
        { code: "document_meta_invalid", field: "authors[1]" },
      ]);
      expect(
        parse(
          `${doc({ version: 1, affiliations: ["A"], authorDetails: [{ name: "n", affiliations: [2] }] })}x\n`
        ).diagnostics
      ).toMatchObject([
        { code: "document_meta_invalid", field: "authorDetails[0].affiliations[0]" },
      ]);
    });
    it("the metadata title wins over the first heading; the block is not reading text", () => {
      const r = parse(`${doc({ version: 1, title: "Meta" })}# Heading\n\nbody\n`);
      expect(r.ir?.title).toBe("Meta");
      expect(r.ir?.sections.map((s) => s.heading)).toEqual(["Heading"]);
      expect(JSON.stringify(r.ir?.sections)).not.toContain("version");
    });
    it("the text cannot choose its own docId or engine", () => {
      const ir = parse(`${doc({ version: 1, title: "T" })}x\n`).ir;
      expect(ir?.docId).toBe("text-1");
      expect(ir?.meta).toEqual({ title: "T" });
    });
  });

  describe("safe display", () => {
    it("raw HTML, scripts and explicit links are refused; their text never reaches the IR", () => {
      for (const md of [
        "x <script>alert(1)</script>\n",
        "<img src=x onerror=alert(1)>\n",
        "[a](javascript:alert(1))\n",
        "![a](data:text/html;base64,AAAA)\n",
      ]) {
        const r = parse(md);
        expect(r.ir).toBeNull();
        expect(r.diagnostics.length).toBeGreaterThan(0);
      }
    });
    it("markup-looking text in a caption, a reference or a code body stays inert text", () => {
      const md = [
        marker("argelander-block", { caption: "<img src=x onerror=alert(1)> **b**" }),
        `${fence}html\n<script>alert(1)</script>\n${fence}`,
        "",
        marker("argelander-references", [{ id: "a", raw: "<b onclick=x>raw</b>" }]),
      ].join("\n");
      const r = parse(md);
      expect(r.diagnostics).toEqual([]);
      const code = blocksOf(md)[0];
      expect(code).toMatchObject({ type: "code", lang: "html", body: "<script>alert(1)</script>" });
      expect(code?.type === "code" && code.captionSegments).toEqual([
        { type: "text", text: "<img src=x onerror=alert(1)> **b**" },
      ]);
    });
  });

  describe("the old limits stay: no silent loss", () => {
    it("figures, tables, images and footnotes are located refusals, not dropped content", () => {
      expect(codes("![fig](assets/a.png)\n").map((c) => c[0])).toEqual(["image_unsupported"]);
      expect(codes("| a | b |\n|---|---|\n| 1 | 2 |\n").map((c) => c[0])).toEqual([
        "table_unsupported",
      ]);
      expect(codes(`${fence}\nx\n${fence}\n\n    indented\n`).map((c) => c[0])).toEqual([
        "code_indented",
      ]);
    });
    it("an info string beyond the language is kept out of the body and reported; an algorithm drops its lang with a warning", () => {
      const r = parse(`${fence}python title=x\nx\n${fence}\n`);
      expect(r.ir).not.toBeNull();
      expect(r.diagnostics).toMatchObject([
        { code: "code_info_ignored", severity: "warning", subject: "title=x" },
      ]);
      const alg = parse(
        `${marker("argelander-block", { kind: "algorithm" })}${fence}python\nx\n${fence}\n`
      );
      expect(alg.diagnostics).toMatchObject([
        { code: "algorithm_lang_ignored", severity: "warning" },
      ]);
    });
    it("reserved private-use characters are refused where they are", () => {
      expect(codes("a \uE001 b\n")).toEqual([["reserved_character", "error", 1, 3]]);
    });
  });

  describe("bounded work", () => {
    it("40 000 inline formulas parse quickly; only the first 3000 are typeset-checked, and that is said", () => {
      const md = `# T\n\n${"Costs $x$ here and there.\n\n".repeat(40000)}`;
      const started = performance.now();
      const r = parse(md);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(r.ir).not.toBeNull();
      // the first formula past the budget is located; the rest are counted in one summary
      expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["math_not_checked", "warning"],
        ["math_not_checked", "warning"],
      ]);
      const located = r.diagnostics.find((d) => d.line !== undefined);
      expect(located?.subject).toBe("budget");
      // 3000 checks at most (fewer when the time budget ends the pass sooner)
      expect(
        Number(r.diagnostics.find((d) => d.line === undefined)?.subject)
      ).toBeGreaterThanOrEqual(37000);
      expect(located?.line).toBeGreaterThan(2);
      expect(r.stats.inlineMath).toBe(40000);
    });
    it("thousands of warnings are capped, summarized as a warning, and do not block the document", () => {
      const md = `# T\n\n${"See [cite: nope].\n\n".repeat(5000)}`;
      const r = parse(md);
      expect(r.ir).not.toBeNull();
      expect(r.diagnostics.length).toBe(201);
      expect(r.diagnostics.at(-1)).toMatchObject({
        code: "too_many_diagnostics",
        severity: "warning",
        count: 4800,
      });
    });
    it("a long run of unclosed tokens in one paragraph is linear", () => {
      const md = `# T\n\n${"[cite: a ".repeat(60000)}\n`;
      const started = performance.now();
      const r = parse(md);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(r.ir).toBeNull();
      expect(r.diagnostics.at(-1)?.code).toBe("too_many_diagnostics");
    });
    it("many display equations and many cites in a 1 MB source are linear", () => {
      const refsBlock = marker("argelander-references", [{ id: "a", raw: "A" }]);
      const md = `# T\n\n${"$$x^2$$\n\nSee [cite: a] and [ref: sec-1].\n\n".repeat(15000)}${refsBlock}`;
      const started = performance.now();
      const r = parse(md);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(r.ir).not.toBeNull();
      expect(r.stats.equations).toBe(15000);
    });
  });
});
