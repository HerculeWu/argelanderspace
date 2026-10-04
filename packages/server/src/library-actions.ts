import {
  type CopilotOperation,
  type LibraryImportWorks,
  type LibraryPayload,
  type LibraryReadOperation,
  type LibraryRefSummary,
  type LibrarySetMainDoc,
  libraryImportRequest,
  libraryLinksAmong,
  libraryRefBibtex,
  libraryRefIdentityMatches,
  libraryRefMatches,
  type ManualWorkRequest,
  type ManualWorkResult,
  summarizeLibraryRef,
} from "@argelanderspace/contracts";
import {
  addManualBibcode,
  addManualBibText,
  addManualIdentifier,
  arxivFromDoi,
  type LibraryPaths,
  LibraryStore,
  type ManualAddOutcome,
  type ManualIdentifier,
  type MetadataSources,
  normDoi,
  patchWorkNarrow,
  type WorkPatchExpectation,
  type WorkPatchResult,
} from "@argelanderspace/core";
import { explicitArxivId, looksLikeArxiv } from "@argelanderspace/infra";
import type { AsyncLock } from "./lock.js";

/**
 * What the Copilot `library` tool shares with the Web UI: the library write lock, the narrow work patch and
 * the `library.changed` notification, plus the page's own payload reader (`GET /api/library`).
 */
export interface LibraryOpDeps {
  paths: LibraryPaths;
  libraryLock: AsyncLock;
  /** Broadcasts `library.changed{cause:"patch"}`, like the PATCH route. */
  onChanged: () => void;
  /** The same payload the Library page loads; the graph cache is healed under the lock when stale. */
  readPayload: () => Promise<LibraryPayload>;
  /**
   * The import menu's shared handler (`POST /api/library/works`): validation, resolution, dedupe, the library
   * lock, the `library.changed{add}` notification and the default arXiv PDF job all live behind it. Absent in
   * hosts without a Library (the tool then reports `unavailable`).
   */
  importWorks?: (
    req: ManualWorkRequest,
    options?: { bridge?: "merge" | "reject" }
  ) => Promise<ManualImportResult>;
}

export type LibraryOpOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      object: NonNullable<CopilotOperation["object"]>;
      label?: string;
      mainDocId: string | null;
      warnings?: string[];
    }
  | {
      ok: false;
      status: "conflict" | "not_found" | "rejected" | "error";
      detail: string;
      current?: { mainDocId: string | null; docIds: string[] };
    };

/**
 * The one write seam of the Library: the PATCH route and the tool both come here. The patch is applied to
 * the CURRENT file inside the library lock; `expected` is checked against that same re-read, so a change to
 * a field the caller relied on is a conflict and an unrelated change is simply kept.
 */
export async function commitWorkPatch(
  deps: LibraryOpDeps,
  workId: string,
  patch: Record<string, unknown>,
  expected?: WorkPatchExpectation
): Promise<WorkPatchResult> {
  const result = await deps.libraryLock.run(() =>
    patchWorkNarrow(deps.paths, workId, patch, expected)
  );
  if (result.status === "ok") deps.onChanged();
  return result;
}

/** The Files tab "set as main" button, as an operation. */
export async function applyLibraryOperation(
  deps: LibraryOpDeps,
  op: LibrarySetMainDoc
): Promise<LibraryOpOutcome> {
  let changed = false;
  let notified = true;
  const guarded: LibraryOpDeps = {
    ...deps,
    onChanged: () => {
      changed = true;
      try {
        deps.onChanged();
      } catch {
        notified = false;
      }
    },
  };
  let result: WorkPatchResult;
  try {
    result = await commitWorkPatch(
      guarded,
      op.refId,
      { doc_id: op.docId },
      { main_doc_id: op.expectedMainDocId }
    );
  } catch {
    // The file may or may not have changed (a failure between the two renames): never claim "unchanged".
    return {
      ok: false,
      status: "error",
      detail: "the library could not be saved; read it again to see whether anything changed",
    };
  }
  const object = { kind: "work" as const, id: op.refId };
  switch (result.status) {
    case "not_found":
      return { ok: false, status: "not_found", detail: "no such work" };
    case "conflict":
      return {
        ok: false,
        status: "conflict",
        detail: "the main Doc changed since you read it; read the work again, then decide",
        current: { mainDocId: result.current.main_doc_id, docIds: result.current.doc_ids },
      };
    case "noop":
      if (result.reason === "not_linked")
        return { ok: false, status: "rejected", detail: "that Doc is not attached to this work" };
      break;
    case "ok":
      break;
  }
  const work = LibraryStore.load(deps.paths).get(op.refId);
  return {
    ok: true,
    status: result.status === "ok" && changed ? "ok" : "noop",
    object,
    ...(work?.title ? { label: work.title } : {}),
    mainDocId: work?.doc_ids[0] ?? null,
    ...(notified ? {} : { warnings: ["change_notification_failed"] }),
  };
}

const DEFAULT_PAGE = 100;

export type LibraryReadOutcome =
  | {
      ok: true;
      total: number;
      matched: number;
      offset: number;
      returned: number;
      nextOffset: number | null;
      refs: LibraryRefSummary[];
      links?: [string, string][];
    }
  | { ok: true; ref: LibraryPayload["refs"][number]; bibtex: string }
  | { ok: false; status: "not_found" };

/** The Library page's own data, read through the page's own filter. Never the stored file itself. */
export async function readLibrary(
  deps: LibraryOpDeps,
  op: LibraryReadOperation
): Promise<LibraryReadOutcome> {
  const payload = await deps.readPayload();
  if (op.refId !== undefined) {
    const ref = payload.refs.find((candidate) => candidate.id === op.refId);
    return ref
      ? { ok: true, ref, bibtex: libraryRefBibtex(ref) }
      : { ok: false, status: "not_found" };
  }
  const matched = payload.refs.filter(
    (ref) =>
      libraryRefMatches(ref, op.query ?? "") || libraryRefIdentityMatches(ref, op.query ?? "")
  );
  const offset = op.offset ?? 0;
  const limit = op.limit ?? DEFAULT_PAGE;
  const slice = matched.slice(offset, offset + limit);
  const outcome: LibraryReadOutcome = {
    ok: true,
    total: payload.refs.length,
    matched: matched.length,
    offset,
    returned: slice.length,
    nextOffset: offset + slice.length < matched.length ? offset + slice.length : null,
    refs: slice.map(summarizeLibraryRef),
  };
  if (op.links)
    outcome.links = libraryLinksAmong(payload.graph, new Set(matched.map((ref) => ref.id)));
  return outcome;
}

// --------------------------------------------------------------------------- //
// Import (the Library page's import menu)
// --------------------------------------------------------------------------- //

/**
 * Identifier auto-detection for the `identifier` mode (Stage 13, smoke revision): arXiv input must be
 * EXPLICIT — the `arXiv:` prefix or an arxiv.org URL; a bare id like `2609.17036` is rejected with guidance.
 * A DOI / doi.org URL goes to the DOI path; an arXiv DataCite DOI routes to the arXiv work (never a
 * journal-DOI stub, mirroring the CLI's routeDoi semantics).
 */
export function detectIdentifier(value: string): ManualIdentifier | { error: string } | null {
  const explicit = explicitArxivId(value);
  if (explicit !== null) return { kind: "arxiv", arxiv: explicit };
  if (looksLikeArxiv(value)) {
    return {
      error: `bare arXiv id '${value.trim()}' is ambiguous — use the prefixed form arXiv:${value.trim()} (or an arxiv.org URL)`,
    };
  }
  const d = normDoi(value);
  if (d) {
    const ax = arxivFromDoi(d);
    if (ax !== null) return { kind: "arxiv", arxiv: ax };
    if (/^10\.\d{4,9}\/\S+$/.test(d)) return { kind: "doi", doi: d };
  }
  return null;
}

export interface ManualImportDeps {
  paths: LibraryPaths;
  libraryLock: AsyncLock;
  makeSources: () => MetadataSources;
}

/** What one import did, beyond the per-entry results the page shows. */
export interface ManualImportResult {
  /** Exactly the response body of `POST /api/library/works`. */
  results: ManualWorkResult[];
  /** The file changed: something was created, or an existing Work's stored object was updated. */
  changed: boolean;
  /** Ids of existing Works whose stored object was updated (blank fields filled, acquisition recomputed). */
  updated: string[];
  /** The record would have folded stored Works into one; the tool path refuses it and writes nothing. */
  rejected: boolean;
}

/**
 * The locked part of `POST /api/library/works`: the whole batch runs under the library lock (single user;
 * the network seconds are the same trade lockedRebuild makes). Per-entry outcomes are results, never throws.
 * The writes are narrow (only the affected Works change in the file). The caller (the route or the tool,
 * through `LibraryOpDeps.importWorks`) adds the notification and the default PDF job.
 * `bridge: "reject"` (the tool) refuses an import that would fold or delete a stored Work.
 */
export async function runManualImport(
  deps: ManualImportDeps,
  req: ManualWorkRequest,
  options: { bridge?: "merge" | "reject" } = {}
): Promise<ManualImportResult> {
  const sources = deps.makeSources();
  const outcomes = await deps.libraryLock.run(async (): Promise<ManualAddOutcome[]> => {
    if (req.mode === "identifier") {
      const id = detectIdentifier(req.value);
      if (id === null) {
        return [
          {
            status: "error",
            error: `unrecognized identifier (expected a DOI, or an arXiv id as arXiv:<id>): ${req.value.slice(0, 120)}`,
          },
        ];
      }
      if ("error" in id) return [{ status: "error", error: id.error }];
      return [await addManualIdentifier(deps.paths, sources, id, options)];
    }
    if (req.mode === "bibcode") {
      return [await addManualBibcode(deps.paths, sources, req.bibcode, options)];
    }
    return addManualBibText(deps.paths, req.bib, options);
  });
  const results: ManualWorkResult[] = outcomes.map((o) => ({
    status: o.status,
    ...(o.ref !== undefined ? { ref: o.ref } : {}),
    ...(o.key !== undefined ? { key: o.key } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
  }));
  const updated = outcomes
    .filter((o) => o.status === "exists" && o.changed === true && o.ref)
    .map((o) => (o.ref as { id: string }).id);
  return {
    results,
    changed: outcomes.some((o) => o.status === "created" || o.changed === true),
    updated,
    rejected: outcomes.some((o) => o.bridged !== undefined),
  };
}

export type LibraryImportOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      mode: LibraryImportWorks["mode"];
      created: number;
      /** Entries the library already held. */
      existing: number;
      /** Ids of those existing Works that were nevertheless updated (blank fields filled, acquisition recomputed). */
      updated: string[];
      failed: number;
      results: ManualWorkResult[];
      object?: NonNullable<CopilotOperation["object"]>;
      label?: string;
      warnings?: string[];
    }
  | {
      ok: false;
      status: "error" | "rejected" | "unsupported" | "unknown";
      detail: string;
      results?: ManualWorkResult[];
    };

/**
 * The import menu's submit, as an operation. Same handler as the page (`importWorks`), same per-entry results.
 * Status `ok`: something was created or an existing Work's stored object was updated; `noop`: the file was
 * left as it was. A record that would fold stored Works into one is `rejected` and writes nothing (the page
 * still folds them; that is a known, separate behaviour).
 */
export async function applyLibraryImport(
  deps: LibraryOpDeps,
  op: LibraryImportWorks
): Promise<LibraryImportOutcome> {
  if (!deps.importWorks)
    return { ok: false, status: "unsupported", detail: "importing is not available in this host" };
  let outcome: ManualImportResult;
  try {
    outcome = await deps.importWorks(libraryImportRequest(op), { bridge: "reject" });
  } catch {
    // The batch may have saved some entries before failing: never claim "nothing changed".
    return {
      ok: false,
      status: "unknown",
      detail:
        "the import failed part-way and its outcome is not known; read the library with the identifier or title as query to see what was saved before deciding",
    };
  }
  const { results } = outcome;
  if (outcome.rejected)
    return {
      ok: false,
      status: "rejected",
      detail:
        "refused, nothing was written: the record would merge existing works into one (see the error in results). Ask the user to resolve them in the Library page.",
      results,
    };
  const created = results.filter((r) => r.status === "created").length;
  const existing = results.filter((r) => r.status === "exists").length;
  const failed = results.filter((r) => r.status === "error").length;
  if (created + existing === 0)
    return {
      ok: false,
      status: "error",
      detail: "nothing was imported; the library was not changed (see results)",
      results,
    };
  const first = results.find((r) => r.status === "created" && r.ref) ?? results.find((r) => r.ref);
  return {
    ok: true,
    status: outcome.changed ? "ok" : "noop",
    mode: op.mode,
    created,
    existing,
    updated: outcome.updated,
    failed,
    results,
    ...(first?.ref
      ? { object: { kind: "work" as const, id: first.ref.id }, label: first.ref.title }
      : {}),
    ...(failed > 0 ? { warnings: ["import_partial"] } : {}),
  };
}
