/**
 * The in-process runtime of the operation catalog (ADR 0015; release-0.2 ticket 01): what a CLI command uses when no
 * workbench takes the operation (detection and routing to a running workbench are ticket 02). It composes the same
 * `LibraryOpDeps` shape the server does, on its own library lock, with no notification sink and no network seams.
 * The Library payload is read without writing anything: a stale graph cache is rebuilt in memory, not healed on disk.
 */
import {
  buildGraph,
  type LibraryPaths,
  LibraryStore,
  libraryPayload,
  loadCurrentGraph,
} from "@argelanderspace/core";
import { type AdapterWiring, realAdsSearch, realDiscoverySource } from "./deps.js";
import { AsyncLock } from "./lock.js";
import type { OperationRuntime } from "./operation-catalog.js";

/**
 * `wiring` is the composition seam of the network clients (tests inject `fetchImpl` and `adsToken`); the CLI passes none,
 * so the ADS token is read from the credential store at each use and requests go out through the global `fetch`.
 */
export function createLocalOperationRuntime(
  paths: LibraryPaths,
  wiring: AdapterWiring = {}
): OperationRuntime {
  return {
    library: {
      paths,
      libraryLock: new AsyncLock(),
      onChanged: () => {},
      readPayload: async () =>
        libraryPayload(
          paths,
          loadCurrentGraph(paths) ?? buildGraph(LibraryStore.load(paths), paths.outputDir)
        ),
      adsSearch: () => realAdsSearch(wiring),
      discoverySource: () => realDiscoverySource(paths, wiring),
    },
  };
}
