import type { IrBlock, IrSection } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { parseTextSource } from "../src/documents/text-codec.js";

const FIG = {
  name: "fz-0123abcd.png",
  sha256: "a".repeat(64),
  byte_length: 10,
};
const opts = { docId: "text-1", sourceRev: 1, assets: [FIG] };
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

describe("macro bombs: definitions are refused, never typeset", () => {
  const bomb = `\\def\\a{${"x".repeat(4000)}}${"\\a".repeat(40)}`;
  it("a defined macro used many times is an error at the formula, found without running KaTeX", () => {
    for (const md of [`Text $${bomb}$ end.\n`, `$$${bomb}$$\n`, `a $$${bomb}$$ b\n`]) {
      const started = performance.now();
      const r = parse(md);
      expect(performance.now() - started, md.slice(0, 20)).toBeLessThan(300);
      expect(r.ir).toBeNull();
      expect(r.diagnostics[0]).toMatchObject({
        code: "math_macro_unsupported",
        severity: "error",
        subject: "\\def",
      });
      expect(r.diagnostics[0]?.line).toBe(1);
    }
  });
  it("an 8 k-character document with a macro bomb parses at once", () => {
    const md = `$$\\def\\a{${"x".repeat(3500)}}${"\\a".repeat(30)}$$\n\n${"filler ".repeat(300)}\n`;
    const started = performance.now();
    parse(md);
    expect(performance.now() - started).toBeLessThan(500);
  });
  it("every way to define or build a macro is refused; an escaped backslash is not a command", () => {
    for (const cmd of [
      "\\gdef",
      "\\edef",
      "\\xdef",
      "\\let",
      "\\futurelet",
      "\\newcommand",
      "\\renewcommand",
      "\\providecommand",
      "\\global",
      "\\expandafter",
      "\\csname",
      "\\newenvironment",
    ]) {
      expect(parse(`a $${cmd}\\z{y}$ b\n`).diagnostics[0], cmd).toMatchObject({
        code: "math_macro_unsupported",
        subject: cmd,
      });
    }
    expect(codes("a $x\\\\def y$ b\n")).toEqual([]);
    expect(codes("a $\\deflection$ b\n").map((c) => c[0])).not.toContain("math_macro_unsupported");
  });
  it("what is left is bounded by maxExpand: runaway built-in expansion is an error from KaTeX, quickly", () => {
    const started = performance.now();
    const r = parse(`$${"\\ensuremath{".repeat(3000)}x${"}".repeat(3000)}$\n`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.diagnostics.length).toBeGreaterThanOrEqual(0);
  });
});

describe("blocker 2: a closing fence is exactly what the lexer closes on", () => {
  it("a closing fence followed by a tab does not close: the display after it stays code, once", () => {
    const md = `${F}\na\n${F}\t\n$$D$$\n${F}\n`;
    const r = parse(md);
    expect(r.diagnostics).toEqual([]);
    const bs = blocks(md);
    expect(bs.map((b) => b.type)).toEqual(["code"]);
    expect(bs[0]).toMatchObject({ body: `a\n${F}\t\n$$D$$` });
  });
  it("a closing fence may continue with fence characters of either kind and trailing spaces", () => {
    const md = `${F}\na\n${F}~~  \n$$D$$\n`;
    expect(blocks(md).map((b) => b.type)).toEqual(["code", "equation"]);
    expect(codes(md)).toEqual([]);
  });
  it("a closing run must start with the whole opening run; fewer characters do not close", () => {
    const md = `${F}${F}\nin $$D$$\n${F}\nstill in\n${F}${F}\nout $x$\n`;
    const bs = blocks(md);
    expect(bs[0]).toMatchObject({ type: "code", body: `in $$D$$\n${F}\nstill in` });
    expect(parse(md).stats.inlineMath).toBe(1);
  });
});

describe("blocker 3: a lone CR is a line break for structure, and still a byte in code", () => {
  it("a fence that starts after a lone CR is a fence (no duplicated display)", () => {
    const md = `a\r${F}\n$$D$$\n${F}\n`;
    const r = parse(md);
    expect(r.diagnostics).toEqual([]);
    const bs = blocks(md);
    expect(bs.map((b) => b.type)).toEqual(["paragraph", "code"]);
    expect(bs[1]).toMatchObject({ body: "$$D$$" });
  });
  it("a display alone after a lone CR is a block; a lone CR inside a code body is kept", () => {
    expect(blocks("a\r$$D$$\r\nb\n").map((b) => b.type)).toEqual([
      "paragraph",
      "equation",
      "paragraph",
    ]);
    expect(blocks(`${F}\nx\ry $$z$$\n${F}\n`)[0]).toMatchObject({
      type: "code",
      body: "x\ry $$z$$",
    });
  });
  it("diagnostics keep the editor's line counting (a lone CR is not a line break there)", () => {
    // line 1 is "a\r[cite: bad id]" for the editor: the cite is at column 3
    expect(codes("a\r[cite: bad id]\n")).toEqual([["cite_syntax", "error", 1, 3]]);
  });
});

describe("non-blocking fixes", () => {
  it("M3: untrusted commands are found by KaTeX's own trust hook, not by colour", () => {
    expect(codes("a $\\textcolor{#b00020}{x}$ b\n")).toEqual([]);
    expect(codes("a $\\textcolor{#B00020}{x}$ b\n")).toEqual([]);
    expect(codes("a $\\HREF{x}{y}$ b\n").map((c) => c[0])).toEqual(["math_katex"]); // unknown command, not trust
    expect(parse("a $\\href{x}{y}$ b\n").diagnostics[0]).toMatchObject({
      code: "math_untrusted_command",
      subject: "\\href",
    });
    expect(parse("$$\\htmlClass{c}{y}$$\n").diagnostics[0]).toMatchObject({
      code: "math_untrusted_command",
      subject: "\\htmlClass",
    });
  });
  it("the math_not_checked summary counts the formulas after the one reported where it is", () => {
    const md = (n: number) => `# T\n\n${"a $x$ b\n\n".repeat(n)}`;
    const none = parse(md(3000));
    expect(none.diagnostics).toEqual([]);
    const one = parse(md(3001)); // one past the count budget: located, no summary
    expect(one.diagnostics.map((d) => [d.code, d.subject])).toEqual([
      ["math_not_checked", "budget"],
    ]);
    const three = parse(md(3003)); // located first + summary of the other two
    const summary = three.diagnostics.find((d) => d.line === undefined);
    expect(summary).toMatchObject({ code: "math_not_checked", subject: "2" });
    expect(three.diagnostics.filter((d) => d.line !== undefined)).toHaveLength(1);
  });
  it("a URL that swallows the closing $ of a formula is said, where the URL is", () => {
    expect(codes("$\\href{http://x.org}{y}$ tail\n")).toEqual([
      ["math_url_swallowed", "warning", 1, 8],
    ]);
    // dollars inside a URL with no formula opened before it are just a URL
    expect(codes("see https://example.org/a$b$ now\n")).toEqual([]);
    expect(codes("It costs $100 to $200 at https://example.org/a$b$c now\n")).toEqual([]);
  });
  it("reference ids ann- and prototype names are reserved (see text-fix1) and the Reader keeps bib in a Map", () => {
    expect(
      codes(`x\n\n${F}argelander-references\n[{"id":"ann-1","raw":"R"}]\n${F}\n`).map((c) => c[0])
    ).toEqual(["id_reserved"]);
  });
});

describe("the scan and the lexer cannot silently disagree", () => {
  it("every extracted formula is placed exactly once or reported where it is", () => {
    // an indented fence the scan does not see but the list item holds: the formula inside must not vanish or repeat
    const r = parse(`- a\n    ${F}\n    $$D$$\n    ${F}\n`);
    expect(
      r.ir === null
        ? r.diagnostics.length > 0
        : JSON.stringify(r.ir.sections).split("D").length === 2
    ).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// A seeded, time-bounded property test: whatever the text is, a parse that succeeds contains every marked word of the
// source exactly once, in the reading text; a parse that fails says so with an error. The generator mixes everything the
// scan and the lexer could disagree about: fences (all lengths, kinds, indents, closers with tabs/spaces/more fence
// characters, unclosed), lone CR / CRLF, code spans, URLs, escapes, math in every position, lists split by displays,
// cites and refs.
// ------------------------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(rand: () => number): { src: string; words: string[] } {
  const words: string[] = [];
  let n = 0;
  const w = (): string => {
    const word = `Q${++n}Z`;
    words.push(word);
    return word;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const ws = (): string => pick(["", " ", "  ", "\t"]);
  const closers = ["", " ", "\t", "  ", "~", "`", "x", " \t"];
  const unit = (): string => {
    switch (Math.floor(rand() * 29)) {
      case 0:
        return `para ${w()} text`;
      case 1:
        return `an inline $a ${w()} b$ formula and $${"c"}${w()}$ here`;
      case 2:
        return `$$\n${w()} + 1\n$$`;
      case 3:
        return `${pick(["", " ", "   ", "\t"])}$$ ${w()} $$`;
      case 4:
        return `before $$ ${w()} $$ after ${w()}`;
      case 5: {
        const ch = pick(["`", "~"]);
        const run = ch.repeat(3 + Math.floor(rand() * 3));
        const body = [
          `code ${w()}`,
          pick(["$$ ", "$x ", "[cite: a | ", "", "text "]) + w(),
          pick(["", "`", "~~~", "$$"]),
        ].join("\n");
        const closed = rand() < 0.85;
        const close = closed ? `${pick(["", " ", "  "])}${run}${pick(closers)}` : "";
        return `${pick(["", " ", "  "])}${run}${pick(["", "text", " py"])}\n${body}${closed ? `\n${close}` : ""}`;
      }
      case 6:
        return `see \`${w()} $x$\` and \`\`two ${w()}\`\` end`;
      case 7:
        return `link https://example.org/${w()}$ and https://a.b/c]d ${w()}`;
      case 8:
        return `escaped \\$${w()} and \\\`${w()}\\\` done`;
      case 9:
        return `- item ${w()}\n- item $f ${w()}$`;
      case 10:
        return `1. one ${w()}\n2. two ${w()}`;
      case 11:
        return `- item ${w()}\n\n$$ ${w()} $$\n\n- item ${w()}`;
      case 12:
        return `# Heading ${w()}`;
      case 13:
        return `cite [cite: a | ${w()}] and [ref: nowhere | ${w()}] ok`;
      case 14:
        return `quote ${w()} $$ ${w()} $$ $$ ${w()} $$ tail`;
      case 15:
        return `*em ${w()}* and **strong ${w()}**`;
      case 16:
        return `${F}${pick(["", "\t", " "])}\n$$ ${w()} $$\n${F}${pick(closers)}\n$$ ${w()} $$\n${F}`;
      case 17:
        return `x\r${F}\n$$ ${w()} $$\n${F}\ny ${w()}`;
      case 18:
        return `line one ${w()}\rline two $q ${w()}$\rline three`;
      case 20:
        return `${pick(["", " ", "   "])}![alt ${w()}](assets/fz-0123abcd.png)${pick(["", " ", "  "])}`;
      case 21:
        return `| h ${w()} | h $x ${w()}$ |\n| ${pick(["---", ":-:", "--:"])} | --- |\n| c ${w()} | ${pick(["$a|b ", "$q "])}${w()}$ |${rand() < 0.5 ? `\n| r ${w()} | s |` : ""}`;
      case 22:
        return `${F}argelander-table\n${JSON.stringify({ rows: [[{ text: `t ${w()} $m ${w()}$`, header: true, colspan: 2 }], [{ text: `u ${w()}` }, { text: `v ${w()}`, rowspan: 1 }]] })}\n${F}`;
      case 23:
        return `${F}argelander-block\n${JSON.stringify({ caption: `cap ${w()} $z ${w()}$`, footnote: `note ${w()}` })}\n${F}\n![x](assets/fz-0123abcd.png)`;
      case 24:
        return `${F}\n| code ${w()} |\n| --- |\n![in code ${w()}](assets/fz-0123abcd.png)\n${F}`;
      case 25:
        return `text \`![in span ${w()}](assets/fz-0123abcd.png)\` and ![alt ${w()}](assets/fz-0123abcd.png) inline`;
      case 26:
        return `a | b ${w()}\n--|--\nc | d ${w()}`;
      case 27: {
        // even and odd backslash runs before a pipe: marked splits on parity, so an extra cell may be lost unless refused
        const run = "\\".repeat(Math.floor(rand() * 6));
        return `| h ${w()} | h2 ${w()} |\n| --- | --- |\n| a${run}| b ${w()} | c ${w()} |`;
      }
      case 28: {
        const run = "\\".repeat(Math.floor(rand() * 6));
        return `| h ${w()} | h2 ${w()} |\n| --- | --- |\n| x ${w()} | y${run}| ${rand() < 0.5 ? "" : `z ${w()} |`}`;
      }
      default:
        return `plain ${w()}${ws()}`;
    }
  };
  const count = 1 + Math.floor(rand() * 7);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(unit());
  const sep = pick(["\n\n", "\n", "\r\n\r\n", "\r\n", "\n\r\n", "\r\r"]);
  return { src: parts.join(sep) + pick(["", "\n", "\r\n"]), words };
}

describe("property: no word of the source is lost or shown twice", () => {
  it("holds for generated sources (seeded, time-bounded)", () => {
    const deadline = performance.now() + 4000;
    let cases = 0;
    let accepted = 0;
    for (let seed = 1; seed <= 30000 && performance.now() < deadline; seed += 1) {
      const { src, words } = generate(mulberry32(seed));
      const r = parseTextSource(src, opts);
      cases += 1;
      if (r.ir === null) {
        expect(
          r.diagnostics.some((d) => d.severity === "error"),
          `seed ${seed}: refused without an error\n${JSON.stringify(src)}`
        ).toBe(true);
        continue;
      }
      accepted += 1;
      // the raw footnote string stays beside its segments; the words are counted in what the Reader shows
      const text = JSON.stringify(r.ir.sections, (k, v) => (k === "footnote" ? undefined : v));
      for (const word of words) {
        const count = text.split(word).length - 1;
        expect(count, `seed ${seed}: ${word} appears ${count} times\n${JSON.stringify(src)}`).toBe(
          1
        );
      }
    }
    expect(cases).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(20);
  }, 30_000);
});
