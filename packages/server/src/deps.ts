/**
 * Composition root: wire the real M2/M3 infra adapters into the core ports
 * the app needs — the `MetadataSources` (ADS/Crossref/OpenAlex clients with
 * their on-disk caches under `<dataDir>/library/cache/`) and the
 * `IngestPipelines` (LaTeX only; PDF/HTML are archived on `ocr-features`)
 * rooted at `<dataDir>/output`.
 *
 * `offline` disables the network side of all three sources (ADS/Crossref/
 * OpenAlex keep reading their disk caches). The Python original left ADS live
 * under `--offline` (bug-for-bug note, retired in Stage 7 MS2b after a parity
 * run showed live ADS writes during an offline rebuild).
 */

import { join, resolve } from "node:path";
import type { IngestPipelines, LibraryPaths, MetadataSources } from "@argelanderspace/core";
import {
  AdsClient,
  CrossrefClient,
  ingestTexSource,
  ingestTexZip,
  OpenAlexClient,
} from "@argelanderspace/infra";

/**
 * The status dir (Stage 4) always sits next to the effective data dir:
 * `./literatures` → `./status`, a `--data-dir` elsewhere gets a `status/`
 * sibling. It holds the plan page's `plans.json` (core `plans/store.ts`).
 */
export function statusDirFor(dataDir: string): string {
  return resolve(dataDir, "..", "status");
}

/** The resolution-chain sources; `offline` skips remote enrichment. */
export function realSources(paths: LibraryPaths, offline: boolean): MetadataSources {
  return {
    ads: new AdsClient({ cacheDir: join(paths.cacheDir, "ads"), enabled: !offline }),
    crossref: new CrossrefClient({ cacheDir: join(paths.cacheDir, "crossref"), enabled: !offline }),
    oa: new OpenAlexClient({ cacheDir: join(paths.cacheDir, "openalex"), enabled: !offline }),
  };
}

/** The ingest pipeline writing under `<dataDir>/output` (Stage 5 tex pipeline). */
export function realPipelines(paths: LibraryPaths): IngestPipelines {
  return {
    ingestLatex: async (arxivId) =>
      (await ingestTexSource(arxivId, { outRoot: paths.outputDir })).ir,
    // attachLatexZip passes outRoot/docId through; the composition binds nothing extra.
    ingestLatexZip: async (zipPath, opts) => (await ingestTexZip(zipPath, opts)).ir,
  };
}
