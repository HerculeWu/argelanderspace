/**
 * `GET /api/shelf/add-candidates/:workId` (shelf ticket 05 fix round): what the add dialog lists before the person has
 * chosen anything — READ ONLY. Annotations come through the access path's `peek` (no ensure, no archive, no
 * notification; contracts "Shelf" section, local revision one: a Doc whose annotations were not chosen never goes
 * through the ensure). Shape: contracts `ShelfAddCandidates`; docs/library.md "Shelf" section.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isShelfRelativePath,
  type ShelfAddCandidateDoc,
  type ShelfAddCandidates,
  type ShelfDocKind,
  shelfDocFileAllowed,
} from "@argelanderspace/contracts";
import {
  AnnotationsError,
  isTextDocId,
  type LibraryPaths,
  LibraryStore,
  readPdfMetadataIfPresent,
} from "@argelanderspace/core";
import type { AnnotationAccess } from "./annotations-access.js";
import type { ProtectedRoutes } from "./protected-app.js";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Bytes of the files the Shelf would carry for this Doc (the same file rule as an add); null when not countable. */
function carriedBytes(kind: ShelfDocKind, docId: string, docDir: string): number | null {
  try {
    let total = 0;
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(docDir, rel), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (
          entry.isFile() &&
          isShelfRelativePath(path) &&
          shelfDocFileAllowed(kind, docId, path)
        )
          total += lstatSync(join(docDir, path)).size;
      }
    };
    for (const entry of readdirSync(docDir, { withFileTypes: true })) {
      if (entry.name === "assets" && kind !== "pdf" && entry.isDirectory()) {
        walk("assets");
        continue;
      }
      if (entry.isFile() && shelfDocFileAllowed(kind, docId, entry.name))
        total += lstatSync(join(docDir, entry.name)).size;
    }
    return total;
  } catch {
    return null;
  }
}

export interface ShelfCandidateDeps {
  paths: LibraryPaths;
  annotations: Pick<AnnotationAccess, "peek">;
}

export function mountShelfCandidateRoute(routes: ProtectedRoutes, deps: ShelfCandidateDeps): void {
  const { paths } = deps;
  routes.get("/api/shelf/add-candidates/:workId", { guard: true, noStore: true }, async (c) => {
    const workId = c.req.param("workId");
    let store: LibraryStore;
    try {
      store = LibraryStore.load(paths);
    } catch {
      return c.json(
        { detail: "the library file could not be read", code: "library_unreadable" },
        500,
        NO_STORE
      );
    }
    const work = store.get(workId);
    if (!work)
      return c.json(
        { detail: "there is no such Work in this project", code: "work_not_found" },
        404,
        NO_STORE
      );
    const docs: ShelfAddCandidateDoc[] = [];
    for (const docId of [...new Set(work.doc_ids)]) {
      let kind: ShelfDocKind = "latex";
      let metadataProblem = false;
      if (isTextDocId(docId)) kind = "text";
      else {
        try {
          if (readPdfMetadataIfPresent(paths, docId)) kind = "pdf";
        } catch {
          // The PDF metadata is there but cannot be read: still a PDF Doc, shown as one.
          kind = "pdf";
          metadataProblem = true;
        }
      }
      const bytes = carriedBytes(kind, docId, join(paths.outputDir, docId));
      let annotations: ShelfAddCandidateDoc["annotations"];
      if (metadataProblem) annotations = { state: "unreadable", code: "metadata" };
      else if (kind === "pdf") annotations = { state: "pdf" };
      else {
        try {
          const peeked = await deps.annotations.peek(docId);
          if (peeked.kind === "busy") annotations = { state: "busy" };
          else if (peeked.kind === "pdf") annotations = { state: "pdf" };
          else if (peeked.reading.stale) annotations = { state: "stale" };
          else annotations = { state: "current", list: peeked.reading.file.annotations };
        } catch (err) {
          // Only the access path's own system errors and file errors are answers; a programming error goes to the app.
          const errno = (err as { code?: unknown } | null)?.code;
          if (!(err instanceof AnnotationsError) && typeof errno !== "string") throw err;
          const code = err instanceof AnnotationsError ? err.code : String(errno);
          // A text Doc never generated has no reading text to bind annotations to: nothing to list.
          annotations =
            kind === "text" && code === "not_found"
              ? { state: "none" }
              : { state: "unreadable", code };
        }
      }
      docs.push({ docId, kind, bytes, annotations });
    }
    const answer: ShelfAddCandidates = { workId, docs };
    return c.json(answer, 200, NO_STORE);
  });
}
