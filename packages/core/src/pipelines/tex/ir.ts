/**
 * IR assembly for the Stage 5 tex pipeline: fuser output → `TexDocIr`
 * (contracts `tex-ir.ts`), validated against the zod schema.
 *
 * Owns the pieces that need the completed tree: figure materialization via
 * the injected `TexFigurePort` (degrades per-figure, never fails), xref
 * preview/heading fill (the reader's link cards), the refs/bib manifests
 * (the skill's article_refs/article_bib JSONL rows), and the
 * title/authors identity extraction.
 *
 * `buildTexDocIr` is async (figure materialization); file writing stays
 * caller-side (`ingestTex` in `pipeline.ts` or the freeze script).
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  BibManifestRow,
  IrBlock,
  IrSection,
  IrSegment,
  Reference,
  RefManifestRow,
  TexDocIr,
  TexIrSource,
} from "@argelanderspace/contracts";
import { TexDocIrSchema } from "@argelanderspace/contracts";
import type * as Ast from "@unified-latex/unified-latex-types";
import { citeShort, segmentsMarkdown, segmentsPlainText } from "../../documents/render.js";
import { parseBbl } from "./facts/bbl.js";
import type { TexFacts } from "./facts/index.js";
import { texFigureAssetSize } from "./fuse/figures.js";
import { buildTexReferences } from "./fuse/references.js";
import { Fuser } from "./fuse/walk.js";
import type { TexFigurePort } from "./ports.js";
import type { TexSourceTree } from "./source/tree.js";
import { envName, printRawNodes } from "./source/tree.js";

const DEFAULT_PREVIEW = 80;
const CONTEXT_LEN = 200;

// \author{} often inlines \thanks{email}/affiliations that flatten into the
// name; cut the name off at the first such tail (ported from the retired
// pipeline.ts AFFIL_RE).
const AFFIL_TAIL_RE =
  /\s*(?:,?\s*E-?mail.*|\bDepartment\b.*|\bDept\b.*|\bInstitut.*|\bUniversit.*|\bObservator.*|\bCentre?\b.*|\b\d{4,}.*)$/is;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line text safe to embed inside a `[... | ...]` segment (no `|[]`). */
function san(s: string): string {
  return s
    .replace(/\s+/gu, " ")
    .replaceAll("|", "/")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim();
}

// --------------------------------------------------------------------------- //
// Figure resolution + materialization
// --------------------------------------------------------------------------- //

/** Extensions tried when \includegraphics omits one (old TRY_EXT order). */
const TRY_EXT = [".pdf", ".png", ".eps", ".jpg", ".jpeg", ".svg"];

/**
 * Locate an \includegraphics argument: as given, then with each known
 * extension, relative to the including file's dir first, then srcDir.
 */
export function resolveFigureSrc(
  tree: TexSourceTree,
  srcDir: string,
  src: string,
  fromFile: string | undefined
): string | undefined {
  const cleaned = src
    .trim()
    .replace(/^"+|"+$/g, "")
    .replaceAll("\\", "/")
    .replace(/\{([^{}]*)\}/g, "$1"); // aastex-style braced path fragments
  const dirs: string[] = [];
  if (fromFile !== undefined) {
    const abs = tree.resolveFile(fromFile);
    if (abs !== undefined) dirs.push(dirname(abs));
  }
  dirs.push(resolve(srcDir));
  for (const dir of dirs) {
    const direct = isAbsolute(cleaned) ? cleaned : join(dir, cleaned);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
    for (const ext of TRY_EXT) {
      const withExt = `${direct}${ext}`;
      if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------- //
// xref preview / heading fill
// --------------------------------------------------------------------------- //

interface TargetLookup {
  blocks: Map<string, IrBlock>;
  sections: Map<string, IrSection>;
}

function buildTargetLookup(sections: IrSection[]): TargetLookup {
  const blocks = new Map<string, IrBlock>();
  const secs = new Map<string, IrSection>();
  const walk = (list: IrSection[]): void => {
    for (const s of list) {
      secs.set(s.id, s);
      for (const b of s.blocks) blocks.set(b.id, b);
      walk(s.children);
    }
  };
  walk(sections);
  return { blocks, sections: secs };
}

function floatPreview(b: IrBlock, preview: number): string {
  if (b.type === "equation") return truncate(san(b.latex), preview);
  if (
    (b.type === "figure" || b.type === "table" || b.type === "code" || b.type === "algorithm") &&
    b.captionSegments !== undefined
  ) {
    return truncate(san(segmentsPlainText(b.captionSegments)), preview);
  }
  return "";
}

function* iterSegments(sections: IrSection[]): Generator<IrSegment> {
  const walkBlocks = function* (blocks: IrBlock[]): Generator<IrSegment> {
    for (const b of blocks) {
      switch (b.type) {
        case "paragraph":
          yield* b.segments;
          break;
        case "list":
          for (const it of b.items) yield* it.segments;
          break;
        case "figure":
        case "table":
        case "code":
        case "algorithm":
          if (b.captionSegments !== undefined) yield* b.captionSegments;
          break;
        default:
          break;
      }
    }
  };
  const walkSecs = function* (secs: IrSection[]): Generator<IrSegment> {
    for (const s of secs) {
      yield* walkBlocks(s.blocks);
      yield* walkSecs(s.children);
    }
  };
  yield* walkSecs(sections);
}

function fillXrefPreviews(sections: IrSection[], lookups: TargetLookup): void {
  for (const seg of iterSegments(sections)) {
    if (seg.type !== "xref" || !seg.target.resolved) continue;
    const t = seg.target;
    const block = lookups.blocks.get(t.id);
    if (block !== undefined) {
      const preview = floatPreview(block, DEFAULT_PREVIEW);
      if (preview !== "") t.preview = preview;
      continue;
    }
    const sec = lookups.sections.get(t.id);
    if (sec !== undefined && sec.heading !== undefined) t.heading = sec.heading;
  }
}

// --------------------------------------------------------------------------- //
// Manifests (ported from documents/ir.ts, operating on the IR directly)
// --------------------------------------------------------------------------- //

function sectionLabel(s: IrSection): string {
  return s.number !== undefined ? `${s.number}:${s.heading ?? ""}` : (s.heading ?? "");
}

function refsManifest(sections: IrSection[]): RefManifestRow[] {
  const rows: RefManifestRow[] = [];
  const flat: { block: IrBlock; section: string }[] = [];
  const walk = (list: IrSection[]): void => {
    for (const s of list) {
      const label = sectionLabel(s);
      const row: RefManifestRow = {
        id: s.id,
        kind: "section",
        content: s.heading ?? "",
        short: s.heading ?? "",
        section: label,
      };
      if (s.number !== undefined) row.number = s.number;
      rows.push(row);
      for (const b of s.blocks) flat.push({ block: b, section: label });
      walk(s.children);
    }
  };
  walk(sections);

  const nearestText = (i: number, dir: -1 | 1): string | undefined => {
    for (let j = i + dir; j >= 0 && j < flat.length; j += dir) {
      const b = flat[j]?.block;
      if (b === undefined) continue;
      if (b.type === "paragraph") {
        return truncate(segmentsMarkdown(b.segments), CONTEXT_LEN);
      }
      if (b.type === "list") {
        return truncate(b.items.map((it) => segmentsMarkdown(it.segments)).join(" "), CONTEXT_LEN);
      }
    }
    return undefined;
  };

  flat.forEach(({ block: b, section }, i) => {
    if (
      b.type !== "figure" &&
      b.type !== "table" &&
      b.type !== "equation" &&
      b.type !== "code" &&
      b.type !== "algorithm"
    ) {
      return;
    }
    const content =
      b.type === "equation"
        ? b.latex
        : "captionSegments" in b && b.captionSegments !== undefined
          ? segmentsMarkdown(b.captionSegments)
          : "";
    const row: RefManifestRow = {
      id: b.id,
      kind: b.type,
      content,
      short: truncate(content, DEFAULT_PREVIEW),
      section,
    };
    if (b.number !== undefined) row.number = b.number;
    const before = nearestText(i, -1);
    if (before !== undefined) row.context_before = before;
    const after = nearestText(i, 1);
    if (after !== undefined) row.context_after = after;
    rows.push(row);
  });
  return rows;
}

function bibManifest(references: Reference[]): BibManifestRow[] {
  return references.map((r) => {
    const row: BibManifestRow = { id: r.id, short: citeShort(r), raw: r.raw };
    if (r.title !== undefined && r.title !== "") row.title = r.title;
    if (r.authors !== undefined && r.authors.length > 0) row.author = r.authors.join(", ");
    if (r.year !== undefined) row.year = r.year;
    if (r.venue !== undefined) row.venue = r.venue;
    if (r.doi !== undefined) row.doi = r.doi;
    if (r.arxiv_id !== undefined) row.arxiv_id = r.arxiv_id;
    return row;
  });
}

// --------------------------------------------------------------------------- //
// Meta extraction (title / authors)
// --------------------------------------------------------------------------- //

/** Find a preamble/body macro by name (top level of the merged root). */
function findTopMacro(tree: TexSourceTree, name: string): Ast.Macro | undefined {
  const inBody = tree.body.find((n): n is Ast.Macro => n.type === "macro" && n.content === name);
  if (inBody !== undefined) return inBody;
  return tree.preamble.find((n): n is Ast.Macro => n.type === "macro" && n.content === name);
}

function findAllTopMacros(tree: TexSourceTree, name: string): Ast.Macro[] {
  const out: Ast.Macro[] = [];
  for (const n of [...tree.preamble, ...tree.body]) {
    if (n.type === "macro" && n.content === name) out.push(n);
  }
  return out;
}

/** Superscript affiliation marker in hand-rolled author blocks: `$^{1,2,\star}$`. */
const SUP_MARKER_RE = /^\s*\^\s*\{([^}]*)\}\s*$/;

/** Leading `$^{N}$` runs in \affil text (rendered through plain/katexify). */
const AFFIL_MARKER_TEXT_RE = /^(?:\s*\$\^\s*\{?[^}$]*\}?\$)+/;

/** Trailing `$^{N}$` runs (a second author's marker glued at a piece's end). */
const AFFIL_MARKER_TAIL_RE = /(?:\s*\$\^\s*\{?[^}$]*\}?\$)+\s*$/;

/** Digit refs inside a superscript-marker inline-math node (skips \star/\dag). */
function supMarkerRefs(n: Ast.Node): number[] | undefined {
  if (n.type !== "inlinemath") return undefined;
  const m = SUP_MARKER_RE.exec(printRawNodes(n.content));
  if (m === null) return undefined;
  const refs = (m[1] ?? "")
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((k) => Number.isInteger(k) && k >= 1);
  return refs;
}

function isSupMarker(n: Ast.Node): boolean {
  return SUP_MARKER_RE.test(n.type === "inlinemath" ? printRawNodes(n.content) : "");
}

function isLineBreak(n: Ast.Node): boolean {
  return n.type === "macro" && n.content === "\\";
}

/** Drop leading `\\` (and surrounding whitespace): after `\and` a chunk may
 *  open with a layout line break, which is not a name/affiliation separator. */
function stripLeadingLineBreaks(chunk: readonly Ast.Node[]): readonly Ast.Node[] {
  let i = 0;
  while (i < chunk.length) {
    const n = chunk[i];
    if (n === undefined) break;
    if (
      isLineBreak(n) ||
      n.type === "whitespace" ||
      (n.type === "string" && n.content.trim() === "")
    ) {
      i++;
    } else {
      break;
    }
  }
  return chunk.slice(i);
}

/** Author-list content up to the first `\\` (hand-rolled blocks glue
 *  affiliation lines after it — names never carry line breaks). A leading
 *  `\\` is layout, not a separator, and is skipped first. */
function truncateAtLineBreak(chunk: readonly Ast.Node[]): Ast.Node[] {
  const out: Ast.Node[] = [];
  for (const n of stripLeadingLineBreaks(chunk)) {
    if (isLineBreak(n)) break;
    out.push(n);
  }
  return out;
}

/** Content after the first (non-leading) `\\`: hand-rolled blocks glue the
 *  affiliation lines there. */
function tailAfterLineBreak(chunk: readonly Ast.Node[]): readonly Ast.Node[] {
  const body = stripLeadingLineBreaks(chunk);
  const idx = body.findIndex(isLineBreak);
  return idx < 0 ? [] : body.slice(idx + 1);
}

/** Split macro-arg content on `\\` (always pushes the final piece). */
function splitOnLineBreaks(content: readonly Ast.Node[]): Ast.Node[][] {
  const pieces: Ast.Node[][] = [];
  let current: Ast.Node[] = [];
  for (const n of content) {
    if (isLineBreak(n)) {
      pieces.push(current);
      current = [];
    } else {
      current.push(n);
    }
  }
  pieces.push(current);
  return pieces;
}

/** Clean one \author chunk: drop affiliation commands + superscript markers,
 *  cut the tail; a `\\` ends the author list (hand-rolled blocks glue the
 *  affiliation lines after it; a leading `\\` is layout and skipped). */
function cleanAuthor(
  nodes: readonly Ast.Node[],
  plain: (ns: readonly Ast.Node[]) => string
): string {
  const kept: Ast.Node[] = [];
  for (const n of stripLeadingLineBreaks(nodes)) {
    if (isLineBreak(n)) break;
    if (isSupMarker(n)) continue;
    if (
      n.type === "macro" &&
      [
        "inst",
        "orcidlink",
        "thanks",
        "email",
        "affiliation",
        "affil",
        "correspondingauthor",
      ].includes(n.content)
    ) {
      continue;
    }
    kept.push(n);
  }
  const s = plain(kept);
  const m = AFFIL_TAIL_RE.exec(s);
  const cut = m !== null && m.index > 0 ? s.slice(0, m.index) : s;
  return cut.replace(/^[ ,;]+|[ ,;]+$/g, "");
}

/** Title (with subtitle) + authors from the merged tree. */
export function extractTexMeta(
  tree: TexSourceTree,
  plain: (ns: readonly Ast.Node[]) => string
): { title?: string; authors?: string[] } {
  const titleMacro = findTopMacro(tree, "title");
  const title =
    titleMacro !== undefined
      ? plain(titleMacro.args?.[titleMacro.args.length - 1]?.content ?? [])
      : "";
  const subtitleMacro = findTopMacro(tree, "subtitle");
  const subtitle =
    subtitleMacro !== undefined
      ? plain(subtitleMacro.args?.[subtitleMacro.args.length - 1]?.content ?? [])
      : "";

  const authors: string[] = [];
  for (const authorMacro of findAllTopMacros(tree, "author")) {
    const content = (authorMacro.args?.[authorMacro.args.length - 1]?.content ?? []) as Ast.Node[];
    // split on \and (multi-author command) — else keep the whole chunk
    const chunks: Ast.Node[][] = [];
    let current: Ast.Node[] = [];
    for (const n of content) {
      if (n.type === "macro" && n.content === "and") {
        chunks.push(current);
        current = [];
      } else {
        current.push(n);
      }
    }
    chunks.push(current);
    for (const chunk of chunks) {
      const a = cleanAuthor(chunk, plain);
      if (a !== "") authors.push(a);
    }
  }

  const out: { title?: string; authors?: string[] } = {};
  const fullTitle = [title, subtitle].filter((t) => t !== "").join(" — ");
  if (fullTitle !== "") out.title = fullTitle;
  if (authors.length > 0) out.authors = authors;
  return out;
}

// --------------------------------------------------------------------------- //
// Author block extraction (Stage 6: affiliations/emails the name list drops)
// --------------------------------------------------------------------------- //

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export interface TexAuthorEntry {
  name: string;
  affiliations?: number[];
  email?: string;
}

export interface TexAuthorBlock {
  authors: TexAuthorEntry[];
  affiliations: string[];
  email?: string;
}

/** Plain text of a macro's last arg, trimmed. */
function macroArgText(m: Ast.Macro, plain: (ns: readonly Ast.Node[]) => string): string {
  return plain(m.args?.[m.args.length - 1]?.content ?? []).trim();
}

/** Split macro-arg content on \and (always pushes the final chunk). */
function splitOnAnd(content: readonly Ast.Node[]): Ast.Node[][] {
  const chunks: Ast.Node[][] = [];
  let current: Ast.Node[] = [];
  for (const n of content) {
    if (n.type === "macro" && n.content === "and") {
      chunks.push(current);
      current = [];
    } else {
      current.push(n);
    }
  }
  chunks.push(current);
  return chunks;
}

/** One author chunk's email: explicit \email{…} first, then \thanks{…}, then
 *  any bare address in the chunk text. */
function chunkEmail(
  chunk: readonly Ast.Node[],
  plain: (ns: readonly Ast.Node[]) => string
): string | undefined {
  for (const name of ["email", "thanks"]) {
    for (const n of chunk) {
      if (n.type === "macro" && n.content === name) {
        const m = EMAIL_RE.exec(macroArgText(n, plain));
        if (m !== null) return m[0];
      }
    }
  }
  return EMAIL_RE.exec(plain(chunk))?.[0];
}

/** Nodes that belong to the author BEFORE the comma when they trail it:
 *  their own superscript markers and \thanks/\email (`Name,$^{1}$\thanks{…},
 *  Next…`). \inst/\orcidlink are excluded — in the dominant A&A style they
 *  lead the NEXT author (`…\inst{1},\n Next\orcidlink{…}\inst{2}`). */
function absorbableAfterComma(n: Ast.Node): boolean {
  return isSupMarker(n) || (n.type === "macro" && ["thanks", "email"].includes(n.content));
}

function hasLinkModifier(chunk: readonly Ast.Node[]): boolean {
  return chunk.some((n) => isSupMarker(n) || (n.type === "macro" && n.content === "inst"));
}

/** Split one author chunk on top-level string commas — A&A style separates
 *  authors with commas when each carries \inst/\orcidlink. Caller guards on
 *  the chunk carrying ≥2 \inst/sup markers, so "Last, First" forms (no
 *  markers) never reach this split. */
function splitOnCommas(chunk: readonly Ast.Node[]): Ast.Node[][] {
  const out: Ast.Node[][] = [];
  let current: Ast.Node[] = [];
  let absorb = false;
  for (const n of chunk) {
    if (n.type === "string" && n.content.includes(",")) {
      const parts = n.content.split(",");
      for (let i = 0; i < parts.length; i++) {
        const text = parts[i] ?? "";
        if (i < parts.length - 1) {
          if (text.trim() !== "") current.push({ ...n, content: text });
          out.push(current);
          absorb = !hasLinkModifier(current);
          current = [];
        } else if (text.trim() !== "") {
          current.push({ ...n, content: text });
          absorb = false;
        }
      }
    } else if (absorb && absorbableAfterComma(n)) {
      (out[out.length - 1] ?? current).push(n);
    } else {
      absorb = false;
      current.push(n);
    }
  }
  out.push(current);
  return out;
}

/** Loose name normalization for matching \correspondingauthor{X} against the
 *  parsed author names (initials/punctuation differences tolerated by the
 *  caller's includes-check). */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** Name suffixes that a comma split may mistake for a standalone author. */
const SUFFIX_TOKEN_RE = /^(?:Jr|Sr|II|III|IV)\.?$/;

/** Merge sub-chunks that are just a name suffix ("John Doe, Jr.$^{1}$")
 *  back into the previous author chunk (review N2). */
function mergeSuffixChunks(
  chunks: Ast.Node[][],
  plain: (ns: readonly Ast.Node[]) => string
): Ast.Node[][] {
  const out: Ast.Node[][] = [];
  for (const c of chunks) {
    if (SUFFIX_TOKEN_RE.test(cleanAuthor(c, plain)) && out.length > 0) {
      (out[out.length - 1] ?? []).push(...c);
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * Structured author block: names + affiliation links + emails. Two mechanical
 * families (roadmap Q12): aa.cls positional (\inst{n} in \author, \institute
 * list split on \and, \email wherever it appears is document-level — aa
 * prints it as the corresponding address without naming the author) and
 * AASTeX/revtex sequential (\affiliation/\affil/\altaffiliation attaches to
 * the whole open author group — every \author since the group was opened;
 * the group closes lazily once an \affiliation has attached and the next
 * \author arrives, so consecutive \affiliation macros stack on the same
 * authors —, \email to the most recent author). Hand-rolled blocks
 * glue affiliation lines after a `\\` inside \author; the tail is parsed as
 * pseudo-\affil pieces. Anything unrecognized degrades to a flat author list
 * (no affiliation links).
 */
export function extractAuthorBlock(
  tree: TexSourceTree,
  plain: (ns: readonly Ast.Node[]) => string
): TexAuthorBlock {
  const institute = findTopMacro(tree, "institute");
  if (institute !== undefined) {
    const instEmails: string[] = [];
    const affiliations = splitOnAnd(institute.args?.[institute.args.length - 1]?.content ?? [])
      .map((chunk) => {
        // \email embedded in an \institute entry is not part of the address
        const kept = chunk.filter((n) => {
          if (n.type === "macro" && n.content === "email") {
            const m = EMAIL_RE.exec(macroArgText(n, plain));
            if (m !== null) instEmails.push(m[0]);
            return false;
          }
          return true;
        });
        return plain(kept).trim();
      })
      .filter((s) => s !== "");
    const authors: TexAuthorEntry[] = [];
    for (const authorMacro of findAllTopMacros(tree, "author")) {
      for (const chunk of splitOnAnd(
        authorMacro.args?.[authorMacro.args.length - 1]?.content ?? []
      )) {
        const truncated = truncateAtLineBreak(chunk);
        const instCount = truncated.filter(
          (n) => n.type === "macro" && n.content === "inst"
        ).length;
        const subChunks = mergeSuffixChunks(
          instCount >= 2 ? splitOnCommas(truncated) : [truncated],
          plain
        );
        for (const sub of subChunks) {
          const name = cleanAuthor(sub, plain);
          if (name === "") continue;
          const refs = new Set<number>();
          for (const n of sub) {
            if (n.type === "macro" && n.content === "inst") {
              for (const part of macroArgText(n, plain).split(",")) {
                const k = Number.parseInt(part.trim(), 10);
                if (Number.isInteger(k) && k >= 1 && k <= affiliations.length) refs.add(k);
              }
            }
          }
          const entry: TexAuthorEntry = { name };
          if (refs.size > 0) entry.affiliations = [...refs].sort((a, b) => a - b);
          const email = chunkEmail(sub, plain);
          if (email !== undefined) entry.email = email;
          authors.push(entry);
        }
      }
    }
    const emailMacro = findTopMacro(tree, "email");
    const topEmail =
      emailMacro !== undefined ? EMAIL_RE.exec(macroArgText(emailMacro, plain))?.[0] : undefined;
    const email = topEmail ?? instEmails[0];
    const out: TexAuthorBlock = { authors, affiliations };
    if (email !== undefined) out.email = email;
    return out;
  }

  const authors: TexAuthorEntry[] = [];
  const affiliations: string[] = [];
  const affIndex = new Map<string, number>(); // normalized text → 1-based index
  // Hand-rolled blocks carry the links as math superscripts (`$^{1,2}$` in
  // \author, `$^{N}$` leading the \affil text). The printed number is not
  // always the appearance index (out-of-order or skipped numbers), so each
  // \affil piece's leading marker is recorded as an explicit
  // printed-number → list-index map; author refs resolve through it after
  // the full affiliation list is known.
  const markerRefs = new Map<TexAuthorEntry, number[]>();
  // Known issue (N9): two pieces printing the same number collide here —
  // the later piece silently wins.
  const printedToIndex = new Map<number, number>();
  // revtex/emulateapj semantics: an \affiliation attaches to the whole open
  // author group. The group closes lazily — only once an affiliation has
  // attached and the next \author arrives — so consecutive \affiliation
  // macros stack on the same authors while \author commands separated by an
  // \affiliation start a new group.
  let currentGroup: TexAuthorEntry[] = [];
  let groupHasAffil = false;
  let lastAuthor: TexAuthorEntry | undefined;
  // \email/\thanks seen before any \author (AASTeX 6.x/7 places
  // \correspondingauthor{X}\email{…} ahead of the author list). Known issue
  // (N8): a pre-author \thanks address goes through the same
  // \correspondingauthor matching, though it names no author.
  const pendingEmails: string[] = [];

  /** One affiliation entry (an \affiliation arg piece or a \author `\\`-tail
   *  piece): dedupe into the list, record its printed marker number, attach
   *  to `targets` (the open group, or the entries of one \author chunk).
   *  A piece that is just an email line routes to the last author instead.
   *  Returns false when the piece produced no affiliation entry. */
  const addAffiliationPiece = (
    piece: readonly Ast.Node[],
    targets: readonly TexAuthorEntry[]
  ): boolean => {
    // \email inside a piece is not part of an address; a piece that is only
    // an email line (macro, or bare address as the whole text) belongs to
    // the most recent author.
    const emailNode = piece.find(
      (pn): pn is Ast.Macro => pn.type === "macro" && pn.content === "email"
    );
    const nodeEmail =
      emailNode !== undefined ? EMAIL_RE.exec(macroArgText(emailNode, plain))?.[0] : undefined;
    const raw = plain(piece);
    const markerRun = AFFIL_MARKER_TEXT_RE.exec(raw)?.[0];
    const text = raw.replace(AFFIL_MARKER_TEXT_RE, "").replace(AFFIL_MARKER_TAIL_RE, "").trim();
    const wholeEmail = EMAIL_RE.exec(text)?.[0];
    const email = nodeEmail ?? (wholeEmail === text ? wholeEmail : undefined);
    if (email !== undefined) {
      if (lastAuthor !== undefined && lastAuthor.email === undefined) lastAuthor.email = email;
      return false;
    }
    if (text === "") return false;
    const norm = text.toLowerCase().replace(/\s+/g, " ");
    let idx = affIndex.get(norm);
    if (idx === undefined) {
      affiliations.push(text);
      idx = affiliations.length;
      affIndex.set(norm, idx);
    }
    if (markerRun !== undefined) {
      for (const d of markerRun.match(/\d+/g) ?? []) {
        printedToIndex.set(Number.parseInt(d, 10), idx);
      }
    } else {
      // Mixed blocks number only some pieces: infer the unnumbered ones as
      // the smallest printed number not taken yet (== appearance order in
      // fully unnumbered blocks).
      let inferred = 1;
      while (printedToIndex.has(inferred)) inferred++;
      printedToIndex.set(inferred, idx);
    }
    for (const a of targets) {
      if (markerRefs.has(a)) continue; // linked via its own superscripts
      a.affiliations = a.affiliations ?? [];
      if (!a.affiliations.includes(idx)) a.affiliations.push(idx);
    }
    return true;
  };

  for (const n of [...tree.preamble, ...tree.body]) {
    if (n.type !== "macro") continue;
    if (n.content === "author") {
      if (groupHasAffil) {
        currentGroup = [];
        groupHasAffil = false;
      }
      for (const chunk of splitOnAnd(n.args?.[n.args.length - 1]?.content ?? [])) {
        const truncated = truncateAtLineBreak(chunk);
        const supCount = truncated.filter((cn) => isSupMarker(cn)).length;
        const subChunks = mergeSuffixChunks(
          supCount >= 2 ? splitOnCommas(truncated) : [truncated],
          plain
        );
        const chunkEntries: TexAuthorEntry[] = [];
        for (const sub of subChunks) {
          const name = cleanAuthor(sub, plain);
          if (name === "") continue;
          const entry: TexAuthorEntry = { name };
          const refs = [...new Set(sub.flatMap((cn) => supMarkerRefs(cn) ?? []))];
          // Authors carrying ANY superscript marker resolve through their
          // own refs (possibly non-numeric, e.g. `$^{\star}$` → no numeric
          // refs) and must not absorb group affiliations.
          if (refs.length > 0 || sub.some((cn) => isSupMarker(cn))) {
            markerRefs.set(entry, refs);
          }
          const email = chunkEmail(sub, plain);
          if (email !== undefined) entry.email = email;
          authors.push(entry);
          currentGroup.push(entry);
          chunkEntries.push(entry);
          lastAuthor = entry;
        }
        // Hand-rolled blocks glue the affiliation lines after a `\\` inside
        // \author: parse the tail as pseudo-\affil pieces. They attach to
        // THIS chunk's authors, not the whole open group (a chunk's tail is
        // that chunk's own affiliation line). Known issue (N7): a chunk
        // holding only `\\`-glued affiliations (`\author{ \\ Inst X}`) is
        // indistinguishable from a layout break and yields no author.
        const tail = tailAfterLineBreak(chunk);
        if (tail.length > 0) {
          for (const piece of splitOnLineBreaks(tail)) {
            if (addAffiliationPiece(piece, chunkEntries)) groupHasAffil = true;
          }
        }
      }
    } else if (["affiliation", "affil", "altaffiliation"].includes(n.content)) {
      // hand-rolled blocks pack several entries into one arg, \\-separated
      for (const piece of splitOnLineBreaks(n.args?.[n.args.length - 1]?.content ?? [])) {
        if (addAffiliationPiece(piece, currentGroup)) groupHasAffil = true;
      }
    } else if (n.content === "email" || n.content === "thanks") {
      const m = EMAIL_RE.exec(macroArgText(n, plain))?.[0];
      if (m === undefined) continue;
      if (lastAuthor !== undefined) {
        if (lastAuthor.email === undefined) lastAuthor.email = m;
      } else {
        pendingEmails.push(m);
      }
    }
  }
  for (const [entry, refs] of markerRefs) {
    const linked = [
      ...new Set(
        refs
          .map((k) => printedToIndex.get(k) ?? (k <= affiliations.length ? k : undefined))
          .filter((k): k is number => k !== undefined)
      ),
    ].sort((a, b) => a - b);
    if (linked.length > 0) entry.affiliations = linked;
  }
  let docEmail: string | undefined;
  const [firstPending, ...extraPending] = pendingEmails;
  if (firstPending !== undefined) {
    // Attach to the author named by \correspondingauthor: exact normalized
    // match first; otherwise token-level containment (either direction)
    // only when it singles out exactly one author — anything looser
    // mis-attaches (`{Wang}` with two Wangs, `{B.}` matching every "b").
    // No unique match → the address stays document-level.
    const corr = findTopMacro(tree, "correspondingauthor");
    const corrName = corr !== undefined ? normalizeName(macroArgText(corr, plain)) : "";
    let target: TexAuthorEntry | undefined;
    if (corrName !== "") {
      const exact = authors.filter((a) => normalizeName(a.name) === corrName);
      if (exact.length > 0) {
        target = exact[0];
      } else {
        const corrTokens = new Set(corrName.split(" ").filter((t) => t !== ""));
        const contained = authors.filter((a) => {
          const tokens = new Set(
            normalizeName(a.name)
              .split(" ")
              .filter((t) => t !== "")
          );
          const sub = [...corrTokens].every((t) => tokens.has(t));
          const sup = [...tokens].every((t) => corrTokens.has(t));
          return sub || sup;
        });
        if (contained.length === 1) target = contained[0];
      }
    }
    if (target !== undefined) {
      if (target.email === undefined) target.email = firstPending;
    } else {
      docEmail = firstPending;
    }
  }
  // Further pre-author emails never evaporate: first spare lands at the
  // document level when nothing else did.
  if (docEmail === undefined && extraPending.length > 0) docEmail = extraPending[0];
  const out: TexAuthorBlock = { authors, affiliations };
  if (docEmail !== undefined) out.email = docEmail;
  return out;
}

// --------------------------------------------------------------------------- //
// buildTexDocIr
// --------------------------------------------------------------------------- //

export interface BuildTexDocIrInput {
  tree: TexSourceTree;
  facts: TexFacts;
  docId: string;
  source: TexIrSource;
  /** Engine that produced the artifacts (meta.identity). */
  engine?: string;
  /** Whether the instrumentation event stream exists (else fallback numbering). */
  eventsAvailable: boolean;
  figures?: TexFigurePort;
  /** Assets dir for materialized figures; absent = figures degrade. */
  assetsDir?: string;
  srcDir: string;
  renderProfile?: "writer";
}

export interface BuildTexDocIrResult {
  ir: TexDocIr;
  warnings: string[];
  sourceSpans: ReturnType<Fuser["run"]>["sourceSpans"];
  equationRows: ReturnType<Fuser["run"]>["equationRows"];
  labelTargets: ReturnType<Fuser["run"]>["labelTargets"];
}

export async function buildTexDocIr(input: BuildTexDocIrInput): Promise<BuildTexDocIrResult> {
  // Inline-\begin{thebibliography} fallback when no .bbl exists (the old
  // pipeline's inline path): the env's raw text parses with the facts parser.
  let facts = input.facts;
  if (facts.references.length === 0) {
    const bibEnv = input.tree.body.find(
      (n) => (n.type === "environment" || n.type === "mathenv") && envName(n) === "thebibliography"
    );
    if (bibEnv !== undefined) {
      const parsed = parseBbl(printRawNodes([bibEnv]));
      facts = {
        ...facts,
        references: parsed.references,
        warnings: [...facts.warnings, ...parsed.warnings],
      };
    }
  }
  const { references, keyToRefId } = buildTexReferences(facts);
  const fuser = new Fuser({
    tree: input.tree,
    facts,
    references,
    keyToRefId,
    eventsAvailable: input.eventsAvailable,
    unexpandableMacros: input.tree.unexpandableMacros,
    ...(input.renderProfile ? { renderProfile: input.renderProfile } : {}),
  });
  const fused = fuser.run();
  const warnings = [...input.tree.warnings, ...input.facts.warnings, ...fused.warnings];

  // figure materialization (degrades per-figure, never fails)
  if (input.figures !== undefined && input.assetsDir !== undefined) {
    for (const job of fused.figureJobs) {
      const block = fused.figureBlocks.get(job.blockId);
      if (block === undefined) continue;
      const src = resolveFigureSrc(input.tree, input.srcDir, job.src, job.fromFile);
      if (src === undefined) {
        warnings.push(`figure source not found: ${job.src}`);
        continue;
      }
      const r = await input.figures.materialize({
        src,
        srcDir: resolve(input.srcDir),
        destDir: input.assetsDir,
      });
      if (r.ok) {
        block.imgPath = r.file;
        const size = texFigureAssetSize(resolve(input.assetsDir, r.file));
        if (size !== undefined) {
          block.imgWidth = size.w;
          block.imgHeight = size.h;
        }
      } else {
        warnings.push(`figure ${job.src}: ${r.reason}`);
      }
    }
  } else if (fused.figureJobs.length > 0) {
    warnings.push("no figure port wired: figures keep blocks+captions without images");
  }

  const lookups = buildTargetLookup(fused.sections);
  fillXrefPreviews(fused.sections, lookups);

  const meta = extractTexMeta(input.tree, (ns) => fuser.plainText(ns));
  const authorBlock = extractAuthorBlock(input.tree, (ns) => fuser.plainText(ns));

  const ir: TexDocIr = {
    version: 1,
    docId: input.docId,
    sections: fused.sections,
    refsManifest: refsManifest(fused.sections),
    bib: bibManifest(references),
    citationsByBlock: fused.citationsByBlock,
    source: input.source,
    meta: {},
  };
  if (meta.title !== undefined) {
    ir.title = meta.title;
    ir.meta.title = meta.title;
  }
  if (meta.authors !== undefined) ir.meta.authors = meta.authors;
  if (authorBlock.authors.length > 0) ir.meta.authorDetails = authorBlock.authors;
  if (authorBlock.affiliations.length > 0) ir.meta.affiliations = authorBlock.affiliations;
  if (authorBlock.email !== undefined) ir.meta.email = authorBlock.email;
  if (input.engine !== undefined) ir.meta.engine = input.engine;
  if (references.length > 0) ir.references = references;

  const parsed = TexDocIrSchema.safeParse(ir);
  if (!parsed.success) {
    throw new Error(`built IR failed TexDocIrSchema validation: ${parsed.error.message}`);
  }
  return {
    ir: parsed.data,
    warnings,
    sourceSpans: fused.sourceSpans,
    equationRows: fused.equationRows,
    labelTargets: fused.labelTargets,
  };
}
