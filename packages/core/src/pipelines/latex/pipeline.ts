/**
 * End-to-end arXiv-LaTeX -> structured JSON ingestion pipeline
 * (`bibgraph/pipeline_latex.py`).
 *
 *     arXiv id / URL / local .tex
 *      ├─ acquire       -> e-print tarball, unpacked (cached on disk)   [port]
 *      ├─ pandoc        -> LaTeX document AST (macros expanded, \input followed) [port]
 *      ├─ references    -> .bbl / thebibliography / .bib(CSL)  + key->ref-id map
 *      ├─ walk          -> section tree + floats + equations; citations/cross-refs
 *      │                   tokenised AUTHORITATIVELY from \cite keys / \ref labels
 *      ├─ annotate      -> regex fallback for any *unlinked* mention
 *      └─ index/stats   -> same Document shape the PDF/HTML pipelines emit
 *     -> Document -> <out_root>/<doc_id>/<doc_id>.json
 *
 * Figures (vector PDF/EPS) are rasterised to PNG and served via /images, exactly
 * like the other pipelines, so the reader UI works unchanged. The side-effecting
 * capabilities (pandoc, arXiv acquisition, rasterization) arrive as injected
 * {@link LatexPipelinePorts}; infra wires the real adapters.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Document } from "@argelanderspace/contracts";
import type { Match } from "../../documents/annotate.js";
import { applyMatches } from "../../documents/annotate.js";
import { detectCitations, ReferenceResolver } from "../../documents/citations.js";
import { detectCrossrefs, XrefIndex } from "../../documents/crossrefs.js";
import { annotatable, documentToJson } from "../../documents/document.js";
import { pyRe, stripChars } from "../../documents/pyregex.js";
import { iterBlocks } from "../../documents/traverse.js";
import { preprocessAastex } from "./aastex.js";
import { AssetResolver } from "./assets.js";
import { readTextLossy } from "./fs-util.js";
import {
  DEFAULT_LATEX_CONFIG,
  type LatexPipelineConfig,
  type LatexPipelinePorts,
} from "./ports.js";
import { buildReferences } from "./references.js";
import { Walker } from "./walk.js";

// \cite/\citep/\citet[..][..]{key1,key2} — used to harvest keys from raw source.
const RAW_CITE_RE = /\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;

export interface IngestLatexOptions {
  /** Pipeline output root (Python `out_root`, default "data/output"). */
  outRoot?: string;
  /** `LatexConfig` overrides; defaults come from `bibgraph/config.py`. */
  config?: Partial<LatexPipelineConfig>;
  /** Write `<out_root>/<doc_id>/<doc_id>.json` (Python `write_json`). */
  writeJson?: boolean;
  /**
   * Fixed doc id, short-circuiting the source-derived `docIdFor` — the web
   * upload path pins `upload-<slug>-<hash>` so a re-upload overwrites the same
   * doc instead of deriving a fresh id from the unpacked tree.
   */
  docId?: string;
}

export async function ingestLatex(
  source: string,
  ports: LatexPipelinePorts,
  opts: IngestLatexOptions = {}
): Promise<Document> {
  const config: LatexPipelineConfig = { ...DEFAULT_LATEX_CONFIG, ...opts.config };
  if (!ports.pandoc.havePandoc()) {
    throw new Error("pandoc is required for the LaTeX pipeline but was not found on PATH.");
  }
  // Hard version floor — an old pandoc parses "successfully" but silently
  // degrades the AST, so this must fail before any real work.
  ports.pandoc.assertPandocVersion?.();
  const outRoot = opts.outRoot ?? "data/output";
  mkdirSync(outRoot, { recursive: true });

  const src = await ports.acquire(source, outRoot, config, opts.docId);

  const raw = readTextLossy(src.mainTex);
  // AASTeX table environments pandoc degrades (deluxetable, table*) are
  // rewritten to plain table/tabular before pandoc sees the source — a
  // deterministic mechanical transform (aastex.ts). pandoc reads files, so
  // the rewrite goes to a temp file NEXT TO main.tex (\input includes must
  // still resolve); the on-disk source is never touched.
  const rewritten = preprocessAastex(raw);
  const astPath =
    rewritten === raw ? src.mainTex : join(src.srcDir, `.aastex-${basename(src.mainTex)}`);
  if (astPath !== src.mainTex) writeFileSync(astPath, rewritten, "utf-8");
  let ast: Record<string, unknown>;
  try {
    ast = ports.pandoc.latexToAst(astPath);
  } catch (e) {
    throw new Error(
      `pandoc could not parse ${basename(src.mainTex)}: ${e}. The source may ` +
        "use a class/macro pandoc's LaTeX reader does not support.",
      { cause: e }
    );
  } finally {
    if (astPath !== src.mainTex) rmSync(astPath, { force: true });
  }

  const meta = (ast.meta ?? {}) as Record<string, unknown>;
  // Cite keys from the AST, plus any only in the raw source (e.g. inside an A&A
  // command-style \abstract{} that pandoc drops) so the .bib path keeps them.
  const citedOrder = collectCiteKeys(ast);
  const seen = new Set(citedOrder);
  for (const m of raw.matchAll(RAW_CITE_RE)) {
    for (const x of (m[1] ?? "").split(",")) {
      const key = x.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        citedOrder.push(key);
      }
    }
  }
  const { references, keyToRefId } = buildReferences(
    src.mainTex,
    src.srcDir,
    raw,
    citedOrder,
    ports.pandoc
  );

  const outDir = join(outRoot, src.docId);
  const assetDir = join(outDir, "assets");
  mkdirSync(outDir, { recursive: true });
  const assets = new AssetResolver(src.srcDir, assetDir, {
    dpi: config.figureDpi,
    maxPx: config.figureMaxPx,
    enabled: config.downloadAssets,
    raster: ports.raster,
  });

  const walker = new Walker({
    references,
    keyToRefId,
    assets,
    srcDir: src.srcDir,
    meta,
    pandoc: ports.pandoc,
  });
  const sections = walker.run(ast, raw);

  let title = metaText(meta, "title");
  const subtitle = metaText(meta, "subtitle");
  if (title && subtitle) {
    title = `${title} — ${subtitle}`;
  }

  const doc: Document = {
    doc_id: src.docId,
    source: {
      type: "latex",
      path: src.origin,
      filename: basename(src.mainTex),
      arxiv_id: src.arxivId ?? undefined,
      url: src.arxivId ? src.origin : undefined,
    },
    meta: {
      title: title ?? "",
      latex: {
        engine: "pandoc",
        main_tex: basename(src.mainTex),
        authors: metaList(meta, "author"),
      },
    },
    structure: sections,
    references,
  };

  annotateDocument(doc, walker);

  const nBlocks = [...iterBlocks(doc)].length;
  if (nBlocks === 0) {
    throw new Error(
      `${src.docId}: parsed 0 content blocks from ${basename(src.mainTex)} — ` +
        "empty/unsupported source; fall back to the PDF."
    );
  }

  if (opts.writeJson ?? true) {
    const outJson = join(outDir, `${src.docId}.json`);
    writeFileSync(
      outJson,
      JSON.stringify(documentToJson(doc, config.compactJson), null, 2),
      "utf-8"
    );
    // Python sets meta.output_path on the returned doc *after* serialization.
    if (doc.meta) doc.meta.output_path = outJson;
  }
  return doc;
}

// --------------------------------------------------------------------------- //
// Annotation: anchor matches are authoritative; regex only fills unlinked gaps.
// (Mirrors pipeline_html._annotate_document for the shared contract.)
// --------------------------------------------------------------------------- //

function annotateDocument(doc: Document, walker: Walker): void {
  const resolver = new ReferenceResolver(doc.references ?? []);
  const xindex = new XrefIndex(doc);
  for (const block of iterBlocks(doc)) {
    for (const holder of annotatable(block)) {
      const text = holder.text ?? "";
      if (!text) continue;
      const anchors: Match[] = walker.anchorMatches.get(holder) ?? [];
      let fallback = [...detectCitations(text, resolver), ...detectCrossrefs(text, xindex)];
      fallback = fallback.filter((m) => !overlaps(m, anchors));
      const result = applyMatches(text, [...anchors, ...fallback]);
      holder.text = result.text;
      holder.citations = result.citations;
      holder.crossrefs = result.crossrefs;
    }
  }
}

function overlaps(m: Match, spans: readonly Match[]): boolean {
  return spans.some((s) => m.start < s.end && s.start < m.end);
}

// --------------------------------------------------------------------------- //
// pandoc-meta helpers
// --------------------------------------------------------------------------- //

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

/** Cite keys in first-appearance order (for ordering/pruning the .bib path). */
function collectCiteKeys(ast: Obj): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const d = asObj(n);
    if (d !== undefined) {
      if (d.t === "Cite") {
        const cits = Array.isArray(d.c) ? d.c[0] : undefined;
        for (const ci of Array.isArray(cits) ? cits : []) {
          const k = asObj(ci)?.citationId;
          if (typeof k === "string" && k && !seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
      for (const v of Object.values(d)) walk(v);
    }
  };

  walk(ast.blocks ?? []);
  return keys;
}

function metaText(meta: Obj, key: string): string | undefined {
  const v = asObj(meta[key]);
  if (v === undefined) return undefined;
  const out: string[] = [];

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const d = asObj(n);
    if (d !== undefined) {
      const t = d.t;
      const c = d.c;
      if (t === "Str" || t === "MetaString") {
        out.push(typeof c === "string" ? c : "");
      } else if (t === "Math") {
        // keep math (titles often have $z>6$, $\alpha$)
        const latex = Array.isArray(c) && c.length > 1 ? c[1] : "";
        if (latex) out.push(`$${String(latex)}$`);
      } else if (t === "Space" || t === "SoftBreak" || t === "LineBreak") {
        out.push(" ");
      } else if (Array.isArray(c) || asObj(c) !== undefined) {
        walk(c);
      }
    }
  };

  walk(v);
  const s = out.join("").replace(/\s+/gu, " ").trim();
  return s || undefined;
}

// \author{} often inlines \thanks{email}/affiliations that pandoc flattens into
// the name; cut the name off at the first such tail.
const AFFIL_RE = pyRe(
  "\\s*(?:,?\\s*E-?mail.*|\\bDepartment\\b.*|\\bDept\\b.*|\\bInstitut.*|\\bUniversit.*" +
    "|\\bObservator.*|\\bCentre?\\b.*|\\b\\d{4,}.*)$",
  "is"
);

function cleanAuthor(s: string): string {
  return stripChars(s.replace(AFFIL_RE, ""), " ,;");
}

function metaList(meta: Obj, key: string): string[] {
  const v = asObj(meta[key]);
  if (v === undefined || v.t !== "MetaList") {
    // a single author shows up as MetaInlines
    const single = metaText(meta, key);
    return single ? [cleanAuthor(single)] : [];
  }
  const out: string[] = [];
  for (const item of Array.isArray(v.c) ? v.c : []) {
    const s = metaText({ x: item }, "x");
    if (s) {
      out.push(cleanAuthor(s));
    }
  }
  return out;
}
