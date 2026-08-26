/**
 * Test-local implementations of the PDF pipeline ports
 * (`packages/core/src/pipelines/pdf/ports.ts`). Core cannot import infra
 * (dependency direction is infra -> core), so the golden/unit tests wire their
 * own adapters:
 *
 * - **links / text layer** — real mupdf (a devDependency, same pinned version as
 *   infra), with the exact call sequences of infra's `pdf/links.ts` and
 *   `pdf/text-provider.ts` adapters (`isExternal()` kind mapping, `#nameddest=`
 *   decode, no y-flip, quad-center clip filter). The adapters' own edge cases
 *   are covered by infra's mupdf-*.test.ts suites; here we need the stable
 *   mupdf surface so the golden gate exercises the real PDFs end to end. Keep
 *   the two in sync — any mupdf behaviour drift fails the golden gate.
 * - **mineru** — replays the archived extraction cache in
 *   `tests/fixtures/pdfminer/<doc_id>/mineru/` (only `*content_list.json` is
 *   archived; the pipeline consumes nothing else), with the frozen run's
 *   `batch_id` taken from the fixture's `source.json` manifest. No network.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import type { MineruArtifacts, MineruContentList } from "../../src/documents/mineru.js";
import {
  classifyDest,
  type FracRect,
  type LinkAnnot,
  type PdfLinks,
  parseUri,
} from "../../src/documents/pdf-links.js";
import type { PageRect, PdfTextProvider } from "../../src/documents/textfix.js";
import type { PdfPipelinePorts } from "../../src/pipelines/pdf/ports.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

// --------------------------------------------------------------------------- //
// mupdf primitives (mirror infra's pdf/text-provider.ts)
// --------------------------------------------------------------------------- //

function openMupdf(pdfPath: string): mupdf.Document {
  return mupdf.Document.openDocument(readFileSync(pdfPath), "pdf");
}

function pageTextOf(page: mupdf.Page): string {
  const st = page.toStructuredText();
  try {
    return st.asText();
  } finally {
    st.destroy();
  }
}

function pageSizeOf(page: mupdf.Page): { width: number; height: number } {
  const b = page.getBounds();
  return { width: b[2] - b[0], height: b[3] - b[1] };
}

/** `page.get_text("text", clip=rect)`: quad-center-in-rect filter + line newlines.
 *  Non-BMP workaround (keep in sync with infra): `walk`'s `onChar` truncates
 *  runes > U+FFFF to 16 bits (`String.fromCharCode` marshalling), so the true
 *  runes are zipped in from the full-fidelity `asJSON` line texts. */
function clippedTextOf(page: mupdf.Page, rect: PageRect): string {
  const st = page.toStructuredText();
  try {
    const trueLines: number[][] = [];
    const json = JSON.parse(st.asJSON(1)) as {
      blocks?: Array<{ type?: string; lines?: Array<{ text?: string }> }>;
    };
    for (const b of json.blocks ?? []) {
      if (b.type !== "text") continue;
      for (const l of b.lines ?? []) {
        trueLines.push([...(l.text ?? "")].map((ch) => ch.codePointAt(0) ?? 0));
      }
    }
    let li = 0;
    let ci = 0;
    let text = "";
    let lineHas = false;
    st.walk({
      onChar(c, _origin, _font, _size, quad) {
        let ch = c;
        const cp = trueLines[li]?.[ci];
        if (cp !== undefined && (cp & 0xffff) === c.charCodeAt(0)) {
          ch = String.fromCodePoint(cp);
        }
        ci += 1;
        const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        if (cx >= rect.x0 && cx <= rect.x1 && cy >= rect.y0 && cy <= rect.y1) {
          text += ch;
          lineHas = true;
        }
      },
      endLine() {
        if (lineHas) {
          text += "\n";
          lineHas = false;
        }
        li += 1;
        ci = 0;
      },
    });
    return text;
  } finally {
    st.destroy();
  }
}

// --------------------------------------------------------------------------- //
// PdfTextProvider port (mirror infra's MupdfTextProvider)
// --------------------------------------------------------------------------- //

class TestMupdfTextProvider implements PdfTextProvider {
  private readonly doc: mupdf.Document;
  private closed = false;

  constructor(pdfPath: string) {
    this.doc = openMupdf(pdfPath);
  }

  get pageCount(): number {
    return this.doc.countPages();
  }

  private page(pageIdx: number): mupdf.Page {
    if (this.closed) throw new Error("TestMupdfTextProvider is closed");
    return this.doc.loadPage(pageIdx);
  }

  pageSize(pageIdx: number): { width: number; height: number } {
    const page = this.page(pageIdx);
    try {
      return pageSizeOf(page);
    } finally {
      page.destroy();
    }
  }

  pageText(pageIdx: number): string {
    const page = this.page(pageIdx);
    try {
      return pageTextOf(page);
    } finally {
      page.destroy();
    }
  }

  clippedText(pageIdx: number, rect: PageRect): string {
    const page = this.page(pageIdx);
    try {
      return clippedTextOf(page, rect);
    } finally {
      page.destroy();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.doc.destroy();
    }
  }
}

export function openTestPdfText(pdfPath: string): PdfTextProvider {
  return new TestMupdfTextProvider(pdfPath);
}

// --------------------------------------------------------------------------- //
// links port (mirror infra's pdf/links.ts)
// --------------------------------------------------------------------------- //

export function hasTestPdfTextLayer(pdfPath: string): boolean {
  const doc = openMupdf(pdfPath);
  try {
    let chars = 0;
    const n = Math.min(doc.countPages(), 6);
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        chars += Array.from(pageTextOf(page).trim()).length;
      } finally {
        page.destroy();
      }
    }
    return chars / Math.max(1, n) > 80;
  } finally {
    doc.destroy();
  }
}

/** Strip `#nameddest=` / bare-`#` and percent-decode a destination name. */
function destNameOf(uri: string): string | undefined {
  let name: string;
  if (uri.startsWith("#nameddest=")) name = uri.slice("#nameddest=".length);
  else if (uri.startsWith("#")) name = uri.slice(1);
  else return undefined;
  if (/^page=\d/.test(name)) return undefined; // "#page=N" — explicit goto, no name
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function targetPointOf(
  doc: mupdf.Document,
  link: mupdf.Link
): {
  targetPage: number | undefined;
  targetPoint: readonly [number, number] | undefined;
} {
  let dest: ReturnType<mupdf.Document["resolveLinkDestination"]>;
  try {
    dest = doc.resolveLinkDestination(link);
  } catch {
    return { targetPage: undefined, targetPoint: undefined };
  }
  const page = dest.page;
  if (typeof page !== "number" || page < 0 || page >= doc.countPages()) {
    return { targetPage: undefined, targetPoint: undefined };
  }
  const x = dest.x;
  const y = dest.y;
  if (typeof x !== "number" || typeof y !== "number") {
    return { targetPage: page, targetPoint: undefined };
  }
  const target = doc.loadPage(page);
  try {
    const { width: tw, height: th } = pageSizeOf(target);
    if (tw <= 0 || th <= 0) return { targetPage: page, targetPoint: undefined };
    return { targetPage: page, targetPoint: [x / tw, y / th] };
  } finally {
    target.destroy();
  }
}

export function extractTestPdfLinks(pdfPath: string): PdfLinks {
  const doc = openMupdf(pdfPath);
  try {
    const nPages = doc.countPages();
    const pageSizes: Array<readonly [number, number]> = [];
    const links: LinkAnnot[] = [];
    let textChars = 0;
    let sampled = 0;
    for (let pno = 0; pno < nPages; pno++) {
      const page = doc.loadPage(pno);
      try {
        const { width: w, height: h } = pageSizeOf(page);
        pageSizes.push([w, h]);
        if (w <= 0 || h <= 0) continue;
        if (sampled < 6) {
          textChars += Array.from(pageTextOf(page).trim()).length;
          sampled += 1;
        }
        for (const ln of page.getLinks()) {
          const b = ln.getBounds();
          const rect: FracRect = [b[0] / w, b[1] / h, b[2] / w, b[3] / h];
          const uri = ln.getURI();
          if (ln.isExternal() && !uri.startsWith("file:")) {
            const { doi, arxivId } = parseUri(uri);
            links.push({ pageIdx: pno, rect, kind: "uri", uri, doi, arxivId });
          } else if (!ln.isExternal() && uri.startsWith("#")) {
            const destName = destNameOf(uri);
            const { targetPage, targetPoint } = targetPointOf(doc, ln);
            links.push({
              pageIdx: pno,
              rect,
              kind: "goto",
              targetPage,
              targetPoint,
              destName,
              destKind: destName !== undefined ? classifyDest(destName) : "goto",
            });
          } else {
            links.push({ pageIdx: pno, rect, kind: "other" });
          }
        }
      } finally {
        page.destroy();
      }
    }
    return { nPages, pageSizes, links, hasText: textChars / Math.max(1, sampled) > 80 };
  } finally {
    doc.destroy();
  }
}

// --------------------------------------------------------------------------- //
// fixtures + mineru port (archived extraction cache, offline)
// --------------------------------------------------------------------------- //

export interface PdfFixtureManifest {
  doc_id: string;
  /** PDF filename within the fixture dir. */
  pdf: string;
  /** Golden filename under <repo>/tests/golden/. */
  golden: string;
  /** Forced `mineru.is_ocr` for the run that froze the golden (null = auto). */
  is_ocr: boolean | null;
  /** MinerU batch id of the run that froze the golden (null = cache-loaded, none). */
  batch_id: string | null;
  /** acquire `_stamp_source` values applied to the written JSON, if any. */
  stamp: { doi: string | null; arxiv_id: string | null; acquired_via: string } | null;
  provenance: string;
}

export interface PdfFixture {
  dir: string;
  pdfPath: string;
  manifest: PdfFixtureManifest;
}

export function loadPdfFixture(docId: string): PdfFixture {
  const dir = join(FIXTURES, "pdfminer", docId);
  const manifest = JSON.parse(
    readFileSync(join(dir, "source.json"), "utf-8")
  ) as PdfFixtureManifest;
  return { dir, pdfPath: join(dir, manifest.pdf), manifest };
}

/**
 * Replay the archived MinerU cache for `fixture` (`MineruClient.loadCached` +
 * the frozen run's batch id). Only `content_list` and `batchId` are consumed by
 * the pipeline, so only those are restored.
 */
function fixtureMineru(fixture: PdfFixture): PdfPipelinePorts["mineru"] {
  return () => {
    const cacheDir = join(fixture.dir, "mineru");
    const clFile = readdirSync(cacheDir)
      .filter((f) => f.endsWith("content_list.json"))
      .sort()[0];
    if (clFile === undefined) {
      throw new Error(`no *content_list.json under ${cacheDir}`);
    }
    const artifacts: MineruArtifacts = {
      contentList: JSON.parse(readFileSync(join(cacheDir, clFile), "utf-8")) as MineruContentList,
      batchId: fixture.manifest.batch_id ?? undefined,
    };
    return Promise.resolve(artifacts);
  };
}

/** Real-mupdf links/text ports + the fixture-backed MinerU port. */
export function testPdfPorts(fixture: PdfFixture): PdfPipelinePorts {
  return {
    mineru: fixtureMineru(fixture),
    links: { hasTextLayer: hasTestPdfTextLayer, extract: extractTestPdfLinks },
    openText: openTestPdfText,
  };
}
