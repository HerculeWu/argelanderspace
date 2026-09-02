import { marked } from "marked";
import { renderMathToString } from "./math";

// Markdown with $…$/$$…$$ math, for task notes (Stage 4). The pipeline's
// order matters at every step:
//
// 1. PROTECT literal-dollar zones (code): inside fenced code blocks
//    (``` and ~~~) and inline code spans (single- or multi-backtick) a `$`
//    is literal text, swapped to a \u0001 sentinel BEFORE the math pass —
//    marked renders code itself and the sentinel rides through untouched
//    (verified: code content is not percent-encoded), swapped back at the
//    very end.
// 2. STASH URL constructs that carry `$`: marked percent-encodes any
//    non-ASCII (probe: \uE000 → %EE%80%80) in every href it emits, so NO
//    sentinel can survive inside a URL — instead the destination text is
//    swapped for a per-run token that marked lexes as a clean URL, and the
//    raw destination is slotted back after parsing:
//    - inline link / image destinations `[t](dest)` / `![a](dest)`: only the
//      DEST is stashed — marked still builds the <a>/<img>, and link VISIBLE
//      text stays in the normal flow so `[公式 $x$](url)` keeps its math;
//    - reference-definition destinations `[label]: dest`: the token becomes
//      the registered href, use sites resolve normally, restore fixes href;
//    - angle autolinks `<scheme://…>` and bare https?:// URLs with a `$`:
//      the whole construct is stashed and hand-rendered back as <a> (marked
//      would autolink the raw URL; the token form restores verbatim).
//    Only constructs containing `$` are stashed — everything else flows
//    through marked natively.
// 3. STASH math spans (texmath boundary rules, pandoc's): the opening `$`
//    needs a non-space to its right and no `\` to its left (else `\$5`), the
//    closing `$` a non-space to its left and no digit or `$` to its right
//    (the digit rule keeps currency like `$100 到 $200` as text). Tokens
//    carry the per-run entropy suffix too, so a user-typed @@PLAN-…@@ can't
//    collide with a live slot.
// 4. marked runs on the remainder (running it first would let it chew on the
//    `*` / `_` / `\` inside the math); KaTeX output, then the raw URL slots,
//    then the code sentinel, are restored in that order.
//
// Not sanitized on purpose — single-user local tool, the note is the user's
// own input (same ruling as the prototype).

const FENCE_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1(?!`)/g;
const IMAGE_DEST_RE = /(!\[[^\]\n]*\]\(\s*)(<[^>\n]*>|[^\s)\n]+)/g;
const LINK_DEST_RE = /(\[[^\]\n]+\]\(\s*)(<[^>\n]*>|[^\s)\n]+)/g;
const REF_DEF_RE = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|[^\s\n]+)/gm;
const ANGLE_AUTOLINK_RE = /<((?:https?|ftp):\/\/[^\s<>]*)>/g;
const BARE_URL_RE = /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~])/g;
const MATH_RE =
  /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;

const SENTINEL = "\u0001";

/** "raw": the token sits where marked emits an href/src — restore verbatim
 *  (attribute-escaped). "link": the whole construct was stashed — restore as
 *  a hand-rendered <a> (angle autolinks / bare URLs). */
type LinkSlot = { kind: "raw"; raw: string } | { kind: "link"; href: string; text: string };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

export function mdWithMath(src: string): string {
  if (!src || !src.trim()) return "";
  const run = Math.random().toString(36).slice(2, 10);

  // 1. code zones: literal `$` → sentinel
  const protect = (zone: string) => zone.replace(/\$/g, SENTINEL);
  let s = src.replace(FENCE_RE, protect).replace(INLINE_CODE_RE, protect);

  // 2. URL constructs carrying `$` → stash
  const linkSlots: LinkSlot[] = [];
  const stashLink = (slot: LinkSlot) => {
    linkSlots.push(slot);
    return `@@PLAN-LINK-${run}-${linkSlots.length - 1}@@`;
  };
  const stashDest = (m: string, prefix: string, dest: string): string => {
    const raw = dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest;
    if (!raw.includes("$")) return m;
    return `${prefix}${stashLink({ kind: "raw", raw })}`;
  };
  s = s
    .replace(IMAGE_DEST_RE, stashDest)
    .replace(LINK_DEST_RE, stashDest)
    .replace(REF_DEF_RE, stashDest)
    .replace(ANGLE_AUTOLINK_RE, (m, url: string) =>
      url.includes("$") ? stashLink({ kind: "link", href: url, text: url }) : m
    )
    .replace(BARE_URL_RE, (m, url: string) =>
      url.includes("$") ? stashLink({ kind: "link", href: url, text: url }) : m
    );

  // 3. math spans → stash
  const mathSlots: string[] = [];
  s = s.replace(MATH_RE, (_m, display: string | undefined, inline: string | undefined) => {
    const latex = (display ?? inline ?? "").trim();
    mathSlots.push(renderMathToString(latex, display !== undefined));
    return `@@PLAN-MATH-${run}-${mathSlots.length - 1}@@`;
  });

  // 4. marked
  let html = marked.parse(s, { async: false, gfm: true, breaks: true });

  // 5. restore: KaTeX → URL slots → code sentinel
  html = html.replace(
    new RegExp(`@@PLAN-MATH-${run}-(\\d+)@@`, "g"),
    (_m, i: string) => mathSlots[Number(i)] ?? ""
  );
  html = html.replace(
    new RegExp(`@@PLAN-LINK-${run}-(\\d+)@@`, "g"),
    (_m, i: string) => {
      const slot = linkSlots[Number(i)];
      if (!slot) return "";
      return slot.kind === "raw"
        ? escapeAttr(slot.raw)
        : `<a href="${escapeAttr(slot.href)}">${escapeHtml(slot.text)}</a>`;
    }
  );
  return html.split(SENTINEL).join("$");
}
