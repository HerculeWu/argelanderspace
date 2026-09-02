/**
 * mdWithMath (Stage 4 task notes): math spans are stashed into placeholders
 * BEFORE marked runs, so `*` / `_` / `\` inside `$…$`/`$$…$$` survive as
 * KaTeX input instead of becoming markdown emphasis/breaks — and no
 * placeholder leaks into the output.
 */

import { describe, expect, it } from "vitest";
import { mdWithMath } from "../src/lib/mdWithMath";

describe("mdWithMath", () => {
  it("renders plain markdown (headings, bold, lists, code)", () => {
    const html = mdWithMath("# 标题\n\n**粗体** 与 `代码`\n\n- 第一项\n- 第二项");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("inline math becomes KaTeX and its LaTeX survives intact", () => {
    // KaTeX output is `output: "html"` (no MathML annotation), so survival is
    // pinned on the rendered glyph: a chewed-up `\cdot` (marked escaping the
    // backslash) could never render ⋅.
    const html = mdWithMath("向量 $a_i \\cdot b_j$ 的点积");
    expect(html).toContain('class="katex"');
    expect(html).toContain("⋅");
    expect(html).not.toContain("<em>");
  });

  it("stars and underscores inside math are not eaten by markdown", () => {
    const html = mdWithMath("公式 $a*b_{c_d}$ 存活");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<em>");
    expect(html).toContain("存活");
  });

  it("backslashes survive into KaTeX (\\times renders as ×)", () => {
    const html = mdWithMath("$\\boldsymbol{a} \\times \\vec{b}$");
    expect(html).toContain("×"); // \times rendered — the backslashes got through
  });

  it("display math $$…$$ renders in display mode (multiline ok)", () => {
    const html = mdWithMath("推导：\n\n$$E = mc^2 \\\\ \\Delta E > 0$$");
    expect(html).toContain("katex-display");
    expect(html).toContain("Δ"); // \Delta rendered
  });

  it("markdown around the math still renders", () => {
    const html = mdWithMath("**重要**：$E=mc^2$ 是 *核心* 公式");
    expect(html).toContain("<strong>重要</strong>");
    expect(html).toContain("<em>核心</em>");
    expect(html).toContain('class="katex"');
  });

  it("no placeholder leaks into the output", () => {
    const html = mdWithMath("$a$ 和 $$b$$ 与 $c_1$");
    expect(html).not.toContain("@@PLANMATH");
    expect(html).not.toContain("@@");
  });

  it("empty / whitespace input yields an empty string", () => {
    expect(mdWithMath("")).toBe("");
    expect(mdWithMath("   ")).toBe("");
  });

  it("a broken formula degrades like the reader (no throw, source kept)", () => {
    const html = mdWithMath("坏公式 $\\notacommand{x}$ 在此");
    expect(html).toContain("katex");
    expect(html).toContain("在此");
  });
});

describe("mdWithMath: literal-$ zones are never math (MS3 review B1)", () => {
  it("inline code spans keep their $ untouched", () => {
    const html = mdWithMath("用 `$a` 和 `$b` 两个变量");
    expect(html).toContain("<code>$a</code>");
    expect(html).toContain("<code>$b</code>");
    expect(html).not.toContain('class="katex"');
  });

  it("fenced code blocks keep their $ untouched", () => {
    const html = mdWithMath("```\nlet x = $a + $b;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("$a + $b;");
    expect(html).not.toContain('class="katex"');
  });

  it("currency pairs stay text (closing-$ digit rule)", () => {
    const html = mdWithMath("预算在 $100 到 $200 之间");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$100 到 $200");
  });

  it("an escaped \\$ is not math", () => {
    const html = mdWithMath("价格 \\$5 很便宜");
    expect(html).not.toContain('class="katex"');
  });

  it("a $…$ inside a link destination stays verbatim in the href (no KaTeX injection)", () => {
    const html = mdWithMath("[x](https://a.com/?q=$x$)");
    expect(html).not.toContain('class="katex"');
    // pin the HREF itself (the earlier toContain("q=$x$") matched autolink text)
    expect(html).toContain('href="https://a.com/?q=$x$"');
    expect(html).toContain(">x</a>");
  });

  it("an image destination keeps its $ verbatim in src", () => {
    const html = mdWithMath("![fig](https://a.com/$f$.png)");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('src="https://a.com/$f$.png"');
    expect(html).toContain('alt="fig"');
  });

  it("a reference-definition destination resolves uses with the raw href", () => {
    const html = mdWithMath("[r]: https://a.com/$q$\n\nsee [r] now");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('href="https://a.com/$q$"');
    expect(html).toContain(">r</a>");
  });

  it("an angle autolink keeps its $ verbatim in href and text", () => {
    const html = mdWithMath("<https://a.com/$q$>");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('href="https://a.com/$q$"');
    expect(html).toContain(">https://a.com/$q$</a>");
  });

  it("a bare URL carrying $ autolinks with the raw href (GFM parity)", () => {
    const html = mdWithMath("see https://a.com/?q=$x$ now");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('href="https://a.com/?q=$x$"');
  });

  it("math in the link VISIBLE TEXT still renders while the dest is stashed", () => {
    const html = mdWithMath("[公式 $x$](https://a.com/?q=$y$)");
    expect(html).toContain('class="katex"'); // the label's math rendered
    expect(html).toContain('href="https://a.com/?q=$y$"'); // the dest untouched
  });

  it("~~~ fences keep their $ untouched", () => {
    const html = mdWithMath("~~~\nlet y = $a + $b;\n~~~");
    expect(html).toContain("<pre>");
    expect(html).toContain("$a + $b;");
    expect(html).not.toContain('class="katex"');
  });

  it("multi-backtick code spans keep their $ untouched", () => {
    const html = mdWithMath("变量 `` `$x$` `` 在此");
    expect(html).toContain("<code>`$x$`</code>");
    expect(html).not.toContain('class="katex"');
  });

  it("a user-typed placeholder-looking token is harmless (per-run entropy)", () => {
    const html = mdWithMath("文本 @@PLAN-MATH-0-0@@ 与 $a$");
    expect(html).toContain("@@PLAN-MATH-0-0@@"); // survives as literal text
    expect(html).toContain('class="katex"'); // while the real math still renders
  });

  it("math next to protected zones still renders", () => {
    const html = mdWithMath("代码 `$x` 之外，公式 $y_1$ 正常");
    expect(html).toContain("<code>$x</code>");
    expect(html).toContain('class="katex"');
  });
});
