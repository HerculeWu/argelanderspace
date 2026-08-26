/**
 * Offline smoke test of the wired `ingestPdf` (core pipeline + real infra
 * adapters): the MinerU port is short-circuited by a warm on-disk cache (a
 * literal `content_list.json` under `<outDir>/mineru` — the exact probe the
 * Python client makes), while the mupdf link harvest / text-layer probe /
 * textfix provider run for real against the ADS scan fixture PDF. Any network
 * access fails the test via the throwing fetchImpl.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ingestPdf } from "../src/pdf/pipeline.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const PDF_ADS = `${FIXTURES}/ads-1983ApJ...270..365M.pdf`;

const CONTENT_LIST = [
  {
    type: "text",
    text_level: 1,
    text: "A Wired Smoke Paper",
    page_idx: 0,
    bbox: [10, 10, 900, 60],
  },
  {
    type: "text",
    text: "Body text with nothing to resolve.",
    page_idx: 0,
    bbox: [10, 100, 900, 200],
  },
];

const fetchImpl = (() => {
  throw new Error("network access is forbidden in this test");
}) as unknown as typeof fetch;

describe("wired ingestPdf (core pipeline + infra adapters)", () => {
  test("warm MinerU cache + real mupdf adapters produce a Document offline", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "wired-pdf-"));
    const cacheDir = join(outDir, "mineru");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "content_list.json"), JSON.stringify(CONTENT_LIST), "utf-8");

    const doc = await ingestPdf(PDF_ADS, {
      outDir,
      apiKey: "smoke-test",
      fetchImpl,
      config: { mineru: { isOcr: true } }, // forced — auto-detect probe skipped
    });

    expect(doc.doc_id).toBe("ads-1983ApJ...270..365M");
    expect(doc.source?.filename).toBe("ads-1983ApJ...270..365M.pdf");
    expect(doc.source?.n_pages).toBe(6); // from the real mupdf link harvest
    expect(doc.meta?.title).toBe("A Wired Smoke Paper");
    expect(doc.meta?.mineru).toMatchObject({ model_version: "vlm", language: "en", is_ocr: true });
    // textfix ran over the real (OCR) text layer and found no '?'-gaps
    expect(doc.meta?.textfix).toEqual({ gaps_before: 0, gaps_fixed: 0, holders_changed: 0 });

    const written = JSON.parse(
      readFileSync(join(outDir, "ads-1983ApJ...270..365M.json"), "utf-8")
    ) as { doc_id?: string; stats?: { n_paragraphs?: number } };
    expect(written.doc_id).toBe(doc.doc_id);
    expect(written.stats?.n_paragraphs).toBe(1);
  });
});
