import { pdfFallbackFontPath, pdfFontFallbackConfig } from "@argelanderspace/contracts";

/**
 * The page's PDFium `fontFallback` (desktop-app ticket 28): the CJK fonts a PDF does not embed, fetched by the worker
 * from this page's own server under `PDF_FONT_ROUTE` — never from a CDN. It must be an object: in @embedpdf/engines
 * 2.15.1 the worker falls back to the jsDelivr CDN when the option is undefined (null turns the fallback off). Absolute
 * URLs, resolved against `href` (the page's location): the worker runs from a blob: URL that relative paths cannot
 * resolve against. No `defaultFont` and no `baseUrl`, so nothing outside the table is ever requested.
 */
export function pageFontFallback(href: string) {
  return pdfFontFallbackConfig((pkg, font) => new URL(pdfFallbackFontPath(pkg, font), href).href);
}
