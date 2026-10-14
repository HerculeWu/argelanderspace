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
  readContactEmail,
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
   * Where the sources take `openalex_api_key` and `contact_email` from. The server hands in a function that reads
   * config.toml leniently at each call (desktop-app ticket 10: a faulty file means "not set" and fails nothing; a
   * contact email not shaped like an address is faulty, so no address is sent); the CLI hands in none, and the clients
   * read the file strictly themselves (a faulty file stops the command).
   */
  config?: (() => AppConfig) | undefined;
  /**
   * The ADS token, asked at each composition (desktop-app ticket 12): the server hands in a reading of its own ADS
   * credential store (the one the settings endpoints write, wrapped for its log); default `readAdsToken()`, the
   * credential store over the OS keychain. Never from the environment, config.toml or `~/.ads/dev_key`.
   */
  adsToken?: (() => Promise<string | null>) | undefined;
}

/**
 * The ADS token of this composition: read from the credential store now, so a saved or removed token applies at once.
 * Offline compositions read it too (as before ticket 12): the summary's `ads_status` then says whether there is one.
 */
async function adsTokenOf(wiring: AdapterWiring): Promise<{ token: string | null }> {
  return { token: await (wiring.adsToken ?? (() => readAdsToken()))() };
}

/**
 * The OpenAlex key and the contact email of the sources, when the composition gave a config; nothing otherwise (the
 * clients' own reading). Read at each composition, so a change of config.toml applies to the next request without a
 * restart.
 */
function keysOf(wiring: AdapterWiring): {
  oa: { apiKey?: string | null; mailto?: string | null };
  crossref: { mailto?: string | null };
} {
  if (wiring.config === undefined) return { oa: {}, crossref: {} };
  const config = wiring.config();
  const mailto = readContactEmail(config);
  return {
    oa: { apiKey: readOpenAlexApiKey(process.env, config), mailto },
    crossref: { mailto },
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

/**
 * The resolution-chain sources; `offline` skips remote enrichment. Asynchronous because the ADS token is read from the
 * credential store at each composition, offline ones included (see `adsTokenOf`).
 */
export async function realSources(
  paths: LibraryPaths,
  offline: boolean,
  wiring: AdapterWiring = {}
): Promise<MetadataSources> {
  const keys = keysOf(wiring);
  const ads = await adsTokenOf(wiring);
  return {
    ads: new AdsClient({
      ...ads,
      cacheDir: join(paths.cacheDir, "ads"),
      enabled: !offline,
      ...fetchOf(wiring, "ads"),
    }),
    crossref: new CrossrefClient({
      ...keys.crossref,
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
export async function realDiscoverySource(
  paths: LibraryPaths,
  wiring: AdapterWiring = {}
): Promise<AdsDiscoverySource> {
  return new AdsDiscoveryClient({
    ...(await adsTokenOf(wiring)),
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
