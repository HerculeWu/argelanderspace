/**
 * A tree builder over htmlparser2's streaming `Parser` callbacks that
 * reproduces **Python `html.parser` tree semantics** (what BeautifulSoup's
 * `html.parser` builder froze the goldens with), instead of htmlparser2's
 * default HTML5-ish tree construction.
 *
 * Why: htmlparser2's `Parser` auto-closes `<p>` before block-level children
 * (`<div>`, `<pre>`, another `<p>`, …) and inserts an empty `<p>` for a stray
 * `</p>`; Python's `html.parser` does neither — it nests everything until an
 * explicit end tag, and ignores unmatched end tags. On publisher pages this
 * moves float/table/pre content in or out of paragraphs (measured: the A&A
 * golden's `<p><div class="inset">` wrappers and the OUP golden's
 * `<p class="mixed-citation-compatibility">` reference entries, whose `<div>`
 * children would otherwise be ejected and dropped).
 *
 * The event-level behavior (attribute assembly, entity decoding, raw-text
 * elements, foreign `<math>`/`<svg>` context) is htmlparser2's and matches
 * html.parser closely; only the *tree construction* differs, which is what we
 * override:
 *
 * - `onopentag(name, attribs, implied)`: `implied=true` marks the Parser's
 *   synthesized open for a stray `</p>` — html.parser ignores the stray end
 *   tag entirely, so the synthesized element is ignored here. Void elements
 *   (bs4's empty-element set) are created but never pushed, exactly like
 *   bs4's tree builder.
 * - `onclosetag(name, isImplied)`: `isImplied=true` is either an
 *   open-implies-close ancestor pop (ignored — html.parser keeps nesting) or
 *   a self-close (`<foo/>`, honored — html.parser reports it as
 *   `handle_startendtag`, i.e. an immediately-closed empty element). The two
 *   are told apart via the Parser's own stack: in the self-close path
 *   (`closeCurrentTag`) the tag is still on top of the Parser's stack when
 *   the callback fires; in the auto-close path it has already been shifted
 *   off, so `parser.stack[0]` holds its parent instead.
 * - real end tags pop to the nearest matching open element (closing anything
 *   in between), or are ignored when nothing matches — bs4's `_popToTag`.
 * - adjacent text is merged into one node, matching html.parser's
 *   `convert_charrefs` buffering (and domhandler's own convention), so
 *   `get_text(separator)` boundaries line up with bs4's string stream.
 */

import {
  CDATA,
  type ChildNode,
  Comment,
  Document,
  Element,
  ProcessingInstruction,
  Text,
} from "domhandler";
import { Parser } from "htmlparser2";

/** bs4 html.parser tree builder's empty-element (void) tag set. */
const BS4_VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "image",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "menuitem",
  "meta",
  "nextid",
  "param",
  "source",
  "spacer",
  "track",
  "wbr",
]);

type Container = Document | Element;

class Bs4TreeBuilder {
  readonly root: Document = new Document([]);
  private readonly stack: Container[] = [this.root];
  /** The node text/comment data currently accumulates into (domhandler's
   *  lastNode convention). */
  private lastNode: Text | Comment | null = null;
  private parser: Parser | null = null;

  private get top(): Container {
    return this.stack[this.stack.length - 1] as Container;
  }

  onparserinit(parser: Parser): void {
    this.parser = parser;
  }

  private addNode(node: ChildNode): void {
    const parent = this.top;
    const siblings = parent.children as ChildNode[];
    const prev = siblings[siblings.length - 1];
    if (prev) prev.next = node;
    node.prev = prev ?? null;
    node.parent = parent;
    siblings.push(node);
  }

  onopentag(name: string, attribs: Record<string, string>, implied?: boolean): void {
    if (implied) return; // Parser-synthesized open for a stray </p> — bs4 ignores
    const element = new Element(name, attribs);
    this.addNode(element);
    this.lastNode = null;
    if (BS4_VOID_TAGS.has(name)) {
      // bs4 never pushes void elements (they cannot have children).
      return;
    }
    this.stack.push(element);
  }

  ontext(data: string): void {
    const last = this.lastNode;
    if (last && last.type === "text") {
      last.data += data;
    } else {
      const node = new Text(data);
      this.addNode(node);
      this.lastNode = node;
    }
  }

  oncomment(data: string): void {
    const last = this.lastNode;
    if (last && last.type === "comment") {
      last.data += data;
    } else {
      const node = new Comment(data);
      this.addNode(node);
      this.lastNode = node;
    }
  }

  oncommentend(): void {
    this.lastNode = null;
  }

  oncdatastart(): void {
    const text = new Text("");
    const node = new CDATA([text]);
    this.addNode(node);
    text.parent = node;
    this.lastNode = text;
  }

  oncdataend(): void {
    this.lastNode = null;
  }

  onprocessinginstruction(name: string, data: string): void {
    this.addNode(new ProcessingInstruction(name, data));
    this.lastNode = null;
  }

  ondeclaration(data: string): void {
    this.addNode(new ProcessingInstruction(data, data));
    this.lastNode = null;
  }

  onclosetag(name: string, isImplied?: boolean): void {
    if (isImplied) {
      // Self-close vs auto-close: see the module docstring. The Parser still
      // has the self-closed tag on top of its own stack at callback time
      // (`Parser.stack` is `private` in htmlparser2's type declarations but a
      // plain documented-shape runtime property; reached via a cast here).
      const parserStackTop = (this.parser as unknown as { stack: string[] } | null)?.stack[0];
      const top = this.top;
      if (parserStackTop === name && top !== this.root && (top as Element).name === name) {
        this.stack.pop();
      }
      this.lastNode = null;
      return;
    }
    // Real end tag: pop to the nearest matching open element (bs4
    // `_popToTag`), closing everything in between; ignore if none matches.
    for (let i = this.stack.length - 1; i >= 1; i--) {
      const el = this.stack[i] as Element;
      if (el.name === name) {
        this.stack.length = i;
        break;
      }
    }
    this.lastNode = null;
  }
}

/** Parse `html` into a domhandler `Document` with Python html.parser tree
 *  semantics (see the module docstring). */
export function parseBs4(html: string): Document {
  const builder = new Bs4TreeBuilder();
  const parser = new Parser(builder, {
    decodeEntities: true,
    // bs4's html.parser honors `<foo/>` as an empty element for ANY tag
    // (handle_startendtag), so recognize self-closing everywhere.
    recognizeSelfClosing: true,
  });
  parser.write(html);
  parser.end();
  return builder.root;
}
