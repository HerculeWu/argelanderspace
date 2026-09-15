/**
 * Stage 10 Writer — LaTeX source field with syntax highlighting.
 *
 * Zero-dependency overlay approach (added after the 2026-09-15 UI review):
 * the real <textarea> keeps all existing behavior (caret tracking for
 * \cite/\label insertion, Shift+Enter commit, tests querying
 * textarea[data-field="source"]) but renders its text transparent over an
 * absolutely-positioned <pre> that shows the highlighted copy. The two share
 * identical font metrics via .w-src-highlight / .w-src-textarea in writer.css.
 *
 * During IME composition the textarea text color is restored (the `.composing`
 * class) so the composition preview stays visible.
 */

import { useMemo, useRef, useState } from "react";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Tokenizer, one combined pass (order: comment swallows the rest of the line;
 * \begin/\end{env} before bare commands; inline $…$ / \(…\) math; braces).
 * Operates on the RAW source and escapes per piece, so positions never drift.
 */
const TOK_RE =
  /(%[^\n]*)|(\\(?:begin|end)\s*\{[^}]*\})|(\\[a-zA-Z]+\*?)|([{}])|((?<!\\)\$[^$\n]*?(?<!\\)\$|\\\([\s\S]*?\\\))/g;

export function highlightLatexToHtml(source: string): string {
  let out = "";
  let last = 0;
  for (const m of source.matchAll(TOK_RE)) {
    const i = m.index ?? 0;
    out += escapeHtml(source.slice(last, i));
    const cls = m[1] !== undefined
      ? "w-tok-com"
      : m[2] !== undefined
        ? "w-tok-env"
        : m[3] !== undefined
          ? "w-tok-cmd"
          : m[4] !== undefined
            ? "w-tok-brace"
            : "w-tok-math";
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = i + m[0].length;
  }
  out += escapeHtml(source.slice(last));
  // a trailing newline is invisible in the pre but consumes a textarea row
  return out.endsWith("\n") ? `${out} ` : out;
}

export function LatexSourceField({
  textareaProps,
  value,
}: {
  /** props from the cell editor's useField().textProps("source") helper. */
  textareaProps: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
  value: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [composing, setComposing] = useState(false);
  const html = useMemo(() => highlightLatexToHtml(value), [value]);

  return (
    <div className="w-src-wrap">
      <pre
        ref={preRef}
        className="w-src-highlight"
        aria-hidden="true"
        // highlighted copy of our own textarea content; escaped above.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        {...textareaProps}
        className={`w-tall w-src-textarea${composing ? " composing" : ""}`}
        onScroll={(e) => {
          const pre = preRef.current;
          if (pre) {
            pre.scrollTop = e.currentTarget.scrollTop;
            pre.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        onCompositionStart={(e) => {
          setComposing(true);
          textareaProps.onCompositionStart?.(e);
        }}
        onCompositionEnd={(e) => {
          setComposing(false);
          textareaProps.onCompositionEnd?.(e);
        }}
      />
    </div>
  );
}
