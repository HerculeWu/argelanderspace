import {
  type CopilotOperation,
  type LibraryPayload,
  type LibraryReadOperation,
  type LibraryRefSummary,
  type LibrarySetMainDoc,
  libraryLinksAmong,
  libraryRefBibtex,
  libraryRefMatches,
  summarizeLibraryRef,
} from "@argelanderspace/contracts";
import {
  type LibraryPaths,
  LibraryStore,
  patchWorkNarrow,
  type WorkPatchExpectation,
  type WorkPatchResult,
} from "@argelanderspace/core";
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
  const matched = payload.refs.filter((ref) => libraryRefMatches(ref, op.query ?? ""));
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
