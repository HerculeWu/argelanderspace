/**
 * `GET /api/shelf/add-candidates/:workId` through its own mount (shelf-followups ticket 03): the classification of the
 * access path's errors when `peek` is injected. The end-to-end cases (current, stale, damaged, busy, unknown Work)
 * are in shelf-add.test.ts.
 *
 * Hermetic: a throwaway project data dir and Hono `app.request`; no port, no Shelf store.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyWork, type LibraryPaths, LibraryStore, libraryPaths } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { type AnnotationAccess, DocMetadataError } from "../src/annotations-access.js";
import { silentLog } from "../src/log.js";
import { createProtectedApp } from "../src/protected-app.js";
import { mountShelfCandidateRoute } from "../src/shelf-candidates.js";
import { makeDataDir } from "./helpers.js";

const WORK = "doi:10.1234/candidates";
const LATEX = "paper-c";

let paths: LibraryPaths;

beforeEach(() => {
  const dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  const dir = join(paths.outputDir, LATEX);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${LATEX}.json`), "{}");
  const work = emptyWork(WORK);
  Object.assign(work, { title: "Candidates", year: 2021, doc_ids: [LATEX] });
  new LibraryStore([work]).save(paths);
});

function appWith(peek: AnnotationAccess["peek"]): Hono {
  const { hono, routes } = createProtectedApp({ log: silentLog, boundPort: () => undefined });
  mountShelfCandidateRoute(routes, { paths, annotations: { peek } });
  return hono;
}

const candidates = (app: Hono) =>
  app.request(`/api/shelf/add-candidates/${encodeURIComponent(WORK)}`, { method: "GET" });

describe("add-candidates: the access path's errors", () => {
  test("PDF metadata that became unreadable between the two checks is that Doc's unreadable/metadata, not a 500", async () => {
    const app = appWith(async () => {
      throw new DocMetadataError(new SyntaxError("Unexpected token"));
    });
    const res = await candidates(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workId: WORK,
      docs: [
        {
          docId: LATEX,
          // PDF metadata is what the access path found, so this is a PDF Doc, as in the first check's metadata branch
          kind: "pdf",
          bytes: expect.any(Number),
          annotations: { state: "unreadable", code: "metadata" },
        },
      ],
    });
  });

  test("a programming error still goes to the app (500), not into the answer", async () => {
    const app = appWith(async () => {
      throw new TypeError("a bug");
    });
    const res = await candidates(app);
    expect(res.status).toBe(500);
  });
});
