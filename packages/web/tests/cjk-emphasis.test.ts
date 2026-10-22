import { describe, expect, test } from "vitest";
import { copilotMarkdown } from "../src/copilot/markdown";
import { mdWithMath } from "../src/lib/mdWithMath";

const renderers: Array<[string, (s: string) => string]> = [
  ["copilotMarkdown", copilotMarkdown],
  ["mdWithMath", (s) => mdWithMath(s)],
  ["mdWithMath safe", (s) => mdWithMath(s, { safe: true })],
];

// [source, expected <strong> texts, expected <em> texts]
// optional 4th: expected <del> texts
const cases: Array<[string, string[], string[], string[]?]> = [
  ["**「文字」**后面", ["「文字」"], []],
  ["说**“文字”**吧", ["“文字”"], []],
  ["前面**『书名』**后面", ["『书名』"], []],
  ["表示**（括号）**之后", ["（括号）"], []],
  ["读**《红楼梦》**吧", ["《红楼梦》"], []],
  ["这是**重点。**接着说", ["重点。"], []],
  ["**この文は太字？**即便加入", ["この文は太字？"], []],
  ["斜体*「引用」*之后", [], ["「引用」"]],
  // the extension also relaxes `_`/`__` and GFM strikethrough `~`/`~~` next to CJK punctuation
  ["__「文字」__后面", ["「文字」"], []],
  ["_「文字」_后面", [], ["「文字」"]],
  ["删除~~「旧」~~后面", [], [], ["「旧」"]],
  // accepted looseness: either side CJK (letter or punctuation) is enough, so English before the opener also works
  ["x **「y」**z", ["「y」"], []],
  // CommonMark behaviour that must stay unchanged
  ["snake_case_name", [], []],
  ["foo__bar__baz", [], []],
  ["__foo__bar", [], []],
  ["a~b~c", [], [], ["b"]],
  ["a~~b~~c", [], [], ["b"]],
  ["foo**bar**baz", ["bar"], []],
  ["**foo**bar", ["foo"], []],
  ["**foo**", ["foo"], []],
  ["a **(x)**b", [], []],
  ["2 ** 3 ** 4", [], []],
  ["*foo bar *", [], []],
];

describe.each(renderers)("CJK-adjacent emphasis in %s", (_name, render) => {
  test.each(cases)("%s", (source, strong, em, del = []) => {
    const body = new DOMParser().parseFromString(render(source), "text/html").body;
    expect([...body.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(strong);
    expect([...body.querySelectorAll("em")].map((e) => e.textContent)).toEqual(em);
    expect([...body.querySelectorAll("del")].map((e) => e.textContent)).toEqual(del);
  });
});

test("math protection is unaffected by the CJK extension", () => {
  const html = mdWithMath("**「公式」** $a*b_c$ 与 **“x”** $$x**y$$");
  const body = new DOMParser().parseFromString(html, "text/html").body;
  expect([...body.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(["「公式」", "“x”"]);
  expect(body.querySelectorAll(".katex").length).toBe(2);
});
