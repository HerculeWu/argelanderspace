/**
 * M3b golden gate: the TS PDF pipeline must reproduce the frozen Python outputs
 * in `<repo>/tests/golden/` field-for-field.
 *
 * For each archived fixture (`tests/fixtures/pdfminer/<doc_id>/`: the source PDF
 * + the MinerU `<uuid>_content_list.json` cache + a `source.json` provenance
 * manifest) the test runs core's `ingestPdf` fully offline — real mupdf for the
 * link harvest / text-layer probe / textfix clips (see
 * `tests/helpers/pdf-ports.ts`), fixture-replayed MinerU artifacts — parses the
 * emitted `<doc_id>.json`, applies the acquire `_stamp_source` values when the
 * manifest records them, and diffs against the golden recursively.
 *
 * Golden provenance (verified against the Python pipeline 2026-08-26, 0 diff):
 * - `2603.03522` — born-digital user PDF, frozen via `scripts/reprocess.py`
 *   (`build_document` on the cached MinerU tree, default config: `is_ocr` never
 *   set, `batch_id` none).
 * - `ads-1983ApJ...270..365M` — ADS scan, frozen via `acquire.fetch_pdf.
 *   ads_scan_doc`: `ingest_pdf` with `is_ocr=True` forced (auto-detect skipped),
 *   a live MinerU run (`batch_id` recorded in the manifest), then
 *   `_stamp_source(doi, acquired_via)` on the written JSON.
 *
 * Allowlist policy: strict deep equality after JSON parse; every exemption is an
 * explicit per-path entry below with a justification.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ingestPdf } from "../src/pipelines/pdf/pipeline.js";
import { diffJson, type Json } from "./helpers/diff-json.js";
import { loadPdfFixture, testPdfPorts } from "./helpers/pdf-ports.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");

/** The two PDF-pipeline papers with frozen goldens. */
const PAPERS = ["2603.03522", "ads-1983ApJ...270..365M"] as const;

/** How many divergence paths the reporter prints before truncating. */
const MAX_REPORTED_DIFFS = 50;

/**
 * Intentional golden divergences, per path prefix, each with a justification.
 * Everything else — structure, references, citations, crossrefs, textfix stats,
 * `source.filename`/`n_pages`, `meta.mineru.model_version`/`language`/
 * `batch_id` — is compared strictly.
 */
const GOLDEN_ALLOWLIST: ReadonlyArray<{ pathPrefix: string; why: string }> = [
  {
    pathPrefix: "$.source.path",
    why: "absolute path of the input PDF at freeze time (machine-specific); filename/n_pages are diffed strictly",
  },
  {
    pathPrefix: "$.meta.mineru.is_ocr",
    why: "2603.03522's golden was frozen via scripts/reprocess.py (build_document with a default config, is_ocr never set → compacted away); the end-to-end ingestPdf auto-detects the text layer and emits is_ocr=false — the exact value the ingest_pdf-frozen arxivpdf-* outputs carry, value-asserted in the test body. Never fires for the ads scan (forced true, matches golden).",
  },
];

function allowlisted(path: string): boolean {
  return GOLDEN_ALLOWLIST.some((e) => path.startsWith(e.pathPrefix));
}

/** `acquire/fetch_pdf.py::_stamp_source` on the parsed, already-written JSON. */
function stampSource(
  emitted: Json,
  stamp: { doi: string | null; arxiv_id: string | null; acquired_via: string }
): void {
  if (emitted === null || typeof emitted !== "object" || Array.isArray(emitted)) return;
  const existing = emitted.source;
  const src: { [k: string]: Json } =
    existing !== undefined &&
    existing !== null &&
    typeof existing === "object" &&
    !Array.isArray(existing)
      ? existing
      : {};
  emitted.source = src;
  if (stamp.doi) src.doi = stamp.doi;
  if (stamp.arxiv_id) src.arxiv_id = stamp.arxiv_id;
  src.acquired_via = stamp.acquired_via;
  // Python also fills meta.title from the work record when empty — a no-op for
  // the ads scan (the pipeline itself found the title), so it is not replayed.
}

describe("golden-pdf: TS pipeline vs frozen Python output", () => {
  for (const docId of PAPERS) {
    test(`${docId}: 0 field diffs`, async () => {
      const fixture = loadPdfFixture(docId);
      const outDir = mkdtempSync(join(tmpdir(), `golden-pdf-${docId}-`));
      await ingestPdf(fixture.pdfPath, testPdfPorts(fixture), {
        outDir,
        config: { mineru: { isOcr: fixture.manifest.is_ocr } },
      });
      // Compare the *written* file so JSON serialization is covered too.
      const emitted = JSON.parse(readFileSync(join(outDir, `${docId}.json`), "utf-8")) as Json;
      if (fixture.manifest.stamp) stampSource(emitted, fixture.manifest.stamp);
      if (docId === "2603.03522") {
        // The auto-detect provenance delta (allowlisted above): assert the exact
        // value so the exemption can never mask a behaviour change.
        const meta = (emitted as { meta?: { mineru?: { is_ocr?: unknown } } }).meta;
        expect(meta?.mineru?.is_ocr).toBe(false);
      }
      const golden = JSON.parse(
        readFileSync(join(GOLDEN_DIR, fixture.manifest.golden), "utf-8")
      ) as Json;
      const diffs = diffJson(emitted, golden).filter((d) => !allowlisted(d.split(" — ")[0] ?? ""));
      const report = diffs.slice(0, MAX_REPORTED_DIFFS).join("\n");
      expect(
        diffs.length,
        `${diffs.length} field diffs vs golden (first ${Math.min(diffs.length, MAX_REPORTED_DIFFS)}):\n${report}`
      ).toBe(0);
    }, 120_000);
  }
});
