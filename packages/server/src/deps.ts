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

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AdsDiscoverySource,
  IngestPipelines,
  LibraryPaths,
  MetadataSources,
} from "@argelanderspace/core";
import {
  AdsClient,
  AdsDiscoveryClient,
  type AppConfig,
  CrossrefClient,
  type ExternalObserver,
  type FetchImpl,
  ingestArxivEprint,
  ingestTexSource,
  ingestTexZip,
  OpenAlexClient,
  observedFetch,
  readAdsToken,
  readOpenAlexApiKey,
  type TexFailureLogHook,
} from "@argelanderspace/infra";

/**
 * What a composition may add to the real adapters. Both are optional and both default to nothing: the CLI composes
 * the adapters without either, so its commands are observed by nobody and write no log.
 */
export interface AdapterWiring {
  /**
   * Told of every request the sources make and every program the pipelines run (infra `lib/observe.ts`). The
   * server hands in the one that writes its user-level log.
   */
  observer?: ExternalObserver | undefined;
  /** The HTTP implementation under the sources and the arXiv fetcher (tests: an offline stub); default global fetch. */
  fetchImpl?: FetchImpl | undefined;
  /**
   * Where the complete latexmk log of a failed compile is kept (infra `tex/failure-log.ts`). The server hands one in
   * per job (compile-failure-log.ts); the CLI hands in none and keeps none.
   */
  failureLog?: TexFailureLogHook | undefined;
  /**
   * Where the sources take `ads_dev_key` and `openalex_api_key` from. The server hands in a function that reads
   * config.toml leniently at each call (desktop-app ticket 10: a faulty file means "not set" and fails nothing); the
   * CLI hands in none, and the clients read the file strictly themselves (a faulty file stops the command).
   */
  config?: (() => AppConfig) | undefined;
}

/** The keys of the sources, when the composition gave a config; nothing otherwise (the clients' own reading). */
function keysOf(wiring: AdapterWiring): {
  ads: { token?: string | null };
  oa: { apiKey?: string | null };
} {
  if (wiring.config === undefined) return { ads: {}, oa: {} };
  const config = wiring.config();
  return {
    ads: { token: readAdsToken(process.env, homedir(), config) },
    oa: { apiKey: readOpenAlexApiKey(process.env, config) },
  };
}

function fetchOf(
  wiring: AdapterWiring,
  service: Parameters<typeof observedFetch>[1]
): { fetchImpl?: FetchImpl } {
  if (wiring.observer === undefined && wiring.fetchImpl === undefined) return {};
  return { fetchImpl: observedFetch(wiring.fetchImpl ?? fetch, service, wiring.observer) };
}

/**
 * The status dir (Stage 4) always sits next to the effective data dir:
 * `./literatures` → `./status`, a `--data-dir` elsewhere gets a `status/`
 * sibling. It holds the plan page's `plans.json` (core `plans/store.ts`).
 */
export function statusDirFor(dataDir: string): string {
  return resolve(dataDir, "..", "status");
}

/** The resolution-chain sources; `offline` skips remote enrichment. */
export function realSources(
  paths: LibraryPaths,
  offline: boolean,
  wiring: AdapterWiring = {}
): MetadataSources {
  const keys = keysOf(wiring);
  return {
    ads: new AdsClient({
      ...keys.ads,
      cacheDir: join(paths.cacheDir, "ads"),
      enabled: !offline,
      ...fetchOf(wiring, "ads"),
    }),
    crossref: new CrossrefClient({
      cacheDir: join(paths.cacheDir, "crossref"),
      enabled: !offline,
      ...fetchOf(wiring, "crossref"),
    }),
    oa: new OpenAlexClient({
      ...keys.oa,
      cacheDir: join(paths.cacheDir, "openalex"),
      enabled: !offline,
      ...fetchOf(wiring, "openalex"),
    }),
  };
}

/**
 * The Stage 14 discovery source: a dedicated ADS client with its own TTL
 * cache namespace (`<dataDir>/library/cache/ads-discovery`), never the
 * metadata `<cacheDir>/ads` cache.
 */
export function realDiscoverySource(
  paths: LibraryPaths,
  wiring: AdapterWiring = {}
): AdsDiscoverySource {
  return new AdsDiscoveryClient({
    ...keysOf(wiring).ads,
    cacheDir: join(paths.cacheDir, "ads-discovery"),
    ...fetchOf(wiring, "ads"),
  });
}

/** The ingest pipeline writing under `<dataDir>/output` (Stage 5 tex pipeline). */
export function realPipelines(paths: LibraryPaths, wiring: AdapterWiring = {}): IngestPipelines {
  // Nothing is added to the options when the composition asked for nothing: the CLI's calls are the ones they were.
  const extra = {
    ...(wiring.observer !== undefined ? { observer: wiring.observer } : {}),
    ...(wiring.fetchImpl !== undefined ? { fetchImpl: wiring.fetchImpl } : {}),
    ...(wiring.failureLog !== undefined ? { failureLog: wiring.failureLog } : {}),
  };
  return {
    ingestLatex: async (arxivId) =>
      (await ingestTexSource(arxivId, { outRoot: paths.outputDir, ...extra })).ir,
    // attachLatexZip passes outRoot/docId through; the composition binds nothing extra.
    ingestLatexZip: async (zipPath, opts) =>
      (await ingestTexZip(zipPath, { ...opts, ...extra })).ir,
    // Stage 15: attachArxivDoc passes outRoot/docId; always fresh (never the stale cache).
    ingestArxivEprint: async (arxivId, opts) =>
      (await ingestArxivEprint(arxivId, { ...opts, ...extra })).ir,
  };
}
