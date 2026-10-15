import { render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PDF_FALLBACK_FONT_PACKAGES, PDF_FONT_ROUTE, type DocDescription } from "@argelanderspace/contracts";
import { pageFontFallback } from "../src/doc/pdf-font-fallback";
import { PdfReader } from "../src/doc/PdfReader";
import { WorkspaceProvider } from "../src/argelander/workspace";

// The page's PDFium worker must never fetch fonts from a CDN (desktop-app ticket 28). In @embedpdf/engines 2.15.1 the
// worker does `fontFallback === null ? undefined : fontFallback ?? cdnFontConfig`: an option left undefined means the
// jsDelivr CDN, null means no fallback. These checks hold the page's option to same-origin URLs under the font route,
// both as built (pageFontFallback) and as the Reader actually hands it to the engine hook.

const engineOptions = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@embedpdf/engines/react", () => ({
  usePdfiumEngine: (options: Record<string, unknown>) => {
    engineOptions.push(options);
    return { engine: null, isLoading: true, error: null };
  },
}));
vi.mock("../src/api/pdf", () => ({
  fetchPdfDoc: async () => ({
    ok: true,
    bytes: new ArrayBuffer(8),
    snapshot: { metadata: { sha256: "a".repeat(64), pages: [] }, annotations: { annotations: [] }, reading_position: null },
  }),
}));

function expectSameOriginFontConfig(config: unknown, href: string) {
  expect(config).not.toBeNull();
  expect(config).not.toBeUndefined();
  expect(config).not.toHaveProperty("defaultFont");
  expect(config).not.toHaveProperty("baseUrl");
  expect(config).not.toHaveProperty("fontLoader");
  const origin = new URL(href).origin;
  const fonts = (config as { fonts: Record<string, { url: string }[]> }).fonts;
  expect(Object.keys(fonts).map(Number).sort()).toEqual(PDF_FALLBACK_FONT_PACKAGES.map((pkg) => pkg.charset).sort());
  const urls = Object.values(fonts).flatMap((variants) => variants.map((variant) => variant.url));
  expect(urls.length).toBe(PDF_FALLBACK_FONT_PACKAGES.reduce((n, pkg) => n + pkg.files.length, 0));
  for (const url of urls) {
    const parsed = new URL(url);
    expect(url).toBe(parsed.href); // absolute: the worker runs from a blob: URL
    expect(parsed.origin).toBe(origin);
    expect(parsed.pathname.startsWith(`${PDF_FONT_ROUTE}/`)).toBe(true);
  }
}

describe("the page's PDF font fallback", () => {
  for (const href of ["http://127.0.0.1:18959/#/doc/abc", "http://localhost:4173/some/path?q=1"])
    test(`is a same-origin config under the font route (${href})`, () => {
      expectSameOriginFontConfig(pageFontFallback(href), href);
    });

  test("is what the Reader hands the PDFium engine hook", async () => {
    const description = { format: "pdf", sha256: "a".repeat(64), page_count: 1, display_name: "x.pdf", work_title: "X" } as Extract<DocDescription, { format: "pdf" }>;
    const workspace = { pendingAnchor: null, clearPendingAnchor: () => {} } as unknown as Parameters<typeof WorkspaceProvider>[0]["value"];
    render(<WorkspaceProvider value={workspace}><PdfReader docId="d1" description={description} /></WorkspaceProvider>);
    await waitFor(() => expect(engineOptions.length).toBeGreaterThan(0));
    const options = engineOptions[engineOptions.length - 1]!;
    expect(options).toHaveProperty("fontFallback");
    expectSameOriginFontConfig(options.fontFallback, window.location.href);
  });
});
