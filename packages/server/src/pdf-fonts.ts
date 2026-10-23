/**
 * The PDF engine's fallback fonts on the server (desktop-app ticket 28): where the `@embedpdf/fonts-*` packages are,
 * the engine option that reads them from disk, and the route the page's PDFium worker fetches them from. The table of
 * packages, files and charsets is contracts' `PDF_FALLBACK_FONT_PACKAGES`; only names in it are ever read or served.
 *
 * The packages are dependencies of `@embedpdf/engines` (not of this package), so they are found from the engine's own
 * location: that holds in the workspace (pnpm), in an npm install, and in the desktop package's dependency folder.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_FALLBACK_FONT_PACKAGES,
  PDF_FONT_ROUTE,
  type PdfFallbackFontFile,
  type PdfFallbackFontPackage,
  pdfFallbackFont,
  pdfFontFallbackConfig,
} from "@argelanderspace/contracts";
import type { PdfiumWorkerFonts } from "./pdfium-worker.js";
import type { ProtectedRoutes } from "./protected-app.js";

let fromEngines: NodeJS.Require | undefined;

/** The directory of `@embedpdf/fonts-<name>` as the engine resolves it (the package's entry is `dist/index.*`). */
export function fallbackFontPackageDir(name: PdfFallbackFontPackage["name"]): string {
  fromEngines ??= createRequire(fileURLToPath(import.meta.resolve("@embedpdf/engines/pdfium")));
  return join(dirname(fromEngines.resolve(`@embedpdf/fonts-${name}`)), "..");
}

const fontFile = (pkg: PdfFallbackFontPackage, font: PdfFallbackFontFile) =>
  join(fallbackFontPackageDir(pkg.name), "fonts", font.file);

/**
 * The server engine's `fontFallback` as plain data for the PDFium worker thread (shelf-followups 08): each font is named
 * by a key `<name>/<version>/<file>` of the table, and `files` maps exactly those keys to the file on disk. The worker's
 * loader reads only a key listed here (anything else, or a file that is not on disk, loads nothing and the text stays
 * blank as before).
 */
export function serverFontFallback(): PdfiumWorkerFonts {
  const key = (pkg: PdfFallbackFontPackage, font: PdfFallbackFontFile) =>
    `${pkg.name}/${pkg.version}/${font.file}`;
  const files: Record<string, string> = {};
  for (const pkg of PDF_FALLBACK_FONT_PACKAGES)
    for (const font of pkg.files) {
      try {
        files[key(pkg, font)] = fontFile(pkg, font);
      } catch {
        // the package cannot be found: its fonts load nothing
      }
    }
  return { ...pdfFontFallbackConfig(key), files };
}

/**
 * `GET /api/pdf-fonts/<name>/<version>/<file>`: one font of the table for the page's PDFium worker (same origin, so
 * the page never fetches fonts from the network). The path carries the package version, so the answer is immutable.
 */
export function mountPdfFontRoutes(app: ProtectedRoutes): void {
  app.get(`${PDF_FONT_ROUTE}/:name/:version/:file`, async (c) => {
    const found = pdfFallbackFont(c.req.param("name"), c.req.param("version"), c.req.param("file"));
    if (!found) return c.json({ detail: "Not Found" }, 404);
    const bytes = await readFile(fontFile(found.pkg, found.font)).catch(() => null);
    if (!bytes) return c.json({ detail: "font not available" }, 404);
    return c.body(bytes, 200, {
      "Content-Type": "font/otf",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  });
}
