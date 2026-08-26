/**
 * Port of `bibgraph/ingest_html/base.py`: per-publisher HTML adapter interface
 * + registry.
 *
 * Each publisher ships its own front-end markup, so each gets an adapter that
 * knows how to walk *that* DOM. An adapter consumes the fetched page and emits
 * a {@link ParsedDoc} (section tree + references + title/meta); the common
 * pipeline (`pipeline.ts`) does the publisher-independent rest (regex citation
 * fallback, tokenisation, indexing, JSON).
 *
 * The Python adapters monkey-patch `_anchor_matches` onto each text holder for
 * the pipeline's annotate pass; here the parse returns an explicit
 * `anchorMatches` map keyed by holder object (same convention as the LaTeX
 * walker's `anchorMatches`), so nothing internal can leak into the JSON.
 */

import type { Reference, RichText, Section } from "@argelanderspace/contracts";
import type { CheerioAPI } from "cheerio";
import type { Match } from "../../documents/annotate.js";
import type { HtmlMathmlPort, HtmlPagePort, HtmlPipelineConfig } from "./ports.js";

/** Everything a publisher adapter extracts from one fetched page. */
export interface ParsedDoc {
  sections: Section[];
  references: Reference[];
  title?: string;
  meta: Record<string, unknown>;
  sourceExtra: Record<string, unknown>;
  /** holder object → authoritative anchor matches (pipeline annotate pass). */
  anchorMatches: Map<RichText, Match[]>;
}

/** Per-adapter parse context (Python `parse(soup, *, base_url, fetcher, asset_dir, config)`). */
export interface AdapterParseContext {
  /** Final (post-redirect) URL of the fetched page. */
  baseUrl: string;
  fetcher: HtmlPagePort;
  mathml: HtmlMathmlPort;
  /** `<out_dir>/assets` — figure/equation images land here. */
  assetDir: string;
  config: HtmlPipelineConfig;
}

export interface HtmlAdapter {
  name: string;
  /** substrings any of which, in the host/url, claim a page for this adapter */
  hostHints: readonly string[];
  /** human label for the journal this adapter serves (e.g. "A&A") */
  publisher: string;
  /** DOI prefixes this adapter can render (acquisition planner hook). */
  doiPrefixes: readonly string[];
  matches(url: string, soup: CheerioAPI): boolean;
  parse(soup: CheerioAPI, ctx: AdapterParseContext): Promise<ParsedDoc>;
}

/** Default `HtmlAdapter.matches`: any host hint appears in the lowercased url. */
export function matchesByHost(adapter: HtmlAdapter, url: string): boolean {
  const u = url.toLowerCase();
  return adapter.hostHints.some((h) => u.includes(h));
}

// Registry, populated by each adapter module at import time. ----------------- //
export const HTML_ADAPTERS: HtmlAdapter[] = [];

export function registerAdapter<A extends HtmlAdapter>(adapter: A): A {
  HTML_ADAPTERS.push(adapter);
  return adapter;
}

export function adapterFor(url: string, soup: CheerioAPI): HtmlAdapter | null {
  for (const adapter of HTML_ADAPTERS) {
    try {
      if (adapter.matches(url, soup)) return adapter;
    } catch {
      // a matches() that throws simply doesn't claim the page (Python parity)
    }
  }
  return null;
}

/** Live-registry slice for `acquire/planner.ts`'s `HtmlAdapterInfo`
 *  (`DEFAULT_HTML_ADAPTERS` is the static snapshot; composition layers should
 *  pass this live view where the adapters are actually registered). */
export function htmlAdapterInfos(): Array<{ name: string; doiPrefixes: readonly string[] }> {
  return HTML_ADAPTERS.map((a) => ({ name: a.name, doiPrefixes: a.doiPrefixes }));
}
