/**
 * A table body from the compile pipeline, made safe to inject (copilot ticket 23, spec 14.3). The Writer preview
 * shows `tableBody` HTML of cells an agent can now write, so it is reduced to table structure and a few inline
 * presentation tags: nothing else survives (a script, an event attribute, a link, an image or a style is dropped,
 * its text kept) and the only attributes left are numeric `rowspan`/`colspan`. Math in the text nodes is rendered
 * afterwards by `htmlWithMath`, whose output is KaTeX markup built from the text, never from this HTML.
 */
const KEEP = new Set([
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TH",
  "TD",
  "CAPTION",
  "COLGROUP",
  "COL",
  "SUB",
  "SUP",
  "I",
  "B",
  "EM",
  "STRONG",
  "BR",
  // a literal dollar of a cell sits in its own span so it cannot pair with another one into a formula
  "SPAN",
]);
const DROP_WITH_CONTENT = "script,style,iframe,object,embed,link,meta,form,input,button,svg,math,template,noscript";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function safeTableHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html ?? "", "text/html");
    doc.querySelectorAll(DROP_WITH_CONTENT).forEach((el) => el.remove());
    for (const el of [...doc.body.querySelectorAll("*")]) {
      if (!KEEP.has(el.tagName)) {
        el.replaceWith(...el.childNodes); // unwrap: the text stays, the element does not
        continue;
      }
      for (const attr of [...el.attributes]) {
        const span = (attr.name === "rowspan" || attr.name === "colspan") && /^\d{1,4}$/.test(attr.value);
        if (!span) el.removeAttribute(attr.name);
      }
    }
    return doc.body.innerHTML;
  } catch {
    return escapeHtml(html ?? "");
  }
}
