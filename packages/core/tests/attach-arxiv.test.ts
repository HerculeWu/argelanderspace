/**
 * `attachArxivDoc` (Stage 15): the arXiv e-print attach/refresh counterpart
 * of `attachLatexZip` (see attach-latex-zip.test.ts) — stubbed
 * `ingestArxivEprint` (no network/latexmk) but the REAL `rebuild`, exercising
 * the stamp → weld → seed-merge → relink chain end to end:
 *
 * - the D16 scenario table (`arxivAttachScenario`): attach (docless work) /
 *   refresh (same arXiv doc already listed — order + main pointer preserved)
 *   / skip (only other, user content — never clobbered);
 * - identity welding: `source.doi`/`source.arxiv_id` + `acquired_via =
 *   "arxiv_eprint"` stamped before the rebuild (D3, upload-chain parity);
 * - the main-doc re-assert runs on attach only (a refresh keeps its slot);
 * - the post-rebuild validation: a doc that never lands in `doc_ids` fails.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TexDocIr } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import {
  ARXIV_ATTACH_VIA,
  arxivAttachScenario,
  arxivDocId,
  attachArxivDoc,
} from "../src/acquire/attach-arxiv.js";
import type { IngestPipelines } from "../src/acquire/pipelines.js";
import { rebuild } from "../src/library/build.js";
import type { MetadataSources } from "../src/library/sources.js";
import {
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  type Work,
} from "../src/library/store.js";

/** Every lookup misses; no network, no enrichment side effects. */
function stubSources(): MetadataSources {
  return {
    ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
    crossref: { resolve: async () => null },
    oa: { resolve: async () => null },
  };
}

interface StubOpts {
  /** Throw mid-ingest (download/extract/compile failure probe). */
  fail?: string;
  /** Write the doc json, then vanish the doc dir (validation-guard probe). */
  vanish?: boolean;
  /** New IR title after the refresh (default "Fresh arXiv IR"). */
  title?: string;
}

/** Pipeline stub calls in order (the e-print arxiv ids). */
let pipelineCalls: string[];

function stubPipelines(opts: StubOpts = {}): IngestPipelines {
  return {
    ingestLatex: async () => {
      throw new Error("not used by attachArxivDoc");
    },
    ingestLatexZip: async () => {
      throw new Error("not used by attachArxivDoc");
    },
    ingestArxivEprint: async (arxivId, { outRoot, docId, onProgress }) => {
      pipelineCalls.push(arxivId);
      if (opts.fail) throw new Error(opts.fail);
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
        source: {
          type: "latex",
          origin: join(dir, "src"),
          main_tex: "main.tex",
          arxiv_id: arxivId,
        },
        meta: { title: opts.title ?? "Fresh arXiv IR" },
      };
      writeFileSync(join(dir, `${docId}.json`), JSON.stringify(ir));
      onProgress?.("stub e-print ingest");
      if (opts.vanish) rmSync(dir, { recursive: true, force: true });
      return ir;
    },
  };
}

/** A docless work whose only identity is its arXiv id. */
const ARXIV_WORK: Work = {
  ...emptyWork("arxiv:2501.17225"),
  title: "The arXiv Paper",
  authors: ["Doe"],
  year: 2024,
  arxiv_id: "2501.17225",
};

/** A docless work with both identities (the bibcode-mode shape). */
const DOI_WORK: Work = {
  ...emptyWork("doi:10.1234/example"),
  title: "The DOI Paper",
  authors: ["Roe"],
  year: 2021,
  doi: "10.1234/example",
  arxiv_id: "2501.17225",
};

let paths: LibraryPaths;

function saveStore(works: Work[]): void {
  new LibraryStore(works.map((w) => structuredClone(w))).save(paths);
}

function loadStore(): LibraryStore {
  return LibraryStore.load(paths);
}

function readDocJson(docId: string): {
  source?: Record<string, unknown>;
  meta?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(paths.outputDir, docId, `${docId}.json`), "utf8")) as {
    source?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
}

/** Pre-create a stored doc dir the seed merge can link back to the work. */
function writeDocDir(docId: string, arxivId: string, title: string): void {
  const dir = join(paths.outputDir, docId);
  mkdirSync(dir, { recursive: true });
  const ir: TexDocIr = {
    version: 1,
    docId,
    sections: [],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: dir, main_tex: "main.tex", arxiv_id: arxivId },
    meta: { title },
  };
  writeFileSync(join(dir, `${docId}.json`), JSON.stringify(ir));
}

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "attach-arxiv-"));
  paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  pipelineCalls = [];
});

describe("arxivDocId", () => {
  test("unversioned, sanitized, stable", () => {
    expect(arxivDocId("2501.17225")).toBe("arxiv-2501.17225");
    expect(arxivDocId("astro-ph/9707253")).toBe("arxiv-astro-ph-9707253");
    expect(arxivDocId("2501.17225")).toBe(arxivDocId("2501.17225"));
  });
});

describe("arxivAttachScenario (D16 table)", () => {
  const docId = arxivDocId("2501.17225");
  test("docless work → attach", () => {
    expect(arxivAttachScenario({ ...ARXIV_WORK, doc_ids: [] }, docId)).toBe("attach");
  });
  test("same arXiv doc listed → refresh (even with other docs present)", () => {
    expect(arxivAttachScenario({ ...ARXIV_WORK, doc_ids: [docId] }, docId)).toBe("refresh");
    expect(arxivAttachScenario({ ...ARXIV_WORK, doc_ids: ["upload-x", docId] }, docId)).toBe(
      "refresh"
    );
  });
  test("only other (user) docs → skip", () => {
    expect(arxivAttachScenario({ ...ARXIV_WORK, doc_ids: ["upload-x"] }, docId)).toBe("skip");
  });

  test("all-PDF Docs allow an append; mixed LaTeX/user Docs keep legacy skip", () => {
    const isPdfDoc = (id: string) => id.startsWith("pdf-");
    expect(
      arxivAttachScenario({ ...ARXIV_WORK, doc_ids: ["pdf-a", "pdf-b"] }, docId, isPdfDoc)
    ).toBe("append");
    expect(
      arxivAttachScenario({ ...ARXIV_WORK, doc_ids: ["pdf-a", "upload-zip"] }, docId, isPdfDoc)
    ).toBe("skip");
  });

  test("PDF-only Work appends LaTeX without treating an unrelated LaTeX Doc as eligible", () => {
    const pdfOnly = { ...ARXIV_WORK, doc_ids: ["pdf-a", "pdf-b"] };
    const isPdfDoc = (id: string) => id.startsWith("pdf-");
    expect(arxivAttachScenario(pdfOnly, docId, isPdfDoc)).toBe("append");
    expect(
      arxivAttachScenario({ ...pdfOnly, doc_ids: ["pdf-a", "upload-zip"] }, docId, isPdfDoc)
    ).toBe("skip");
  });
});

describe("attachArxivDoc", () => {
  test("attach: docless work gains the doc as main, identity welded", async () => {
    saveStore([ARXIV_WORK]);
    const reassert: Array<[string, string]> = [];
    const res = await attachArxivDoc(ARXIV_WORK.id, {
      paths,
      pipelines: stubPipelines(),
      sources: stubSources(),
      reassertMainDoc: async (_p, wid, d) => {
        reassert.push([wid, d]);
        return true;
      },
    });
    const docId = arxivDocId("2501.17225");
    expect(res.status).toBe("attached");
    expect(res.docId).toBe(docId);
    expect(pipelineCalls).toEqual(["2501.17225"]);
    const w = loadStore().get(ARXIV_WORK.id);
    expect(w?.doc_ids).toEqual([docId]); // docless → the new doc is main
    const doc = readDocJson(docId);
    expect(doc.source?.arxiv_id).toBe("2501.17225");
    expect(doc.source?.acquired_via).toBe(ARXIV_ATTACH_VIA);
    expect(reassert).toEqual([[ARXIV_WORK.id, docId]]);
    expect(res.ref?.doc_id).toBe(docId);
  });

  test("attach a doi+arxiv work: both identities stamped", async () => {
    saveStore([DOI_WORK]);
    const res = await attachArxivDoc(DOI_WORK.id, {
      paths,
      pipelines: stubPipelines(),
      sources: stubSources(),
    });
    expect(res.status).toBe("attached");
    const doc = readDocJson(res.docId);
    expect(doc.source?.doi).toBe("10.1234/example");
    expect(doc.source?.arxiv_id).toBe("2501.17225");
    expect(doc.source?.acquired_via).toBe(ARXIV_ATTACH_VIA);
    // no duplicate work: the seed merge folded the doc into the same work
    expect(loadStore().works.filter((x) => x.arxiv_id === "2501.17225")).toHaveLength(1);
  });

  test("refresh: same doc id overwritten in place, order/main preserved, no re-assert", async () => {
    const docId = arxivDocId("2501.17225");
    writeDocDir("upload-aaa", "2501.17225", "User Upload");
    writeDocDir(docId, "2501.17225", "Old arXiv IR");
    saveStore([{ ...ARXIV_WORK, doc_ids: ["upload-aaa", docId] }]);
    let reasserted = false;
    const res = await attachArxivDoc(ARXIV_WORK.id, {
      paths,
      pipelines: stubPipelines({ title: "Fresh arXiv IR v2" }),
      sources: stubSources(),
      reassertMainDoc: async () => {
        reasserted = true;
        return true;
      },
    });
    expect(res.status).toBe("refreshed");
    const w = loadStore().get(ARXIV_WORK.id);
    expect(w?.doc_ids).toEqual(["upload-aaa", docId]); // untouched
    expect(readDocJson(docId).meta?.title).toBe("Fresh arXiv IR v2"); // new over old
    expect(reasserted).toBe(false);
  });

  test("skip (execution-time re-check): only user content → no pipeline, no rebuild", async () => {
    writeDocDir("upload-aaa", "2501.17225", "User Upload");
    saveStore([{ ...ARXIV_WORK, doc_ids: ["upload-aaa"] }]);
    let rebuilt = false;
    const res = await attachArxivDoc(ARXIV_WORK.id, {
      paths,
      pipelines: stubPipelines(),
      sources: stubSources(),
      rebuild: async (p, o) => {
        rebuilt = true;
        return rebuild(p, o);
      },
    });
    expect(res.status).toBe("skipped");
    expect(res.ref).toBeNull();
    expect(pipelineCalls).toEqual([]);
    expect(rebuilt).toBe(false);
    expect(loadStore().get(ARXIV_WORK.id)?.doc_ids).toEqual(["upload-aaa"]);
  });

  test("pipeline failure propagates; the work is untouched", async () => {
    saveStore([ARXIV_WORK]);
    await expect(
      attachArxivDoc(ARXIV_WORK.id, {
        paths,
        pipelines: stubPipelines({ fail: "empty e-print response for 2501.17225" }),
        sources: stubSources(),
      })
    ).rejects.toThrow("empty e-print response");
    expect(loadStore().get(ARXIV_WORK.id)?.doc_ids).toEqual([]);
  });

  test("validation guard: a doc that vanishes before the relink fails the attach", async () => {
    saveStore([ARXIV_WORK]);
    await expect(
      attachArxivDoc(ARXIV_WORK.id, {
        paths,
        pipelines: stubPipelines({ vanish: true }),
        sources: stubSources(),
      })
    ).rejects.toThrow(/did not attach|missing/);
  });

  test("no arXiv id / unknown work are hard errors", async () => {
    saveStore([{ ...ARXIV_WORK, arxiv_id: null }]);
    await expect(
      attachArxivDoc(ARXIV_WORK.id, {
        paths,
        pipelines: stubPipelines(),
        sources: stubSources(),
      })
    ).rejects.toThrow(/no arXiv id/);
    await expect(
      attachArxivDoc("arxiv:does-not-exist", {
        paths,
        pipelines: stubPipelines(),
        sources: stubSources(),
      })
    ).rejects.toThrow(/no such work/);
  });
});
