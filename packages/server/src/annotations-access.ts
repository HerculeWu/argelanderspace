/**
 * The annotations access path of a LaTeX (or text) Doc: the archive authority of the contract
 * (docs/contracts.md "归档权限与 PUT", "内容指纹三态硬规则", "Reader 与 annotations 共同 epoch").
 *
 * `GET`/`PUT /api/paper/:doc_id/annotations`, the Shelf add (shelf-add.ts) and the Copilot `reader` tool's annotation reads and writes all go
 * through ONE instance of this module, made by `createApp` with the app's one annotationLock (the same lock the text
 * Doc publication, the PDF annotation writes, the annotation risk read and the Doc delete description take) and its
 * DocMutationRegistry. `onChanged` is the app's `annotation.changed` notification.
 *
 * Only `commit`, `read` and the `ensure` of `together` (the Shelf add's one critical section) may archive (through core's idempotent `ensureCurrentAnnotationsWithDocument`); `peek`
 * is the read-only twin for the Copilot's background read. Every failure to compute the fingerprint or to read the
 * stored file is an `AnnotationsError` thrown to the caller (a system error, never a mismatch) and leaves the user's
 * data as it was, except the contract's intermediate state (code `new_current`: the old batch is safely archived,
 * the new current is not there yet). An unreadable Doc metadata file is a `DocMetadataError`.
 */
import type { AnnotationsFile } from "@argelanderspace/contracts";
import {
  type AnnotationsError,
  ensureCurrentAnnotationsWithDocument,
  type LibraryPaths,
  readDocumentForReading,
  readPdfMetadataIfPresent,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { AsyncLock } from "./lock.js";

/** The Doc's metadata file could not be read (a corrupt PDF metadata file): a system error, nothing was changed. */
export class DocMetadataError extends Error {
  constructor(cause: unknown) {
    super("the Doc's metadata could not be read", { cause });
  }
}

/** The ensured epoch: the stored IR, its asset digests and the current annotations of that content. */
export type AnnotationsEpoch = ReturnType<typeof ensureCurrentAnnotationsWithDocument>;
type Archived = { archived?: number };
export type AnnotationsCommit<T = never> =
  | { kind: "busy" }
  | { kind: "pdf" }
  | ({ kind: "document_changed"; file: AnnotationsFile } & Archived)
  | ({ kind: "rev_mismatch"; rev: number } & Archived)
  | ({ kind: "saved"; file: AnnotationsFile } & Archived)
  | ({ kind: "skipped"; file: AnnotationsFile; value: T } & Archived);
export type AnnotationsRead =
  | { kind: "busy" }
  | { kind: "pdf" }
  | { kind: "ok"; epoch: AnnotationsEpoch };
export type AnnotationsPeek =
  | { kind: "busy" }
  | { kind: "pdf" }
  | { kind: "ok"; reading: ReturnType<typeof readDocumentForReading> };

/** What `together` hands its caller inside the critical section. */
export interface TogetherAccess {
  busy(docId: string): boolean;
  ensure(
    docId: string
  ): { kind: "busy" } | { kind: "pdf" } | { kind: "ok"; epoch: AnnotationsEpoch };
}

export interface AnnotationAccessDeps {
  paths: LibraryPaths;
  /** The app's one annotationLock (received, never made here). */
  lock: AsyncLock;
  docMutations: Pick<DocMutationRegistry, "isDocumentContentBusy">;
  onChanged: (docId: string, kind: "put" | "invalidate") => void;
}

export interface AnnotationAccess {
  /**
   * The ONE commit of a LaTeX Doc's annotations. One critical section on the lock: content-busy check, PDF refusal,
   * the idempotent ensure (which alone may archive and then announces `invalidate`), the fingerprint check, the
   * revision check, `build`, and the atomic save; `put` is announced after the lock, and only when it saved. `build`
   * gets the ensured epoch and returns the file to save (`next`; `preserveUnknown` keeps keys the schema does not
   * know, as the Copilot's narrow writes do and the page's whole-file PUT does not) or `skip` when there is nothing to
   * write. `archived` says how many annotations of older content this very access archived.
   */
  commit<T = never>(
    docId: string,
    expect: { fingerprint: string; rev: number },
    build: (
      epoch: AnnotationsEpoch
    ) => { next: AnnotationsFile; preserveUnknown?: boolean } | { skip: T }
  ): Promise<AnnotationsCommit<T>>;
  /** The page's read (GET): the same critical section up to the ensure (busy → PDF → ensure → `invalidate`). */
  read(docId: string): Promise<AnnotationsRead>;
  /**
   * The same reads, READ-ONLY (no ensure, no archive, never the archive's content, no notification), under the same
   * lock and refused while a content mutation is queued or running: the Copilot's background read.
   */
  peek(docId: string): Promise<AnnotationsPeek>;
  /**
   * One critical section on the lock for a caller that reads several Docs' current annotations together with other
   * files of the project, so that everything it reads is of one moment (the Shelf add, shelf ticket 03). `run` must be
   * synchronous (no await: the section ends when it returns). It gets the content-busy check and `ensure`, the very
   * ensure of `read` — idempotent, the only step that may archive, and it announces `invalidate` when it did — which
   * refuses a busy Doc itself (`busy`: nothing ensured, nothing archived), refuses a PDF Doc (`pdf`) and throws the
   * same `AnnotationsError`/`DocMetadataError` as `read`. The caller also checks `busy` for every Doc before its first
   * `ensure`, so one busy Doc stops the whole read before any other Doc was archived.
   */
  together<T>(run: (access: TogetherAccess) => T): Promise<T>;
  /** What a system error of this path answers; the detail names no path. Each code has its own, accurate, message. */
  describeError(err: AnnotationsError): { status: 404 | 500; detail: string };
}

export function createAnnotationAccess(deps: AnnotationAccessDeps): AnnotationAccess {
  const { paths, lock, docMutations, onChanged } = deps;
  /** Throws DocMetadataError when the metadata cannot be read; true for a PDF Doc. */
  const isPdf = (docId: string): boolean => {
    let pdf: unknown;
    try {
      pdf = readPdfMetadataIfPresent(paths, docId);
    } catch (err) {
      throw new DocMetadataError(err);
    }
    return Boolean(pdf);
  };

  function commit<T = never>(
    docId: string,
    expect: { fingerprint: string; rev: number },
    build: (
      epoch: AnnotationsEpoch
    ) => { next: AnnotationsFile; preserveUnknown?: boolean } | { skip: T }
  ): Promise<AnnotationsCommit<T>> {
    let saved = false;
    const outcome = lock.run((): AnnotationsCommit<T> => {
      if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
      if (isPdf(docId)) return { kind: "pdf" };
      const ensured = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
      if (ensured.invalidated) onChanged(docId, "invalidate");
      const archived: Archived = ensured.invalidated
        ? { archived: ensured.archivedCount ?? 0 }
        : {};
      const current = ensured.file;
      if (expect.fingerprint !== current.content_fingerprint)
        return { kind: "document_changed", file: current, ...archived };
      if (expect.rev !== current.rev)
        return { kind: "rev_mismatch", rev: current.rev, ...archived };
      const built = build(ensured);
      if ("skip" in built)
        return { kind: "skipped", file: current, value: built.skip, ...archived };
      saveAnnotationsFile(paths.dataDir, docId, built.next, {
        bumpRev: true,
        ...(built.preserveUnknown ? { preserveUnknown: true } : {}),
      });
      saved = true;
      return { kind: "saved", file: { ...built.next, rev: built.next.rev + 1 }, ...archived };
    });
    return outcome.then((result) => {
      if (saved) onChanged(docId, "put");
      return result;
    });
  }

  const read = (docId: string): Promise<AnnotationsRead> =>
    lock.run((): AnnotationsRead => {
      if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
      if (isPdf(docId)) return { kind: "pdf" };
      const epoch = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
      if (epoch.invalidated) onChanged(docId, "invalidate");
      return { kind: "ok", epoch };
    });

  const peek = (docId: string): Promise<AnnotationsPeek> =>
    lock.run((): AnnotationsPeek => {
      if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
      if (isPdf(docId)) return { kind: "pdf" };
      return { kind: "ok", reading: readDocumentForReading(paths.dataDir, docId) };
    });

  const together = <T>(run: (access: TogetherAccess) => T): Promise<T> =>
    lock.run(
      (): T =>
        run({
          busy: (docId) => docMutations.isDocumentContentBusy(docId),
          ensure: (docId) => {
            if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
            if (isPdf(docId)) return { kind: "pdf" };
            const epoch = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
            if (epoch.invalidated) onChanged(docId, "invalidate");
            return { kind: "ok", epoch };
          },
        })
    );

  const describeError = (err: AnnotationsError): { status: 404 | 500; detail: string } => {
    switch (err.code) {
      case "corrupt_ir":
        return {
          status: 500,
          detail:
            "the stored document is damaged or outdated and cannot be read; nothing was changed",
        };
      case "corrupt_store":
        return {
          status: 500,
          detail: "the saved annotations file is damaged; nothing was changed and nothing was read",
        };
      case "fingerprint":
        return {
          status: 500,
          detail:
            "an image or other asset the document declares is missing or unreadable, so the document cannot be verified; nothing was changed",
        };
      case "archive":
        return {
          status: 500,
          detail:
            "the annotations of older text could not be moved to the archive, so the saved annotations were left exactly as they were; nothing was changed",
        };
      case "new_current":
        return {
          status: 500,
          detail:
            "the annotations of older text were archived (they are no longer current), but the new, empty annotations file could not be created, so nothing of your request was written; the next access creates it",
        };
      case "not_found":
        return { status: 404, detail: "no such Doc" };
    }
  };

  return { commit, read, peek, together, describeError };
}
