import type { IrBlock, IrSection, IrSegment } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { parseTextSource } from "../src/documents/text-codec.js";

const opts = { docId: "text-1", sourceRev: 1 };
const F = "```";
const parse = (md: string) => parseTextSource(md, opts);
const codes = (md: string) =>
  parse(md).diagnostics.map((d) => [d.code, d.severity, d.line, d.column]);
function blocks(md: string): IrBlock[] {
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
/** A compact view of reading order: paragraph text, eq:latex, list:items. */
function shape(md: string): string[] {
  return blocks(md).map((b) => {
    if (b.type === "equation") return `eq:${b.latex}`;
    if (b.type === "list") return `${b.ordered ? "ol" : "ul"}:${b.items.map(itemText).join("|")}`;
    if (b.type === "paragraph") return `p:${itemText(b)}`;
    return b.type;
  });
}
const itemText = (x: { segments: IrSegment[] } | { type: string; segments?: IrSegment[] }) =>
  (x.segments ?? [])
    .map((s) => (s.type === "text" ? s.text : s.type === "math" ? `$${s.latex}$` : `<${s.type}>`))
    .join("");
const marker = (name: string, json: unknown) => `${F}${name}\n${JSON.stringify(json)}\n${F}\n`;

describe("U1: $$...$$ display math anywhere, indented too", () => {
  it("in the middle of a sentence it ends the paragraph and starts a new one, in source order", () => {
    expect(shape("We have $$x^2$$ here.\n")).toEqual(["p:We have", "eq:x^2", "p:here."]);
    expect(codes("We have $$x^2$$ here.\n")).toEqual([]);
  });
  it("next to text on either side, without spaces, and at the start or the end of a paragraph", () => {
    expect(shape("a$$x$$b\n")).toEqual(["p:a", "eq:x", "p:b"]);
    expect(shape("$$x$$ tail\n")).toEqual(["eq:x", "p:tail"]);
    expect(shape("head $$x$$\n")).toEqual(["p:head", "eq:x"]);
  });
  it("two in one line, and several in one paragraph", () => {
    expect(shape("$$a$$ and $$b$$\n")).toEqual(["eq:a", "p:and", "eq:b"]);
    expect(shape("one $$a$$ two $$b$$ three\n")).toEqual([
      "p:one",
      "eq:a",
      "p:two",
      "eq:b",
      "p:three",
    ]);
  });
  it("alone on its lines with any indentation (including 4+ spaces and a tab) is an equation, not code", () => {
    expect(shape("   $$x$$\n")).toEqual(["eq:x"]);
    expect(shape("        $$y$$\n")).toEqual(["eq:y"]);
    expect(shape("\t$$z$$\n")).toEqual(["eq:z"]);
    expect(codes("        $$y$$\n")).toEqual([]);
  });
  it("a multi-line formula (blank line inside) that starts in the middle of a line", () => {
    expect(shape("text $$\nx\n\ny\n$$ more\n")).toEqual(["p:text", "eq:x\n\ny", "p:more"]);
  });
  it("implicit ids follow reading order; a pending block metadata binds the first block that comes out", () => {
    const md = `${marker("argelander-block", { id: "first" })}We have $$x$$ here.\n`;
    expect(blocks(md).map((b) => b.id)).toEqual(["first", "eq-1", "p-2"]);
    const eqFirst = `${marker("argelander-block", { id: "e", number: "1" })}$$x$$ tail\n`;
    expect(blocks(eqFirst)[0]).toMatchObject({ id: "e", type: "equation", number: "1" });
  });
  it("an inline formula next to a display one in a paragraph stays inline", () => {
    expect(shape("see $a$ then $$b$$ and $c$.\n")).toEqual([
      "p:see $a$ then",
      "eq:b",
      "p:and $c$.",
    ]);
  });
  it("is refused where it cannot keep its place: in a heading, in a list item, in a token", () => {
    expect(codes("# Title $$x$$ more\n")).toEqual([["math_display_in_heading", "error", 1, 9]]);
    expect(codes("- a $$x$$ b\n")).toEqual([["math_display_in_list", "error", 1, 5]]);
    expect(codes("See [cite: a | $$x$$] now.\n").map((c) => c[0])).toEqual(["cite_syntax"]);
  });
});

describe("B2: a display equation between list items keeps its place", () => {
  it("splits an unordered list around it", () => {
    expect(shape("- a\n\n$$\nx\n$$\n\n- b\n")).toEqual(["ul:a", "eq:x", "ul:b"]);
    expect(shape("- a\n- b\n\n$$x$$\n\n- c\n- d\n")).toEqual(["ul:a|b", "eq:x", "ul:c|d"]);
    expect(shape("- a\n$$x$$\n- b\n")).toEqual(["ul:a", "eq:x", "ul:b"]);
  });
  it("two equations between items, and one after the last item", () => {
    expect(shape("- a\n\n$$x$$\n\n$$y$$\n\n- b\n\n$$z$$\n")).toEqual([
      "ul:a",
      "eq:x",
      "eq:y",
      "ul:b",
      "eq:z",
    ]);
  });
  it("an ordered list cannot be split (the numbering would restart): a located error", () => {
    expect(codes("1. a\n\n$$\nx\n$$\n\n2. b\n")).toEqual([["math_display_in_list", "error", 3, 1]]);
    // after the whole list is fine
    expect(shape("1. a\n2. b\n\n$$x$$\n")).toEqual(["ol:a|b", "eq:x"]);
  });
  it("indented under an item with text after it is refused; as the item's last content it keeps its place", () => {
    expect(codes("- a\n  $$x$$\n  more\n- b\n").map((c) => c[0])).toContain("math_display_in_list");
    expect(shape("- a\n  $$x$$\n- b\n")).toEqual(["ul:a", "eq:x", "ul:b"]);
  });
  it("source order of every block is kept around lists", () => {
    expect(shape("intro\n\n- a\n\n$$x$$\n\n- b\n\noutro\n")).toEqual([
      "p:intro",
      "ul:a",
      "eq:x",
      "ul:b",
      "p:outro",
    ]);
  });
});

describe("B1: math never loses the text it contains", () => {
  it("backticks around the dollars: the formula is read from the source, with a located warning", () => {
    const md = "Text $a`$ and $`b$ end.\n";
    const r = parse(md);
    expect(r.diagnostics[0]).toMatchObject({
      code: "math_contains_code",
      severity: "warning",
      line: 1,
      column: 6,
    });
    const para = blocks(md)[0];
    expect(para?.type === "paragraph" && para.segments).toEqual([
      { type: "text", text: "Text " },
      { type: "math", latex: "a`$ and $`b" },
      { type: "text", text: " end." },
    ]);
  });
  it("a code span, a URL or a fence-like text inside a display formula is kept", () => {
    expect(shape("$$\n\\text{`q`} + x\n$$\n")).toEqual(["eq:\\text{`q`} + x"]);
    expect(shape("$$\\text{https://x.org/a} + y$$\n")).toEqual(["eq:\\text{https://x.org/a} + y"]);
    expect(codes("$$\n\\text{`q`} + x\n$$\n")).toEqual([["math_contains_code", "warning", 1, 1]]);
  });
  it("every source character of a paragraph with such formulas is in the output", () => {
    const md = "A $x`$ B $`y$ C `code` D $z$ E https://u.org/p?q=$1 F.\n";
    const para = blocks(md)[0];
    const flat =
      para?.type === "paragraph"
        ? para.segments
            .map((s) => (s.type === "text" ? s.text : s.type === "math" ? `$${s.latex}$` : ""))
            .join("")
        : "";
    expect(flat).toBe("A $x`$ B $`y$ C code D $z$ E https://u.org/p?q=$1 F.");
  });
});

describe("B3: fences are CommonMark fences", () => {
  it("an unclosed triple backtick in prose does not hide the rest of the document", () => {
    const md = "Use ``` in prose and $a *b* c$ here.\n\nLater $d$.\n";
    const r = parse(md);
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.inlineMath).toBe(2);
  });
  it("a fence opens only at a line start (at most 3 spaces) and closes with the same character and at least the same length", () => {
    const md = `\`\`\`\`\ninside \`\`\` three and $x$ and [cite: a]\n\`\`\`\`\n\nAfter $y$.\n`;
    const r = parse(md);
    expect(r.diagnostics).toEqual([]);
    expect(blocks(md)[0]).toMatchObject({
      type: "code",
      body: "inside ``` three and $x$ and [cite: a]",
    });
    expect(r.stats.inlineMath).toBe(1);
    // tildes do not close a backtick fence, and a shorter fence does not close a longer one
    const mixed = `${F}\nline ~~~\n~~~\n${F}\n`;
    expect(blocks(mixed)[0]).toMatchObject({ type: "code", body: "line ~~~\n~~~" });
    const longer = `~~~~\na\n~~~\nb $x$ [cite: q]\n~~~~\n\nAfter $y$.\n`;
    expect(blocks(longer)[0]).toMatchObject({ type: "code", body: "a\n~~~\nb $x$ [cite: q]" });
    expect(parse(longer).stats.inlineMath).toBe(1); // only $y$: the shorter ~~~ did not end the fence
  });
  it("a never-closed fence at a line start is reported where it starts (and it does hide the rest, like CommonMark)", () => {
    expect(codes(`para\n\n${F}\nnever closed $x$\n`)).toEqual([["fence_unclosed", "error", 3, 1]]);
  });
  it("a backtick fence whose info string has a backtick is an inline span, not a fence", () => {
    const r = parse("``` a`b\n\nand $x$\n");
    expect(r.diagnostics.map((d) => d.code)).not.toContain("fence_unclosed");
    expect(r.stats.inlineMath).toBe(1);
  });
});

describe("B5/B6: id-keyed work is linear and safe", () => {
  it("eighty thousand distinct cites in one block are linear (a Set, not an array scan)", () => {
    const n = 80_000;
    const list = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, raw: `R${i}` }));
    const refs = marker("argelander-references", list);
    const md = `${Array.from({ length: n }, (_, i) => `[cite: r${i}]`).join(" ")}\n\n${refs}`;
    // The budget is this thread's CPU time, not the wall clock: on a loaded machine (the packages' suites in parallel,
    // other agents) the wall clock of the linear parse tripled past 5 s while its CPU time stayed near 1 s; an array
    // scan instead of the Set costs about 14 s of CPU here, so the gate still catches it (shelf-followups 07).
    const started = process.threadCpuUsage();
    const r = parse(md);
    const used = process.threadCpuUsage(started);
    const cpuMs = (used.user + used.system) / 1000;
    expect(r.ir?.citationsByBlock["p-1"]?.length).toBe(n);
    expect(cpuMs).toBeLessThan(5000);
  }, 60_000);
  it("block ids that are Object.prototype names are refused with a diagnostic, never a crash", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const r = parse(`${marker("argelander-block", { id })}text\n`);
      expect(r.ir, id).toBeNull();
      expect(
        r.diagnostics.map((d) => d.code),
        id
      ).toEqual(["id_reserved"]);
    }
  });
  it("reference ids are reserved like block ids: Object.prototype names and the ann- prefix", () => {
    for (const id of ["constructor", "__proto__", "toString", "ann-1"]) {
      const refs = marker("argelander-references", [{ id, raw: "R" }]);
      const r = parse(`See [cite: ${id}].\n\n${refs}`);
      expect(r.ir, id).toBeNull();
      expect(
        r.diagnostics.find((d) => d.code === "id_reserved"),
        id
      ).toMatchObject({
        subject: id,
        field: "[0].id",
      });
    }
  });
});

describe("M2: a ] inside a URL does not make a cite swallow the next token", () => {
  it("the cite ends at the first ]; the following ref is its own token", () => {
    const md = "[cite: a | see https://x.org/a]b] and [ref: sec-1].\n";
    const para = blocks(md)[0];
    const kinds = para?.type === "paragraph" ? para.segments.map((s) => s.type) : [];
    expect(kinds).toEqual(["cite", "text", "xref", "text"]);
    expect(para?.type === "paragraph" && para.segments[1]).toMatchObject({ text: "b] and " });
  });
  it("a token start inside a URL is still not a token", () => {
    const r = parse("see https://x.org/[cite:a] now\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.citations).toBeUndefined();
  });
});

describe("M3: formulas the Reader cannot paint are reported", () => {
  it("trust-only commands warn, inline and display", () => {
    for (const latex of [
      "\\href{x}{y}",
      "\\url{x}",
      "\\includegraphics{a.png}",
      "\\htmlClass{c}{y}",
    ]) {
      expect(codes(`a $${latex}$ b\n`), latex).toEqual([
        ["math_untrusted_command", "warning", 1, 3],
      ]);
      expect(codes(`$$${latex}$$\n`), latex).toEqual([["math_untrusted_command", "warning", 1, 1]]);
    }
    expect(codes("a $x^2$ b\n")).toEqual([]);
  });
});

describe("B4: formula checking is bounded", () => {
  it("one 400 KB formula is not typeset-checked, says so where it is, and returns fast", () => {
    const md = `$$${"x+".repeat(200_000)}x$$\n`;
    const started = performance.now();
    const r = parse(md);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(r.diagnostics).toMatchObject([
      { code: "math_not_checked", severity: "warning", line: 1, column: 1, subject: "size" },
    ]);
    expect(r.ir).not.toBeNull();
  });
  it("a document of many large formulas stops checking at the budget", () => {
    const one = `$$${"y+".repeat(4000)}y$$\n\n`; // ~8 KB each, under the per-formula limit
    const md = one.repeat(200); // 1.6 MB of formulas
    const started = performance.now();
    const r = parse(md);
    expect(performance.now() - started).toBeLessThan(6000);
    expect(r.diagnostics.some((d) => d.code === "math_not_checked" && d.subject === "budget")).toBe(
      true
    );
    expect(r.ir).not.toBeNull();
  });
});

describe("N1/N3/L1/L2/L3/N2", () => {
  const refs = marker("argelander-references", [{ id: "a", raw: "A" }]);
  it("N1: a display equation after the references block means references are not last", () => {
    expect(codes(`x\n\n${refs}\n$$y$$\n`).map((c) => c[0])).toEqual(["references_not_last"]);
    expect(codes(`x\n\n${refs}\n\ntext $$y$$ more\n`).map((c) => c[0])).toEqual([
      "references_not_last",
    ]);
  });
  it("N3: a literal $ in the document title warns", () => {
    const md = `${marker("argelander-document", { version: 1, title: "Costs $5" })}x\n`;
    expect(codes(md)).toEqual([["title_dollar", "warning", 2, 14]]);
  });
  it("L1: a reference id that is also a block id is an error at the reference", () => {
    const md = `${marker("argelander-block", { id: "same" })}text\n\n${marker(
      "argelander-references",
      [{ id: "same", raw: "S" }]
    )}`;
    expect(codes(md).map((c) => c[0])).toEqual(["reference_id_collision"]);
  });
  it("L2: explicit ids may not start with ann-", () => {
    expect(codes(`${marker("argelander-block", { id: "ann-1" })}text\n`).map((c) => c[0])).toEqual([
      "id_reserved",
    ]);
  });
  it("L3: a lone CR inside a code body is kept; CRLF is one line break", () => {
    const body = blocks(`${F}\na\rb\n${F}\n`)[0];
    expect(body).toMatchObject({ type: "code", body: "a\rb" });
    const crlf = blocks(`${F}\r\nx\r\ny\r\n${F}\r\n`)[0];
    expect(crlf).toMatchObject({ type: "code", body: "x\ny" });
  });
  it("N2: an escaped backtick is literal for the scanner as it is for the lexer", () => {
    const r = parse("A \\`a $x$ b\\` c\n");
    expect(r.stats.inlineMath).toBe(1);
    expect(shape("A \\`a $x$ b\\` c\n")).toEqual(["p:A `a $x$ b` c"]);
  });
});
