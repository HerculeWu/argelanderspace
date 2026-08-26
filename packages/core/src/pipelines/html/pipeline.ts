/**
 * End-to-end publisher-HTML -> structured JSON ingestion pipeline
 * (`bibgraph/pipeline_html.py`).
 *
 *     url/DOI
 *      ├─ fetch          -> full-text HTML (cached on disk)          [port]
 *      ├─ adapter        -> section tree + floats + references  (per publisher)
 *      │                    citations/cross-refs tokenised AUTHORITATIVELY from
 *      │                    the page's own <a href="#R../#F.."> anchors
 *      ├─ annotate       -> regex fallback for any *unlinked* mention
 *      └─ index/stats    -> same Document shape the PDF pipeline emits
 *     -> Document -> <out_root>/<doc_id>/<doc_id>.json
 *
 * The output JSON is identical in shape to the PDF path, so the reader UI and
 * all downstream tooling work unchanged. Fetching (network + cache + asset
 * downloads) and the pandoc MathML conversion arrive as injected
 * {@link HtmlPipelinePorts}; infra wires the real adapters.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Document } from "@argelanderspace/contracts";
import type { Match } from "../../documents/annotate.js";
import { applyMatches } from "../../documents/annotate.js";
import { detectCitations, ReferenceResolver } from "../../documents/citations.js";
import { detectCrossrefs, XrefIndex } from "../../documents/crossrefs.js";
import { annotatable, documentToJson } from "../../documents/document.js";
import { iterBlocks } from "../../documents/traverse.js";
// Side-effect imports: register the publisher adapters, exactly like Python's
// `from .ingest_html import adapter_for` triggers the package __init__'s
// `from . import aanda, oup` — using the pipeline always sees the full registry.
import "./aanda.js";
import "./oup.js";
import { adapterFor, type ParsedDoc } from "./base.js";
import { loadHtml } from "./dom.js";
import { DEFAULT_HTML_CONFIG, type HtmlPipelineConfig, type HtmlPipelinePorts } from "./ports.js";
import { docIdFromUrl, normalizeSource } from "./source.js";

export interface IngestHtmlOptions {
  /** Pipeline output root (Python `out_root`, default "data/output"). */
  outRoot?: string;
  /** `HtmlConfig` overrides; defaults come from `bibgraph/config.py`. */
  config?: Partial<HtmlPipelineConfig>;
  /** Write `<out_root>/<doc_id>/<doc_id>.json` (Python `write_json`). */
  writeJson?: boolean;
}

export async function ingestHtml(
  source: string,
  ports: HtmlPipelinePorts,
  opts: IngestHtmlOptions = {}
): Promise<Document> {
  const config: HtmlPipelineConfig = { ...DEFAULT_HTML_CONFIG, ...opts.config };
  const outRoot = opts.outRoot ?? "data/output";
  mkdirSync(outRoot, { recursive: true });

  const url0 = normalizeSource(source);
  const { finalUrl, text } = await ports.fetcher.get(url0);
  const soup = loadHtml(text);

  const docId = docIdFromUrl(finalUrl);
  const outDir = join(outRoot, docId);
  const assetDir = join(outDir, "assets");
  mkdirSync(outDir, { recursive: true });

  const adapter = adapterFor(finalUrl, soup);
  if (adapter === null) {
    throw new Error(
      `No HTML adapter matches ${JSON.stringify(finalUrl)}. Supported: A&A (aanda.org). ` +
        "Add a publisher adapter under bibgraph/ingest_html/."
    );
  }

  const parsed = await adapter.parse(soup, {
    baseUrl: finalUrl,
    fetcher: ports.fetcher,
    mathml: ports.mathml,
    assetDir,
    config,
  });

  const { url: _extraUrl, ...sourceRest } = parsed.sourceExtra;
  const doc: Document = {
    doc_id: docId,
    source: {
      type: "html",
      path: finalUrl,
      filename: `${docId}.html`,
      n_pages: 1,
      url: finalUrl,
      ...sourceRest,
    } as Document["source"],
    meta: { title: parsed.title ?? "", html: parsed.meta },
    structure: parsed.sections,
    references: parsed.references,
  };

  annotateHtmlDocument(doc, parsed);

  // Guard against silently ingesting a hollow page (abstract-only / paywalled /
  // unsupported template): a real article has body text.
  const nBlocks = [...iterBlocks(doc)].length;
  if (nBlocks === 0) {
    throw new Error(
      `${docId}: parsed 0 content blocks from ${finalUrl} — not the full ` +
        "text (abstract/paywall, or an unsupported old template)."
    );
  }

  if (opts.writeJson ?? true) {
    const outJson = join(outDir, `${docId}.json`);
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

/**
 * `pipeline_html._annotate_document`: splice inline tokens. Anchor matches from
 * the adapter are authoritative; the regex detector only fills in *unlinked*
 * author-year / "Fig. N" mentions (and is suppressed wherever it overlaps an
 * anchor).
 */
export function annotateHtmlDocument(
  doc: Document,
  parsed: Pick<ParsedDoc, "anchorMatches">
): void {
  const resolver = new ReferenceResolver(doc.references ?? []);
  const xindex = new XrefIndex(doc);
  for (const block of iterBlocks(doc)) {
    for (const holder of annotatable(block)) {
      const text = holder.text ?? "";
      if (!text) continue;
      const anchors: Match[] = [...(parsed.anchorMatches.get(holder) ?? [])];
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
