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

/** Clean one \author chunk: drop affiliation commands, cut the tail. */
function cleanAuthor(
  nodes: readonly Ast.Node[],
  plain: (ns: readonly Ast.Node[]) => string
): string {
  const kept = nodes.filter(
    (n) =>
      !(
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
      )
  );
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
}

export interface BuildTexDocIrResult {
  ir: TexDocIr;
  warnings: string[];
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
  if (input.engine !== undefined) ir.meta.engine = input.engine;
  if (references.length > 0) ir.references = references;

  const parsed = TexDocIrSchema.safeParse(ir);
  if (!parsed.success) {
    throw new Error(`built IR failed TexDocIrSchema validation: ${parsed.error.message}`);
  }
  return { ir: parsed.data, warnings };
}
