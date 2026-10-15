/**
 * The PDF engine's fallback fonts (desktop-app ticket 28): what PDFium is given when a PDF's CJK text uses a font the
 * file does not embed. Without them that text renders blank (its text layer is still there). One table for both
 * engines: the server's (Node, the fonts read from disk) and the page's (the PDFium worker, the fonts fetched from
 * the local server's `PDF_FONT_ROUTE` — never from a CDN, so the page works offline).
 *
 * Only the four CJK packages: a non-embedded CJK font is the case PDFium asks the fallback for (an Adobe-GB1 /
 * CNS1 / Japan1 / Korea1 CID font maps to the GB2312 / CHINESEBIG5 / SHIFTJIS / HANGEUL charset). The engine's other
 * font packages (`fonts-latin`, `-arabic`, `-hebrew`, 11.8 MB together) are not offered: for non-embedded Cyrillic
 * or Greek text in a simple font PDFium did not ask the fallback at all (ticket 28 probe; Arabic and Hebrew were not
 * probed), so `fonts-latin` would not have changed those pages.
 *
 * The file lists are the packages' own manifests (`@embedpdf/fonts-*` 1.0.0, a dependency of `@embedpdf/engines`)
 * written out, so the page needs no import of them; a server test checks them against the installed packages, so an
 * upgrade that changes a package fails there instead of silently asking for files that are not served.
 */

/** Where the local server serves the fallback fonts: `<route>/<package>/<version>/<file>`. */
export const PDF_FONT_ROUTE = "/api/pdf-fonts";

export interface PdfFallbackFontFile {
  file: string;
  weight: number;
}

export interface PdfFallbackFontPackage {
  /** The package is `@embedpdf/fonts-<name>`. */
  name: "jp" | "kr" | "sc" | "tc";
  version: string;
  /** The PDFium charset (`FontCharset` of `@embedpdf/models`) this package answers. */
  charset: number;
  files: readonly PdfFallbackFontFile[];
}

const weights = (prefix: string, names: readonly [string, number][]): PdfFallbackFontFile[] =>
  names.map(([style, weight]) => ({ file: `${prefix}-${style}.otf`, weight }));
const SEVEN: readonly [string, number][] = [
  ["Thin", 100],
  ["Light", 300],
  ["DemiLight", 350],
  ["Regular", 400],
  ["Medium", 500],
  ["Bold", 700],
  ["Black", 900],
];

export const PDF_FALLBACK_FONT_PACKAGES: readonly PdfFallbackFontPackage[] = [
  {
    name: "jp",
    version: "1.0.0",
    charset: 128 /* SHIFTJIS */,
    files: weights("NotoSansJP", SEVEN),
  },
  { name: "kr", version: "1.0.0", charset: 129 /* HANGEUL */, files: weights("NotoSansKR", SEVEN) },
  {
    name: "sc",
    version: "1.0.0",
    charset: 134 /* GB2312 */,
    files: weights("NotoSansHans", [
      ["Light", 300],
      ["DemiLight", 350],
      ["Regular", 400],
      ["Medium", 500],
      ["Bold", 700],
    ]),
  },
  {
    name: "tc",
    version: "1.0.0",
    charset: 136 /* CHINESEBIG5 */,
    files: weights("NotoSansHant", SEVEN),
  },
];

/** The table's entry for one served path's parts, or null: only these exact names are ever read or served. */
export function pdfFallbackFont(
  name: string,
  version: string,
  file: string
): { pkg: PdfFallbackFontPackage; font: PdfFallbackFontFile } | null {
  const pkg = PDF_FALLBACK_FONT_PACKAGES.find((p) => p.name === name && p.version === version);
  const font = pkg?.files.find((f) => f.file === file);
  return pkg && font ? { pkg, font } : null;
}

/** The path, under the local server, of one font: `/api/pdf-fonts/<name>/<version>/<file>`. */
export function pdfFallbackFontPath(
  pkg: PdfFallbackFontPackage,
  font: PdfFallbackFontFile
): string {
  return `${PDF_FONT_ROUTE}/${pkg.name}/${pkg.version}/${font.file}`;
}

/**
 * The engine's `fontFallback` option (`FontFallbackConfig` of `@embedpdf/engines`): for each package's charset its
 * weights, each at the location `locate` gives (an absolute URL for the page's worker, a key for the server's loader).
 */
export function pdfFontFallbackConfig(
  locate: (pkg: PdfFallbackFontPackage, font: PdfFallbackFontFile) => string
): { fonts: Record<number, { url: string; weight: number; italic: boolean }[]> } {
  const fonts: Record<number, { url: string; weight: number; italic: boolean }[]> = {};
  for (const pkg of PDF_FALLBACK_FONT_PACKAGES)
    fonts[pkg.charset] = pkg.files.map((font) => ({
      url: locate(pkg, font),
      weight: font.weight,
      italic: false,
    }));
  return { fonts };
}
