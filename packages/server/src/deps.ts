/**
 * Composition root: wire the real M2/M3 infra adapters into the core ports
 * the app needs — the `MetadataSources` (ADS/Crossref/OpenAlex clients with
 * their on-disk caches under `<dataDir>/library/cache/`) and the
 * `IngestPipelines` (LaTeX only; PDF/HTML are archived on `ocr-features`)
 * rooted at `<dataDir>/output`.
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
  ingestLatex,
  ingestLatexZip,
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

/** The ingest pipeline writing under `<dataDir>/output`. */
export function realPipelines(paths: LibraryPaths): IngestPipelines {
  return {
    ingestLatex: (arxivId) => ingestLatex(arxivId, { outRoot: paths.outputDir }),
    // attachLatexZip passes outRoot/docId through; the composition binds nothing extra.
    ingestLatexZip: (zipPath, opts) => ingestLatexZip(zipPath, opts),
  };
}
