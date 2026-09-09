/**
 * `attachLatexZip` (Stage 3.1 MS2): the LaTeX-zip upload's core orchestration
 * with a stubbed `ingestLatexZip` (no pandoc — the pipeline itself is covered
 * in infra) but the REAL `rebuild`, so the stamp → seed-merge → relink chain
 * is exercised end to end:
 *
 * - a DOI/arXiv work: the doc merges by identifier, no duplicate work;
 * - a title-only work: `meta.title` is overridden with the work's title so
 *   the title-slug merge cannot miss (the archived attachPdf's duplicate-work
 *   hazard), and a re-upload overwrites the same idempotent doc id;
 * - the post-rebuild validation: a doc that never lands in `doc_ids` fails.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TexDocIr } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import type { IngestPipelines } from "../src/acquire/pipelines.js";
import { attachLatexZip, uploadDocId } from "../src/acquire/upload.js";
import { patchWork, rebuild } from "../src/library/build.js";
import type { MetadataSources } from "../src/library/sources.js";
import {
  canonicalId,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  type Work,
} from "../src/library/store.js";

/** Every lookup misses; no network, no enrichment side effects. */
function stubSources(): MetadataSources {
  return {
    ads: { status: "no-token", resolve: async () => null },
    crossref: { resolve: async () => null },
    oa: { resolve: async () => null, fetchMany: async () => new Map() },
  };
}

interface StubOpts {
  /** The doc's own \title-derived title (stamping may override it). */
  docTitle?: string;
  /** Write the doc json, then vanish the doc dir (validation-guard probe). */
  vanish?: boolean;
}

/** A pipeline whose zip ingest just writes a tiny doc json, like the real one. */
function stubPipelines(opts: StubOpts = {}): IngestPipelines {
  return {
    ingestLatex: async () => {
      throw new Error("not used by attachLatexZip");
    },
    ingestLatexZip: async (_zipPath, { outRoot, docId, onProgress }) => {
      const dir = join(outRoot, docId);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.tex"), "\\documentclass{article}\n");
      const ir: TexDocIr = {
        version: 1,
        docId,
        sections: [],
        refsManifest: [],
        bib: [],
        citationsByBlock: {},
        source: { type: "latex", origin: join(dir, "src"), main_tex: "main.tex" },
        meta: { title: opts.docTitle ?? "The Uploaded Title" },
      };
      writeFileSync(join(dir, `${docId}.json`), JSON.stringify(ir));
      onProgress?.("stub ingest");
      if (opts.vanish) rmSync(dir, { recursive: true, force: true });
      return ir;
    },
  };
}

const DOI_WORK: Work = {
  ...emptyWork("doi:10.1234/example"),
  title: "The DOI Paper",
  authors: ["Doe"],
  year: 2021,
  doi: "10.1234/example",
};

const TITLE_WORK_ID = canonicalId({ title: "A Lonely Paper", year: 2020 });
const TITLE_WORK: Work = {
  ...emptyWork(TITLE_WORK_ID),
  title: "A Lonely Paper",
  authors: ["Roe"],
  year: 2020,
};

let paths: LibraryPaths;
let zipPath: string;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "attach-latex-zip-"));
  paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  const store = new LibraryStore([structuredClone(DOI_WORK), structuredClone(TITLE_WORK)]);
  store.save(paths);
  zipPath = join(dataDir, "upload.zip");
  writeFileSync(zipPath, "PK fake — the stub never reads it");
});

function readDocJson(docId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(paths.outputDir, docId, `${docId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function workIds(): string[] {
  return LibraryStore.load(paths).works.map((w) => w.id);
}

describe("uploadDocId", () => {
  test("stable, slug-capped at 44 chars, hash-suffixed against collisions", () => {
    expect(uploadDocId("arxiv:2603.03522")).toMatch(/^upload-arxiv-2603-03522-[0-9a-f]{6}$/);
    expect(uploadDocId("doi:10.1234/example")).toBe(uploadDocId("doi:10.1234/example"));
    // two ids whose 44-char slug prefixes coincide must still differ
    const p = `work:${"a".repeat(60)}`;
    const a = uploadDocId(`${p}-x`);
    const b = uploadDocId(`${p}-y`);
    expect(a.slice(0, 51)).toBe(b.slice(0, 51)); // same "upload-<slug44>-" head
    expect(a).not.toBe(b); // distinct hash tail
    expect(a.length).toBe("upload-".length + 44 + 1 + 6);
  });
});

describe("attachLatexZip", () => {
  test("doi work: stamped + merged by identifier, doc title kept", async () => {
    const ref = await attachLatexZip(
      zipPath,
      { workId: DOI_WORK.id },
      {
        paths,
        pipelines: stubPipelines({ docTitle: "Parsed From Source" }),
        sources: stubSources(),
      }
    );
    expect(ref.id).toBe(DOI_WORK.id);
    const docId = uploadDocId(DOI_WORK.id);
    const doc = readDocJson(docId);
    const src = doc.source as Record<string, unknown>;
    expect(src.doi).toBe("10.1234/example");
    expect(src.acquired_via).toBe("user_latex_zip");
    // meta.title is only backfilled, never overridden, when ids exist
    expect((doc.meta as Record<string, unknown>).title).toBe("Parsed From Source");
    // attached, and no duplicate work appeared
    const store = LibraryStore.load(paths);
    expect(store.get(DOI_WORK.id)?.doc_ids).toContain(docId);
    expect(workIds().sort()).toEqual([DOI_WORK.id, TITLE_WORK_ID].sort());
  });

  test("arxiv work: source.arxiv_id stamped (seed merges on the arxiv key)", async () => {
    const store = LibraryStore.load(paths);
    const w = store.get(TITLE_WORK_ID) as Work;
    w.arxiv_id = "2601.00001";
    store.save(paths);
    await attachLatexZip(
      zipPath,
      { workId: TITLE_WORK_ID },
      { paths, pipelines: stubPipelines(), sources: stubSources() }
    );
    const doc = readDocJson(uploadDocId(TITLE_WORK_ID));
    expect((doc.source as Record<string, unknown>).arxiv_id).toBe("2601.00001");
    expect(workIds()).toHaveLength(2);
  });

  test("title-only work: meta.title overridden, doc welds to the original work", async () => {
    const progress: string[] = [];
    const ref = await attachLatexZip(
      zipPath,
      { workId: TITLE_WORK_ID },
      {
        paths,
        pipelines: stubPipelines({ docTitle: "A Completely Different Parsed Title" }),
        sources: stubSources(),
        onProgress: (m) => progress.push(m),
      }
    );
    expect(ref.id).toBe(TITLE_WORK_ID);
    const docId = uploadDocId(TITLE_WORK_ID);
    // the work's own title overwrote the parsed one
    const doc = readDocJson(docId);
    expect((doc.meta as Record<string, unknown>).title).toBe("A Lonely Paper");
    expect(doc.source as Record<string, unknown>).not.toHaveProperty("doi");
    // no duplicate work spawned from the parsed title
    expect(workIds().sort()).toEqual([DOI_WORK.id, TITLE_WORK_ID].sort());
    expect(LibraryStore.load(paths).get(TITLE_WORK_ID)?.doc_ids).toEqual([docId]);
    expect(progress).toEqual(["Unpacking LaTeX source zip", "stub ingest", "Rebuilding library"]);
  });

  test("re-upload of the same work overwrites the same doc (idempotent)", async () => {
    const deps = { paths, sources: stubSources() };
    await attachLatexZip(
      zipPath,
      { workId: TITLE_WORK_ID },
      { ...deps, pipelines: stubPipelines() }
    );
    const docId = uploadDocId(TITLE_WORK_ID);
    // second upload with a *different* parsed title: same doc id, still one link
    await attachLatexZip(
      zipPath,
      { workId: TITLE_WORK_ID },
      { ...deps, pipelines: stubPipelines({ docTitle: "Second Take" }) }
    );
    const w = LibraryStore.load(paths).get(TITLE_WORK_ID);
    expect(w?.doc_ids).toEqual([docId]);
    expect(workIds()).toHaveLength(2);
    expect(existsSync(join(paths.outputDir, docId, `${docId}.json`))).toBe(true);
  });

  test("rebuild after stamping is merge-stable (repeated rebuilds change nothing)", async () => {
    await attachLatexZip(
      zipPath,
      { workId: TITLE_WORK_ID },
      { paths, pipelines: stubPipelines(), sources: stubSources() }
    );
    const once = readFileSync(paths.libraryJson, "utf8");
    await rebuild(paths, { sources: stubSources() });
    const twice = readFileSync(paths.libraryJson, "utf8");
    expect(JSON.parse(twice)).toEqual(JSON.parse(once));
  });

  // Stage 7 MS3: the upload doc becomes the MAIN doc (doc_ids[0]); older
  // versions stay listed for look-back, and the seed merge must not shuffle
  // the main doc back on rebuild.
  const OLD_DOC_ID = "arxiv-2401.09999";

  /** Attach a fake arXiv-ingested doc to DOI_WORK (on disk + in doc_ids). */
  function attachOldDoc(): void {
    const dir = join(paths.outputDir, OLD_DOC_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${OLD_DOC_ID}.json`),
      JSON.stringify({
        version: 1,
        docId: OLD_DOC_ID,
        source: { type: "latex", doi: "10.1234/example" },
        meta: { title: "The DOI Paper" },
      })
    );
    const store = LibraryStore.load(paths);
    const w = store.get(DOI_WORK.id) as Work;
    w.doc_ids = [OLD_DOC_ID];
    store.save(paths);
  }

  test("work with an existing doc: upload becomes main, old version retained", async () => {
    attachOldDoc();
    const ref = await attachLatexZip(
      zipPath,
      { workId: DOI_WORK.id },
      { paths, pipelines: stubPipelines(), sources: stubSources() }
    );
    const docId = uploadDocId(DOI_WORK.id);
    expect(ref.doc_id).toBe(docId);
    expect(ref.doc_ids).toEqual([docId, OLD_DOC_ID]);
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual([docId, OLD_DOC_ID]);
    expect(workIds()).toHaveLength(2); // no duplicate work from the old doc
    // a further rebuild keeps the uploaded doc in the main slot
    await rebuild(paths, { sources: stubSources() });
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual([docId, OLD_DOC_ID]);
  });

  test("re-upload after a user main-doc switch reclaims the main slot", async () => {
    attachOldDoc();
    const docId = uploadDocId(DOI_WORK.id);
    const deps = { paths, sources: stubSources() };
    await attachLatexZip(zipPath, { workId: DOI_WORK.id }, { ...deps, pipelines: stubPipelines() });
    // the user switches the main doc back to the arXiv version
    expect(patchWork(paths, DOI_WORK.id, { doc_id: OLD_DOC_ID })).toBe(true);
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual([OLD_DOC_ID, docId]);
    // a re-upload (new version, same idempotent doc id) is main again
    await attachLatexZip(
      zipPath,
      { workId: DOI_WORK.id },
      { ...deps, pipelines: stubPipelines({ docTitle: "Second Take" }) }
    );
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual([docId, OLD_DOC_ID]);
  });

  test("weld clobbered mid-flight: the post-rebuild re-assert restores the main slot (N1)", async () => {
    attachOldDoc();
    const docId = uploadDocId(DOI_WORK.id);
    // Simulate the race: a concurrent PATCH overwrote the weld's save, so the
    // rebuild's seed merge re-attached the upload doc at the TAIL of doc_ids.
    const clobberedRebuild: typeof rebuild = async (p) => {
      const store = LibraryStore.load(p);
      const w = store.get(DOI_WORK.id) as Work;
      w.doc_ids = [OLD_DOC_ID, docId];
      store.save(p);
      return {
        works: store.works.length,
        bib_entries: 0,
        saved_nodes: 0,
        nodes: 0,
        links: 0,
        ads_status: "no-token",
        acquisition: { chosen: {}, ready_now: {}, status: {}, ingested: 0 },
        resolution: { count_source: {} },
      };
    };
    // the server injects a lock-wrapped patchWork here; the spy both proves
    // the delegation and applies the real move-to-front
    const calls: [string, string][] = [];
    const ref = await attachLatexZip(
      zipPath,
      { workId: DOI_WORK.id },
      {
        paths,
        pipelines: stubPipelines(),
        sources: stubSources(),
        rebuild: clobberedRebuild,
        reassertMainDoc: async (p, workId, d) => {
          calls.push([workId, d]);
          return patchWork(p, workId, { doc_id: d });
        },
      }
    );
    expect(calls).toEqual([[DOI_WORK.id, docId]]);
    expect(ref.doc_ids).toEqual([docId, OLD_DOC_ID]);
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual([docId, OLD_DOC_ID]);
  });

  test("patchWork doc_id: move-to-front; a no-op doc_id neither saves nor returns true (N5)", () => {
    attachOldDoc();
    const store = LibraryStore.load(paths);
    const w = store.get(DOI_WORK.id) as Work;
    w.doc_ids = [OLD_DOC_ID, "upload-x"];
    store.save(paths);
    expect(patchWork(paths, DOI_WORK.id, { doc_id: "upload-x" })).toBe(true);
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual(["upload-x", OLD_DOC_ID]);
    // foreign doc id: no state change → no save, returns false
    const mtime = statSync(paths.libraryJson).mtimeMs;
    expect(patchWork(paths, DOI_WORK.id, { doc_id: "arxiv-not-held" })).toBe(false);
    expect(statSync(paths.libraryJson).mtimeMs).toBe(mtime);
    // already-main doc id: same no-op semantics
    expect(patchWork(paths, DOI_WORK.id, { doc_id: "upload-x" })).toBe(false);
    expect(statSync(paths.libraryJson).mtimeMs).toBe(mtime);
    expect(LibraryStore.load(paths).get(DOI_WORK.id)?.doc_ids).toEqual(["upload-x", OLD_DOC_ID]);
  });

  test("unknown work throws the identify-a-work message", async () => {
    await expect(
      attachLatexZip(
        zipPath,
        { workId: "doi:10.0000/ghost" },
        { paths, pipelines: stubPipelines(), sources: stubSources() }
      )
    ).rejects.toThrow(
      "no matching work in the library (id='doi:10.0000/ghost' doi=None arxiv=None)"
    );
  });

  test("pipeline output that vanishes before stamping fails the attach", async () => {
    await expect(
      attachLatexZip(
        zipPath,
        { workId: TITLE_WORK_ID },
        { paths, pipelines: stubPipelines({ vanish: true }), sources: stubSources() }
      )
    ).rejects.toThrow();
  });

  test("post-rebuild validation: doc_ids without the new doc id → throw", async () => {
    // A rebuild that returns with the link missing (however that happened —
    // the guard exists so this can never masquerade as a successful upload).
    const stripRebuild: typeof rebuild = async (p) => {
      const store = LibraryStore.load(p);
      for (const w of store.works) w.doc_ids = [];
      store.save(p);
      return {
        works: store.works.length,
        bib_entries: 0,
        saved_nodes: 0,
        nodes: 0,
        links: 0,
        ads_status: "no-token",
        acquisition: { chosen: {}, ready_now: {}, status: {}, ingested: 0 },
        resolution: { count_source: {} },
      };
    };
    await expect(
      attachLatexZip(
        zipPath,
        { workId: TITLE_WORK_ID },
        {
          paths,
          pipelines: stubPipelines(),
          sources: stubSources(),
          rebuild: stripRebuild,
        }
      )
    ).rejects.toThrow(`did not attach to work '${TITLE_WORK_ID}'`);
  });
});
