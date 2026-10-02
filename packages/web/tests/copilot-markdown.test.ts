import { expect, test } from "vitest";
import { copilotMarkdown } from "../src/copilot/markdown";

test("chat Markdown rejects active HTML, dangerous dollar URLs and automatic images", () => {
  const html = copilotMarkdown('<img src="https://spy.invalid/pixel" onerror="alert(1)">\n\n[x](javascript:alert$1) [x](javascript:alert(1)) ![remote](https://spy.invalid/$x$)\n\n[ok](https://example.com/?price=$5)');
  const body = new DOMParser().parseFromString(html, "text/html").body;
  expect(body.querySelector("img,script,iframe,object")).toBeNull();
  expect([...body.querySelectorAll("a")].every((link) => link.getAttribute("href")?.startsWith("https://example.com/"))).toBe(true);
  expect(body.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(body.textContent).toContain("remote");
});

test("chat math preserves code, escapes, Markdown structure and safe links", () => {
  const html = copilotMarkdown('**Bold** $x_1^2$\n\n$$a*b_c$$\n\n`$not_math$`\n\n```js\nconst s = "$code$";\n```\n\n\\$5 [math $y$](https://example.com/$amount)');
  const body = new DOMParser().parseFromString(html, "text/html").body;
  expect(body.querySelector("strong")?.textContent).toBe("Bold");
  expect(body.querySelectorAll(".katex")).toHaveLength(3);
  expect(body.querySelector("pre code")?.textContent).toContain('"$code$"');
  expect(body.querySelector("code")?.textContent).toBe("$not_math$");
  expect(body.textContent).toContain("$5");
  expect(body.querySelector("a")?.getAttribute("href")).toBe("https://example.com/$amount");
  expect(body.querySelector(".katex-display")).toBeTruthy();
});
