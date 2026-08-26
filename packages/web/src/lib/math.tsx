import katex from "katex";

/** Strip $/$$ delimiters, \tag{}, \label{}, and surrounding whitespace. */
export function cleanLatex(src: string): string {
  let s = (src ?? "").trim();
  s = s.replace(/^\$\$?/, "").replace(/\$\$?$/, "").trim();
  // one level of brace nesting (e.g. \label{eq:a_{0}}) so we don't leave a stray }
  s = s.replace(/\\tag\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  s = s.replace(/\\label\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  return s.trim();
}

/** Collapse multi-row LaTeX environments to a single visual row (for one-line
 *  previews); aligned/cases/array etc. are unwrapped and \\ / & become spaces. */
export function flattenLatex(src: string): string {
  let x = cleanLatex(src);
  x = x.replace(
    /\\(?:begin|end)\s*\{(?:aligned?|align\*?|cases|gather\*?|gathered|array|split|matrix|eqnarray\*?)\}(?:\{[^}]*\})?/g,
    ""
  );
  x = x.replace(/\\\\(\[[^\]]*\])?/g, " ");
  x = x.replace(/&/g, " ");
  return x.trim();
}

export function renderMathToString(latex: string, displayMode = false): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "html",
      errorColor: "#b00020",
    });
  } catch {
    return `<span class="math-error">${escapeHtml(latex)}</span>`;
  }
}

export function Math({
  latex,
  display = false,
  className,
}: {
  latex: string;
  display?: boolean;
  className?: string;
}) {
  const html = renderMathToString(cleanLatex(latex), display);
  return (
    <span
      className={className}
      // KaTeX output is generated from our own LaTeX strings, not user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render inline $...$ / display $$...$$ inside a plain-text string to HTML,
 *  escaping the non-math remainder so it is safe to inject. */
function inlineMathInText(s: string): string {
  let out = "";
  let last = 0;
  // display math first, then inline; both confined to this text fragment
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\$)([^$]+?)\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    if (m[1] !== undefined) out += renderMathToString(cleanLatex(m[1]), true);
    else out += renderMathToString(cleanLatex(m[2]), false);
    last = re.lastIndex;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

/** Replace $...$ spans with rendered KaTeX inside an HTML string, operating on
 *  TEXT NODES only. This preserves the markup structure (e.g. table colspans)
 *  and prevents a stray '$' from pairing across tags/cells, while still allowing
 *  '<'/'>' inequalities inside a single cell's math. */
export function htmlWithMath(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html ?? "", "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) texts.push(node as Text);
    for (const t of texts) {
      const s = t.nodeValue ?? "";
      if (s.indexOf("$") === -1) continue;
      const span = doc.createElement("span");
      span.innerHTML = inlineMathInText(s);
      t.replaceWith(...Array.from(span.childNodes));
    }
    return doc.body.innerHTML;
  } catch {
    return html ?? "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
