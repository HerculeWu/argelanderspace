/**
 * Deterministic, mechanical pre-pandoc rewrite of the AASTeX table
 * environments pandoc's LaTeX reader degrades (Stage 3.1, design decision #8).
 *
 * - `deluxetable` / `deluxetable*` → `table` wrapping `tabular`:
 *   `\tablecaption{…}` → `\caption{…}` (an inner `\label` is kept; a
 *   standalone `\label{…}` elsewhere in the environment is folded into the
 *   caption), `\tablehead{…}` (a sequence of `\colhead{…}` cells, possibly
 *   several rows) → the tabular header row(s), `\startdata` / `\enddata`
 *   deleted, `\tablecomments{…}` / `\tablenotetext{m}{…}` / `\tablerefs{…}`
 *   → trailing paragraphs after the table (content is never dropped), and
 *   the formatting-only commands (`\tabletypesize`, `\tablewidth`,
 *   `\tablenum`, `\tablecolumns`, `\rotate`, `\centering`, `\vspace`) dropped.
 *   `\tableline` (the deluxetable rule alias) → `\hline`.
 * - `table*` → `table` (pandoc keeps the tabular of the starred env but
 *   drops its caption/label; the unstarred env parses fine).
 *
 * Pure text transforms with the rules fixed in code — no LLM, no heuristics
 * beyond the grammar above. The rewritten text is only fed to pandoc; the
 * original source on disk is never modified.
 */

/** `(inner, index-after-matching-hi)` when `s[i] === "{"`, else undefined. */
function balancedBraces(s: string, i: number): [inner: string, next: number] | undefined {
  if (i >= s.length || s[i] !== "{") return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") {
      depth += 1;
    } else if (s[j] === "}") {
      depth -= 1;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  return undefined;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
  return i;
}

interface CmdMatch {
  /** Offset of the `\` starting the command. */
  start: number;
  /** Offset just past the closing `}` of the last argument. */
  end: number;
  /** Optional `[…]` argument (without brackets). */
  opt?: string;
  /** Balanced `{…}` argument inners. */
  args: string[];
}

/** First `\cmd[opt]{a1}…{aN}` at/after `from`; undefined when absent/malformed. */
function findCommand(s: string, cmd: string, nArgs: number, from = 0): CmdMatch | undefined {
  const re = new RegExp(`\\\\${cmd}(?![a-zA-Z])`, "g");
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return undefined;
  let i = skipWs(s, m.index + m[0].length);
  let opt: string | undefined;
  if (s[i] === "[") {
    const close = s.indexOf("]", i + 1);
    if (close === -1) return undefined;
    opt = s.slice(i + 1, close);
    i = skipWs(s, close + 1);
  }
  const args: string[] = [];
  for (let k = 0; k < nArgs; k++) {
    if (s[i] !== "{") return undefined;
    const bal = balancedBraces(s, i);
    if (bal === undefined) return undefined;
    args.push(bal[0]);
    // `end` stays right after the closing brace — whitespace BETWEEN the
    // command's own args is ours to skip, trailing whitespace is not.
    i = k + 1 < nArgs ? skipWs(s, bal[1]) : bal[1];
  }
  const out: CmdMatch = { start: m.index, end: i, args };
  if (opt !== undefined) out.opt = opt;
  return out;
}

/** All occurrences of `\cmd{…×n}`, in source order. */
function findCommands(s: string, cmd: string, nArgs: number): CmdMatch[] {
  const out: CmdMatch[] = [];
  let from = 0;
  for (;;) {
    const m = findCommand(s, cmd, nArgs, from);
    if (!m) return out;
    out.push(m);
    from = m.end;
  }
}

function removeSpan(s: string, m: CmdMatch): string {
  return s.slice(0, m.start) + s.slice(m.end);
}

// --------------------------------------------------------------------------- //
// deluxetable → table + tabular
// --------------------------------------------------------------------------- //

const DELUXE_BEGIN_RE = /\\begin\{deluxetable\*?\}/g;
const DELUXE_END_RE = /\\end\{deluxetable\*?\}/g;

/** `\colhead{…}` cells → their bare contents (keeps `&` / `\\` separators). */
function unwrapColheads(head: string): string {
  let out = "";
  let cursor = 0;
  for (const m of findCommands(head, "colhead", 1)) {
    out += head.slice(cursor, m.start) + (m.args[0] ?? "");
    cursor = m.end;
  }
  return out + head.slice(cursor);
}

/** One deluxetable environment body → table + tabular + trailing paragraphs. */
function convertDeluxe(colspec: string, body0: string): string {
  let body = body0;

  // \tablecaption[…]{…} → \caption[…]{…}
  let caption: string | undefined;
  const cap = findCommand(body, "tablecaption", 1);
  if (cap !== undefined) {
    const opt = cap.opt !== undefined ? `[${cap.opt}]` : "";
    caption = `\\caption${opt}{${cap.args[0] ?? ""}}`;
    body = removeSpan(body, cap);
  }

  // A standalone \label outside the caption belongs to the float: fold it in
  // (unless the caption already carries one — then leave the extra untouched).
  const capHasLabel = caption !== undefined && /\\label\s*\{/.test(caption);
  if (!capHasLabel) {
    const lab = findCommand(body, "label", 1);
    if (lab !== undefined) {
      const tag = `\\label{${lab.args[0] ?? ""}}`;
      caption =
        caption !== undefined
          ? caption.replace(/\}$/, `${tag}}`) // inside the braces
          : `\\caption{${tag}}`;
      body = removeSpan(body, lab);
    }
  }

  // \tablehead{ \colhead{A} & \colhead{B} \\ … } → tabular header row(s)
  let header = "";
  const head = findCommand(body, "tablehead", 1);
  if (head !== undefined) {
    header = unwrapColheads(head.args[0] ?? "");
    body = removeSpan(body, head);
  }

  // \tablecomments / \tablerefs / \tablenotetext → trailing paragraphs after
  // the table, in source order (content preserved, formatting degraded).
  const trailing: Array<{ start: number; text: string }> = [];
  for (const m of findCommands(body, "tablecomments", 1)) {
    trailing.push({ start: m.start, text: (m.args[0] ?? "").trim() });
  }
  for (const m of findCommands(body, "tablerefs", 1)) {
    trailing.push({ start: m.start, text: (m.args[0] ?? "").trim() });
  }
  for (const m of findCommands(body, "tablenotetext", 2)) {
    trailing.push({ start: m.start, text: `(${m.args[0] ?? ""}) ${(m.args[1] ?? "").trim()}` });
  }
  for (const cmd of ["tablecomments", "tablerefs"]) {
    for (const m of findCommands(body, cmd, 1)) body = removeSpan(body, m);
  }
  for (const m of findCommands(body, "tablenotetext", 2)) body = removeSpan(body, m);

  // Formatting-only commands and delimiters: dropped / aliased.
  for (const cmd of ["tabletypesize", "tablewidth", "tablenum", "tablecolumns", "vspace"]) {
    for (const m of findCommands(body, cmd, 1)) body = removeSpan(body, m);
  }
  body = body.replace(/\\(?:rotate|centering)(?![a-zA-Z])/g, "");
  body = body.replace(/\\(?:startdata|enddata)(?![a-zA-Z])/g, "");
  body = body.replace(/\\tableline(?![a-zA-Z])/g, "\\hline");
  header = header.replace(/\\tableline(?![a-zA-Z])/g, "\\hline");

  const parts = ["\\begin{table}"];
  if (caption !== undefined) parts.push(caption);
  parts.push(`\\begin{tabular}{${colspec}}`);
  const headerRow = header.trim();
  if (headerRow) {
    // `\startdata` doubled as the header's row terminator — once deleted the
    // header must end in `\\` or it merges into the first data row (and
    // pandoc stops seeing a tabular at all).
    parts.push(/\\\\\s*$/.test(headerRow) ? headerRow : `${headerRow} \\\\`);
  }
  const data = body.trim();
  if (data) parts.push(data);
  parts.push("\\end{tabular}", "\\end{table}");

  const paras = trailing
    .sort((a, b) => a.start - b.start)
    .map((t) => t.text)
    .filter((t) => t.length > 0);
  return parts.join("\n") + (paras.length > 0 ? `\n\n${paras.join("\n\n")}\n` : "\n");
}

function rewriteDeluxeTables(src: string): string {
  let out = "";
  let cursor = 0;
  let changed = false;
  DELUXE_BEGIN_RE.lastIndex = 0;
  for (;;) {
    const m = DELUXE_BEGIN_RE.exec(src);
    if (!m) break;
    // optional […] then the mandatory {colspec}
    let i = skipWs(src, m.index + m[0].length);
    if (src[i] === "[") {
      const close = src.indexOf("]", i + 1);
      if (close !== -1) i = skipWs(src, close + 1);
    }
    const spec = src[i] === "{" ? balancedBraces(src, i) : undefined;
    if (spec === undefined) continue; // not a real begin — leave as-is
    DELUXE_END_RE.lastIndex = spec[1];
    const e = DELUXE_END_RE.exec(src);
    if (!e) break; // unbalanced environment — leave the rest untouched
    out += src.slice(cursor, m.index);
    out += convertDeluxe(spec[0], src.slice(spec[1], e.index));
    changed = true;
    cursor = e.index + e[0].length;
    DELUXE_BEGIN_RE.lastIndex = cursor;
  }
  return changed ? out + src.slice(cursor) : src;
}

// --------------------------------------------------------------------------- //
// table* → table
// --------------------------------------------------------------------------- //

function rewriteStarTables(src: string): string {
  if (!/\\(?:begin|end)\{table\*\}/.test(src)) return src;
  return src
    .replace(
      /\\begin\{table\*\}(\s*\[[^\]]*\])?/g,
      (_m, opt: string | undefined) => `\\begin{table}${opt ?? ""}`
    )
    .replace(/\\end\{table\*\}/g, "\\end{table}");
}

/**
 * Rewrite the AASTeX table constructs pandoc degrades. Returns the input
 * unchanged (`===`) when nothing matched, so the caller can skip the
 * temp-file dance entirely for non-AASTeX sources.
 */
export function preprocessAastex(src: string): string {
  return rewriteStarTables(rewriteDeluxeTables(src));
}
