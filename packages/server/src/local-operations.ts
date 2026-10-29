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
import { createAnnotationAccess } from "./annotations-access.js";
import { type AdapterWiring, realAdsSearch, realDiscoverySource } from "./deps.js";
import { DocMutationRegistry } from "./doc-mutations.js";
import { AsyncLock } from "./lock.js";
import type { OperationRuntime } from "./operation-catalog.js";
import { createPdfAccess } from "./pdf-access.js";
import { createReaderOps } from "./reader-ops-deps.js";
import { TextDocService } from "./text-docs.js";

/**
 * `wiring` is the composition seam of the network clients (tests inject `fetchImpl` and `adsToken`); the CLI passes none,
 * so the ADS token is read from the credential store at each use and requests go out through the global `fetch`.
 */
export function createLocalOperationRuntime(
  paths: LibraryPaths,
  wiring: AdapterWiring = {}
): OperationRuntime {
  // The annotation and PDF access paths are the server's own modules, here on this process's locks (the only code that
  // reads or writes a Doc's annotations); nothing is announced, and no job runs in a command's process, so no Doc is busy.
  const annotationLock = new AsyncLock();
  const docMutations = new DocMutationRegistry();
  const none = () => {};
  const annotationAccess = createAnnotationAccess({
    paths,
    lock: annotationLock,
    docMutations,
    onChanged: none,
  });
  const pdfAccess = createPdfAccess({
    paths,
    docMutations,
    lock: annotationLock,
    onChanged: none,
    readingPositionLock: new AsyncLock(),
    onReadingPositionChanged: none,
  });
  return {
    reader: createReaderOps({ paths, annotationAccess, pdfAccess, docMutations }),
    text: new TextDocService({
      paths,
      libraryLock: new AsyncLock(),
      annotationLock,
      docMutations,
      broadcast: none,
      libraryChanged: none,
    }),
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
