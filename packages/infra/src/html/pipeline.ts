/**
 * Wiring layer for the publisher-HTML pipeline: compose `@argelanderspace/core`'s
 * `ingestHtml` (pure composition + cheerio adapters) with the infra adapters —
 * the caching `Fetcher` (`html/fetcher.ts`, real HTTP + on-disk cache + asset
 * downloads) and the pandoc CLI MathML conversion (`latex/pandoc.ts`). This
 * lives in infra because those capabilities do network/subprocess/fs I/O; the
 * pipeline itself stays in core.
 */

import { join } from "node:path";
import {
  ingestHtml as coreIngestHtml,
  DEFAULT_HTML_CONFIG,
  type IngestHtmlOptions,
} from "@argelanderspace/core";
import { mathmlToLatex } from "../latex/pandoc.js";
import type { FetchImpl } from "../lib/http.js";
import { Fetcher } from "./fetcher.js";

export interface WiredIngestHtmlOptions extends IngestHtmlOptions {
  /** HTTP implementation for the fetcher (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Fetcher log sink (Python `logging` equivalent). */
  log?: (msg: string) => void;
}

/** The ingested Document (shape from `@argelanderspace/contracts`). */
export type IngestedHtmlDocument = Awaited<ReturnType<typeof coreIngestHtml>>;

/** `ingest_html` with the real adapters: DOI / publisher URL → Document. */
export async function ingestHtml(
  source: string,
  opts: WiredIngestHtmlOptions = {}
): Promise<IngestedHtmlDocument> {
  const { fetchImpl, log, ...coreOpts } = opts;
  const config = { ...DEFAULT_HTML_CONFIG, ...coreOpts.config };
  const outRoot = coreOpts.outRoot ?? "data/output";
  // The fetcher is scoped to the shared on-disk page cache under the output
  // root, exactly like `pipeline_html.ingest_html` builds it.
  const fetcher = new Fetcher(join(outRoot, ".htmlcache"), {
    userAgent: config.userAgent,
    timeout: config.requestTimeout,
    useCache: config.useCache,
    delay: config.requestDelay,
    fetchImpl,
    log,
  });
  return coreIngestHtml(source, { fetcher, mathml: { mathmlToLatex } }, { ...coreOpts, config });
}
