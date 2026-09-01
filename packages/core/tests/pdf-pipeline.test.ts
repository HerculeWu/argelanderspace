/**
 * Unit tests for the PDF pipeline composition (`pipelines/pdf/pipeline.ts`) with
 * fake ports — these pin the orchestration semantics of `bibgraph/pipeline.py`
 * that the golden gate cannot see: OCR auto-detect vs forced `is_ocr`, the
 * never-fail link-extraction guard, the textfix open-failure path, and option
 * forwarding. The mupdf-backed end-to-end behaviour is in `golden-pdf.test.ts`.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { MineruContentList } from "../src/documents/mineru.js";
import type { PdfLinks } from "../src/documents/pdf-links.js";
import { ingestPdf } from "../src/pipelines/pdf/pipeline.js";
import type { PdfPipelinePorts } from "../src/pipelines/pdf/ports.js";

const CONTENT_LIST: MineruContentList = [
  { type: "text", text_level: 1, text: "A Fake Paper", page_idx: 0, bbox: [10, 10, 900, 60] },
  { type: "text", text: "Body paragraph.", page_idx: 2, bbox: [10, 100, 900, 200] },
];

const SEVEN_PAGE_LINKS: PdfLinks = {
  nPages: 7,
  pageSizes: [[612, 792]],
  links: [],
  hasText: true,
};

interface Calls {
  hasTextLayer: string[];
  extract: string[];
  openText: string[];
  mineru: Array<{ pdfPath: string; outDir: string; opts: Record<string, unknown> }>;
}

function fakePorts(
  overrides: {
    hasTextLayer?: (pdfPath: string) => boolean;
    extract?: (pdfPath: string) => PdfLinks;
    openText?: PdfPipelinePorts["openText"];
  } = {}
): { ports: PdfPipelinePorts; calls: Calls } {
  const calls: Calls = { hasTextLayer: [], extract: [], openText: [], mineru: [] };
  const ports: PdfPipelinePorts = {
    mineru: (pdfPath, outDir, opts) => {
      calls.mineru.push({ pdfPath, outDir, opts: opts as unknown as Record<string, unknown> });
      return Promise.resolve({ contentList: CONTENT_LIST });
    },
    links: {
      hasTextLayer: (p) => {
        calls.hasTextLayer.push(p);
        return overrides.hasTextLayer?.(p) ?? true;
      },
      extract: (p) => {
        calls.extract.push(p);
        if (overrides.extract) return overrides.extract(p);
        return SEVEN_PAGE_LINKS;
      },
    },
    openText: (p) => {
      calls.openText.push(p);
      if (overrides.openText) return overrides.openText(p);
      throw new Error("no fake provider by default");
    },
  };
  return { ports, calls };
}

function tmpPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), "pdf-pipeline-"));
  const pdf = join(dir, "fake.pdf");
  writeFileSync(pdf, "%PDF-fake");
  return pdf;
}

describe("ingestPdf composition", () => {
  test("auto-detects is_ocr=false when the PDF has a text layer", async () => {
    const { ports, calls } = fakePorts({ hasTextLayer: () => true });
    const doc = await ingestPdf(tmpPdf(), ports, { writeJson: false });
    expect(calls.hasTextLayer).toHaveLength(1);
    expect(calls.mineru[0]?.opts.config).toMatchObject({ isOcr: false });
    expect(doc.meta?.mineru?.is_ocr).toBe(false);
  });

  test("auto-detects is_ocr=true when the PDF has no text layer", async () => {
    const { ports } = fakePorts({ hasTextLayer: () => false });
    const doc = await ingestPdf(tmpPdf(), ports, { writeJson: false });
    expect(doc.meta?.mineru?.is_ocr).toBe(true);
  });

  test("forced is_ocr=true skips the text-layer probe (ads_scan_doc path)", async () => {
    const { ports, calls } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, {
      writeJson: false,
      config: { mineru: { isOcr: true } },
    });
    expect(calls.hasTextLayer).toHaveLength(0);
    expect(calls.mineru[0]?.opts.config).toMatchObject({ isOcr: true });
    expect(doc.meta?.mineru?.is_ocr).toBe(true);
  });

  test("forced is_ocr=false skips the text-layer probe", async () => {
    const { ports, calls } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, {
      writeJson: false,
      config: { mineru: { isOcr: false } },
    });
    expect(calls.hasTextLayer).toHaveLength(0);
    expect(doc.meta?.mineru?.is_ocr).toBe(false);
  });

  test("a failed link extraction never fails the run; n_pages falls back to the content list", async () => {
    const { ports } = fakePorts({
      extract: () => {
        throw new Error("mupdf exploded");
      },
    });
    const doc = await ingestPdf(tmpPdf(), ports, { writeJson: false });
    // _max_page(content_list): max page_idx (2) + 1
    expect(doc.source?.n_pages).toBe(3);
    expect(doc.structure?.length).toBeGreaterThan(0);
  });

  test("extracted links supply source.n_pages", async () => {
    const { ports } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, { writeJson: false });
    expect(doc.source?.n_pages).toBe(7);
  });

  test("usePdfLinks=false never opens the link harvest", async () => {
    const { ports, calls } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, {
      writeJson: false,
      config: { usePdfLinks: false },
    });
    expect(calls.extract).toHaveLength(0);
    expect(doc.source?.n_pages).toBe(3);
  });

  test("a failed textfix provider open records zeroed stats", async () => {
    const { ports } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, { writeJson: false });
    expect(doc.meta?.textfix).toEqual({ gaps_before: 0, gaps_fixed: 0, holders_changed: 0 });
  });

  test("useTextfix=false never opens the PDF text layer and records no stats", async () => {
    const { ports, calls } = fakePorts();
    const doc = await ingestPdf(tmpPdf(), ports, {
      writeJson: false,
      config: { useTextfix: false },
    });
    expect(calls.openText).toHaveLength(0);
    expect(doc.meta?.textfix).toBeUndefined();
  });

  test("forwards poll/cache options to the MinerU port", async () => {
    const { ports, calls } = fakePorts();
    await ingestPdf(tmpPdf(), ports, {
      writeJson: false,
      useMineruCache: false,
      config: { pollInterval: 1.5, pollTimeout: 42 },
    });
    expect(calls.mineru[0]?.opts).toMatchObject({
      pollInterval: 1.5,
      pollTimeout: 42,
      useCache: false,
    });
  });

  test("onProgress receives the stage transitions and reaches the MinerU port", async () => {
    const { ports, calls } = fakePorts();
    const seen: string[] = [];
    const onProgress = (m: string): void => {
      seen.push(m);
    };
    const outDir = mkdtempSync(join(tmpdir(), "pdf-pipeline-out-"));
    await ingestPdf(tmpPdf(), ports, { outDir, onProgress });
    expect(seen).toEqual([
      "MinerU extraction",
      "Extracting PDF links",
      "Building document",
      "Writing document JSON",
    ]);
    expect(calls.mineru[0]?.opts.onProgress).toBe(onProgress);
  });

  test("doc id / source come from the PDF filename", async () => {
    const { ports } = fakePorts();
    const pdf = tmpPdf();
    const doc = await ingestPdf(pdf, ports, { writeJson: false });
    expect(doc.doc_id).toBe("fake");
    expect(doc.source?.filename).toBe("fake.pdf");
    expect(doc.source?.path).toBe(pdf);
  });

  test("writeJson writes <outDir>/<stem>.json and sets meta.output_path after serialization", async () => {
    const { ports } = fakePorts();
    const outDir = mkdtempSync(join(tmpdir(), "pdf-pipeline-out-"));
    const doc = await ingestPdf(tmpPdf(), ports, { outDir });
    const written = JSON.parse(readFileSync(join(outDir, "fake.json"), "utf-8")) as {
      doc_id?: string;
      meta?: Record<string, unknown>;
    };
    expect(written.doc_id).toBe("fake");
    // output_path is set on the returned doc only, never serialized (Python parity)
    expect(written.meta?.output_path).toBeUndefined();
    expect(doc.meta?.output_path).toBe(join(outDir, "fake.json"));
  });

  test("writeJson=false leaves the output directory empty", async () => {
    const { ports } = fakePorts();
    const outDir = mkdtempSync(join(tmpdir(), "pdf-pipeline-out-"));
    await ingestPdf(tmpPdf(), ports, { outDir, writeJson: false });
    expect(readdirSync(outDir)).toHaveLength(0);
  });

  test("a missing PDF rejects", async () => {
    const { ports } = fakePorts();
    await expect(ingestPdf("/nonexistent/nope.pdf", ports)).rejects.toThrow("PDF not found");
  });
});
