/**
 * The PDF engine's fallback fonts on the server (desktop-app ticket 28): where the `@embedpdf/fonts-*` packages are,
 * the engine option that reads them from disk, and the route the page's PDFium worker fetches them from. The table of
 * packages, files and charsets is contracts' `PDF_FALLBACK_FONT_PACKAGES`; only names in it are ever read or served.
 *
 * The packages are dependencies of `@embedpdf/engines` (not of this package), so they are found from the engine's own
 * location: that holds in the workspace (pnpm), in an npm install, and in the desktop package's dependency folder.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_FONT_ROUTE,
  type PdfFallbackFontFile,
  type PdfFallbackFontPackage,
  pdfFallbackFont,
  pdfFontFallbackConfig,
} from "@argelanderspace/contracts";
import type { Hono } from "hono";

let fromEngines: NodeJS.Require | undefined;

/** The directory of `@embedpdf/fonts-<name>` as the engine resolves it (the package's entry is `dist/index.*`). */
export function fallbackFontPackageDir(name: PdfFallbackFontPackage["name"]): string {
  fromEngines ??= createRequire(fileURLToPath(import.meta.resolve("@embedpdf/engines/pdfium")));
  return join(dirname(fromEngines.resolve(`@embedpdf/fonts-${name}`)), "..");
}

const fontFile = (pkg: PdfFallbackFontPackage, font: PdfFallbackFontFile) =>
  join(fallbackFontPackageDir(pkg.name), "fonts", font.file);

/**
 * The server engine's `fontFallback`: each font named by a key `<name>/<version>/<file>` that the loader maps back to
 * the table (anything else, or a file that is not on disk, loads nothing and the text stays blank as before).
 */
export function serverFontFallback() {
  return {
    ...pdfFontFallbackConfig((pkg, font) => `${pkg.name}/${pkg.version}/${font.file}`),
    fontLoader: (key: string): Uint8Array | null => {
      const [name = "", version = "", file = ""] = key.split("/");
      const found = pdfFallbackFont(name, version, file);
      if (!found) return null;
      try {
        return readFileSync(fontFile(found.pkg, found.font));
      } catch {
        return null;
      }
    },
  };
}

/**
 * `GET /api/pdf-fonts/<name>/<version>/<file>`: one font of the table for the page's PDFium worker (same origin, so
 * the page never fetches fonts from the network). The path carries the package version, so the answer is immutable.
 */
export function mountPdfFontRoutes(app: Hono): void {
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
