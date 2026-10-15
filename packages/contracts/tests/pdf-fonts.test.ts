import { describe, expect, test } from "vitest";
import {
  PDF_FALLBACK_FONT_PACKAGES,
  PDF_FONT_ROUTE,
  pdfFallbackFont,
  pdfFallbackFontPath,
  pdfFontFallbackConfig,
} from "../src/pdf-fonts.js";

describe("PDF fallback fonts (desktop-app ticket 28)", () => {
  test("only the four CJK packages, one charset each", () => {
    expect(PDF_FALLBACK_FONT_PACKAGES.map((p) => [p.name, p.charset])).toEqual([
      ["jp", 128],
      ["kr", 129],
      ["sc", 134],
      ["tc", 136],
    ]);
  });

  test("the config maps every charset to all its weights at the given location", () => {
    const config = pdfFontFallbackConfig(
      (pkg, font) => `http://127.0.0.1:1859${pdfFallbackFontPath(pkg, font)}`
    );
    expect(Object.keys(config.fonts).map(Number).sort()).toEqual([128, 129, 134, 136]);
    expect(config.fonts[134]).toContainEqual({
      url: "http://127.0.0.1:1859/api/pdf-fonts/sc/1.0.0/NotoSansHans-Regular.otf",
      weight: 400,
      italic: false,
    });
    expect(config.fonts[128]).toHaveLength(7);
    expect(config.fonts[134]).toHaveLength(5);
    for (const variants of Object.values(config.fonts))
      for (const v of variants)
        expect(v.url.startsWith(`http://127.0.0.1:1859${PDF_FONT_ROUTE}/`)).toBe(true);
  });

  test("lookup answers only the exact names of the table", () => {
    expect(pdfFallbackFont("sc", "1.0.0", "NotoSansHans-Bold.otf")?.font.weight).toBe(700);
    for (const [name, version, file] of [
      ["sc", "1.0.1", "NotoSansHans-Bold.otf"],
      ["latin", "1.0.0", "NotoSans-Regular.ttf"],
      ["sc", "1.0.0", "NotoSansHant-Bold.otf"],
      ["sc", "1.0.0", "../package.json"],
      ["sc", "1.0.0", "LICENSE"],
      ["__proto__", "1.0.0", "x"],
    ])
      expect(pdfFallbackFont(name as string, version as string, file as string)).toBeNull();
  });
});
