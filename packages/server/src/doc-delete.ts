/**
 * The Doc global delete (docs/contracts.md "删除生命周期"): `DELETE /api/paper/:doc_id`'s handler and what the
 * delete dialog / the Copilot confirmation card shows before it.
 *
 * ONE instance, made by `createApp`, serves the DELETE route and the Copilot `library` tool (`libraryOps.deletion`).
 * It receives, never makes, the app's one libraryLock (the physical delete and the library step), its one
 * annotationLock (the description's reads) and its one DocMutationRegistry (shared with the text Doc service and the
 * upload/acquisition paths); `onDeleted` is the app's `library.changed{patch}` notification. The HTTP status mapping
 * stays with the route.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DocReplaceImpact } from "@argelanderspace/contracts";
import {
  annotationsDocDir,
  type LibraryPaths,
  LibraryStore,
  type RemovedDocWork,
  readAnnotationRisk,
  readPdfAnnotationsFile,
  readPdfMetadataIfPresent,
  readVerifiedPdf,
  removeDocFromWorksNarrow,
} from "@argelanderspace/core";
import { badDocId } from "./doc-id.js";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { DocDeleteDescription, DocDeleteOutcome, DocDeletionPort } from "./library-actions.js";
import type { AsyncLock } from "./lock.js";
import type { TextDocService } from "./text-docs.js";

export interface DocDeletionDeps {
  paths: LibraryPaths;
  outputDir: string;
  /** The app's one libraryLock (received, never made here). */
  libraryLock: AsyncLock;
  /** The app's one annotationLock: the description reads under it. */
  annotationLock: AsyncLock;
  /** The app's one registry, shared with the text Doc service and the upload/acquisition paths. */
  docMutations: DocMutationRegistry;
  /** The text Doc service's two read-only answers. */
  text: Pick<TextDocService, "has" | "draftAnnotationImpact">;
  /** `library.changed{patch}`: once per completed delete, after the slot is released, outside the lock. */
  onDeleted: () => void;
}

export function createDocDeletion(deps: DocDeletionDeps): DocDeletionPort {
  const {
    paths,
    outputDir,
    libraryLock,
    annotationLock,
    docMutations,
    text: textDocs,
    onDeleted,
  } = deps;

  /**
   * The one global physical delete: `DELETE /api/paper/:doc_id` and the Copilot `library` tool's `delete_doc` (after the
   * real user's confirmation) both come here, with the same busy/404/400 answers. The library step is a NARROW write
   * (`removeDocFromWorksNarrow`: re-read raw library.json, drop the Doc from every Work's doc_ids, nothing else
   * changes, library.bib is untouched); it used to be a typed whole-library save that dropped unknown keys. The raw file
   * must parse BEFORE anything is removed, so an unreadable library.json refuses the delete instead of leaving a
   * half-deleted Doc. Not atomic: the files are removed first, so a failure of the library step (rare) leaves the Doc
   * gone from disk while library.json still lists it; the caller is told and a retry finishes the cleanup.
   */
  const holdersOf = (docId: string) =>
    LibraryStore.load(paths)
      .works.filter((work) => work.doc_ids.includes(docId))
      .map((work) => ({ id: work.id, title: work.title, docIds: [...work.doc_ids] }));
  /** What the lock-time check compares: which Works hold the Doc and their Doc lists (a main-Doc change included). */
  const holdersKey = (held: { id: string; docIds: string[] }[]) =>
    JSON.stringify(held.map(({ id, docIds }) => ({ id, docIds })));

  // Stage 8 §8: GLOBAL physical delete — `output/<doc>/` + `annotations/<doc>/`
  // (current + archive; missing dirs tolerated), then the doc is removed from
  // EVERY work's `doc_ids` (one doc can appear in several works via identity
  // merge; core `removeDocFromWorksNarrow` is the all-works traversal). "Doc exists"
  // here means the output DIRECTORY (not its JSON, unlike the IR route): a
  // retry after a mid-delete failure — which may already have unlinked the
  // JSON — must be able to finish the cleanup, and a hollow failed-ingest dir
  // is deletable too. A doc with no output dir at all 404s; its annotations,
  // if any, stay behind as orphans (roadmap 推后: no access guarantee, no
  // auto-cleanup). Ordering: busy-check before any mutation (a queued/running
  // upload of this doc — or any refresh — answers 409 "document busy", never
  // waits; the registry claim is atomic with the check); the physical delete
  // runs BEFORE the library update, so a mid-delete failure reports 500 with
  // library.json untouched; both run under libraryLock so no library write
  // can interleave. No rebuild/enrich is triggered.
  const deleteDocGlobally = async (
    docId: string,
    /** The Copilot tool passes what its confirmation showed; the page's own route has no such binding. */
    expect?: { holders: string }
  ): Promise<DocDeleteOutcome> => {
    if (!docId.trim() || badDocId(docId)) return { kind: "bad_id" };
    const docDir = join(outputDir, docId);
    if (!existsSync(docDir) || !statSync(docDir).isDirectory()) return { kind: "not_found" };
    if (!docMutations.tryBeginDelete(docId)) return { kind: "busy" };
    let works: RemovedDocWork[] = [];
    let changed = false;
    try {
      await libraryLock.run(() => {
        // The library file must be a readable object with a works array BEFORE anything is removed.
        if (existsSync(paths.libraryJson)) {
          const parsed: unknown = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Array.isArray((parsed as { works?: unknown }).works)
          )
            throw new Error("library.json is not a library file");
        }
        // The card was approved for these holders: if a library write got in first, nothing is deleted.
        if (expect && holdersKey(holdersOf(docId)) !== expect.holders) {
          changed = true;
          return;
        }
        rmSync(docDir, { recursive: true, force: true });
        rmSync(annotationsDocDir(paths.dataDir, docId), { recursive: true, force: true });
        works = removeDocFromWorksNarrow(paths, docId).works;
      });
    } catch (err) {
      return { kind: "failed", message: (err as Error).message };
    } finally {
      docMutations.endDelete(docId);
    }
    if (changed) return { kind: "changed" };
    onDeleted();
    return { kind: "deleted", works };
  };

  /**
   * What the delete dialog shows for a Doc, computed WITHOUT writing (no ensure, no archive, never the archive's
   * content): the Works that list it, the current annotation count (LaTeX: the same read-only read as the CLI `annot`,
   * a stale file counts 0 and the next normal access archives it; PDF: the verified sidecar) and the digest a
   * Copilot confirmation card is bound to. A count that cannot be read is `unknown`, never zero. A busy Doc (an
   * upload/refresh pins it, or it is being deleted) is `busy`: no card is worth showing, the delete would be refused.
   */
  const describeDocDelete = async (docId: string): Promise<DocDeleteDescription> => {
    if (!docId.trim() || badDocId(docId)) return { kind: "bad_id" };
    const docDir = join(outputDir, docId);
    if (!existsSync(docDir) || !statSync(docDir).isDirectory()) return { kind: "not_found" };
    if (docMutations.isBusy(docId) || docMutations.isDeleting(docId)) return { kind: "busy" };
    let held: { id: string; title: string; docIds: string[] }[];
    try {
      held = holdersOf(docId);
    } catch {
      return { kind: "error", detail: "the library could not be read" };
    }
    // The Files tab only offers Docs a Work lists; an orphan directory is not reachable from the page.
    if (held.length === 0) return { kind: "orphan" };
    return annotationLock.run((): DocDeleteDescription => {
      let format: "pdf" | "latex" | "text" = textDocs.has(docId) ? "text" : "latex";
      let impact: DocReplaceImpact = { annotations: "unknown" };
      let rev = 0;
      let bound: Record<string, unknown> = {};
      let pdf: ReturnType<typeof readPdfMetadataIfPresent> = null;
      let pdfUnreadable = false;
      try {
        pdf = readPdfMetadataIfPresent(paths, docId);
      } catch {
        pdfUnreadable = true;
      }
      if (pdf || (pdfUnreadable && existsSync(join(docDir, "original.pdf")))) format = "pdf";
      // A PDF Doc belongs to exactly one Work; anything else is an ownership error and the page counts it as unknown.
      if (pdf && held.length === 1) {
        try {
          readVerifiedPdf(paths, docId);
          const file = readPdfAnnotationsFile(paths, docId);
          impact = { annotations: "known", count: file.annotations.length };
          rev = file.rev;
          bound = { sha256: file.content_sha256 };
        } catch {
          impact = { annotations: "unknown" };
        }
      } else if (format === "text" && !existsSync(join(docDir, `${docId}.json`))) {
        // the same answer as the page's dialog (draftAnnotationImpact): zero only when no annotations dir exists
        const draft = textDocs.draftAnnotationImpact(docId);
        if (!draft.generated && draft.annotations.state === "known") {
          impact = { annotations: "known", count: draft.annotations.count };
          bound = { draft: true };
        }
      } else if (!pdf && !pdfUnreadable) {
        const risk = readAnnotationRisk(paths.dataDir, docId);
        if (risk.state === "known") {
          impact = { annotations: "known", count: risk.count };
          rev = risk.rev;
          bound = { stale: risk.stale, fingerprint: risk.fingerprint };
        }
      }
      const digest = createHash("sha256")
        .update(JSON.stringify({ docId, format, works: held, impact, rev, ...bound }))
        .digest("hex");
      return {
        kind: "ready",
        docId,
        format,
        works: held.map((work) => ({
          id: work.id,
          title: work.title,
          main: work.docIds[0] === docId,
          remaining: new Set(work.docIds.filter((d) => d !== docId)).size,
        })),
        impact,
        rev,
        digest,
        holders: holdersKey(held),
      };
    });
  };

  return {
    describe: (docId) => describeDocDelete(docId),
    delete: (docId, expect) => deleteDocGlobally(docId, expect),
  };
}
