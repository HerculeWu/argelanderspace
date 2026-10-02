import { Marked } from "marked";
import { renderMathToString } from "../lib/math";

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
function safeLink(href: string): boolean {
  if (Array.from(href).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(href, "http://workbench.invalid");
    return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
const markdown = new Marked({ gfm: true, breaks: true,
  renderer: {
    html({ text }) { return escape(text); },
    image({ text }) { return escape(text); },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return safeLink(href) ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
  },
  extensions: [{
    name: "copilotMath", level: "inline",
    start(source) { return source.indexOf("$"); },
    tokenizer(source) {
      const match = /^(?:\$\$([\s\S]+?)\$\$|\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$]))/.exec(source);
      if (match) return { type: "copilotMath", raw: match[0], latex: match[1] ?? match[2], display: match[1] !== undefined };
    },
    renderer(token) { return renderMathToString(token.latex as string, token.display as boolean); },
  }],
});

/** Raw HTML and images are text; only generated Markdown/KaTeX markup reaches the DOM. */
export function copilotMarkdown(source: string): string { return markdown.parse(source, { async: false }); }
