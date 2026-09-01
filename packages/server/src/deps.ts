/**
 * Composition root: wire the real M2/M3 infra adapters into the core ports
 * the app needs — the `MetadataSources` (ADS/Crossref/OpenAlex clients with
 * their on-disk caches under `<dataDir>/library/cache/`) and the
 * `IngestPipelines` (PDF/HTML/LaTeX) rooted at `<dataDir>/output`.
 *
 * Bug-for-bug note (`library/build.py::_rebuild_locked`): `offline` disables
 * Crossref + OpenAlex (`enabled=False`) but ADS is constructed unconditionally
 * upstream — it self-degrades via its token/cache. So `realSources(paths,
 * true)` still returns a live ADS client.
 */

import { join } from "node:path";
import type { IngestPipelines, LibraryPaths, MetadataSources } from "@argelanderspace/core";
import {
  AdsClient,
  CrossrefClient,
  ingestHtml,
  ingestLatex,
  ingestPdf,
  OpenAlexClient,
} from "@argelanderspace/infra";

/** The resolution-chain sources; `offline` skips remote enrichment. */
export function realSources(paths: LibraryPaths, offline: boolean): MetadataSources {
  return {
    ads: new AdsClient({ cacheDir: join(paths.cacheDir, "ads") }),
    crossref: new CrossrefClient({ cacheDir: join(paths.cacheDir, "crossref"), enabled: !offline }),
    oa: new OpenAlexClient({ cacheDir: join(paths.cacheDir, "openalex"), enabled: !offline }),
  };
}

/** The three ingest pipelines writing under `<dataDir>/output`. */
export function realPipelines(paths: LibraryPaths): IngestPipelines {
  return {
    ingestPdf: (pdfPath, opts) =>
      ingestPdf(pdfPath, {
        outDir: opts.outDir,
        config: { mineru: { isOcr: opts.isOcr } },
        onProgress: opts.onProgress,
      }),
    ingestHtml: (doi) => ingestHtml(doi, { outRoot: paths.outputDir }),
    ingestLatex: (arxivId) => ingestLatex(arxivId, { outRoot: paths.outputDir }),
  };
}
