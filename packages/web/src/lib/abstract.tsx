/**
 * Abstract rendering (Stage 14 follow-up): bibliographic abstracts (ADS /
 * Crossref-derived) are NOT markdown — they carry presentational HTML from
 * the provider (`<SUB>`/`<SUP>`/`<i>`…) plus LaTeX `$…$` math. Render them
 * faithfully but safely:
 *
 * 1. parse as HTML (entities decode naturally);
 * 2. drop active-content elements outright (script/style/iframe/object/…),
 *    unwrap every non-whitelisted element (keeping its text), and strip all
 *    attributes from the kept presentational tags (SUB/SUP/I/B/EM/STRONG/BR/P);
 * 3. render `$…$`/`$$…$$` inside TEXT NODES with KaTeX, using the same
 *    texmath boundary rules as mdWithMath (so `$100 to $200` stays text and
 *    a `$` can't pair across tags).
 *
 * Output is injected via dangerouslySetInnerHTML, matching the established
 * single-user ruling for mdWithMath (TaskDrawer / AnnotationPopover).
 */

import { cleanLatex, renderMathToString } from "./math";

const ALLOWED = new Set(["SUB", "SUP", "I", "B", "EM", "STRONG", "BR", "P"]);
const DROP_WITH_CONTENT = "script,style,iframe,object,embed,link,meta,form,input,button,svg";

// texmath boundary rules (pandoc's), identical to mdWithMath's MATH_RE: the
// opening `$` needs a non-space to its right and no `\` to its left; the
// closing `$` a non-space to its left and no digit or `$` to its right.
const MATH_RE =
  /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function inlineMathInText(s: string): string {
  let out = "";
  let last = 0;
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    if (m[1] !== undefined) out += renderMathToString(cleanLatex(m[1]), true);
    else out += renderMathToString(cleanLatex(m[2]!), false);
    last = MATH_RE.lastIndex;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

/** Sanitize + math-render one bibliographic abstract to an HTML string. */
export function abstractHtml(src: string): string {
  try {
    const doc = new DOMParser().parseFromString(src ?? "", "text/html");
    doc.querySelectorAll(DROP_WITH_CONTENT).forEach((el) => el.remove());
    for (const el of [...doc.body.querySelectorAll("*")]) {
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(...el.childNodes); // unwrap: keep inner text/allowed children
      } else {
        for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      }
    }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) texts.push(node as Text);
    for (const t of texts) {
      const s = t.nodeValue ?? "";
      if (!s.includes("$")) continue;
      const span = doc.createElement("span");
      span.innerHTML = inlineMathInText(s);
      t.replaceWith(...span.childNodes);
    }
    return doc.body.innerHTML;
  } catch {
    return escapeHtml(src ?? "");
  }
}

/** The abstract block for the library detail / discovery inspector. */
export function AbstractHtml({ text, className }: { text: string; className?: string }) {
  // provider metadata (ADS), sanitized above; same injection ruling as mdWithMath
  return <div className={className} dangerouslySetInnerHTML={{ __html: abstractHtml(text) }} />;
}
