import { pdfRectsWithinSlice } from "@argelanderspace/contracts";
import { rectsWithinSlice } from "@embedpdf/plugin-selection";
import { describe, expect, it } from "vitest";

describe("the Copilot's text target geometry is the Reader's selection geometry", () => {
  const glyph = (x: number, y: number, width: number, height: number, flags = 0) => ({ x, y, width, height, flags });
  // Three runs on two lines with a far gap, a font-size jump and generated line-break characters.
  const geometry = {
    runs: [
      { charStart: 0, rect: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 12, glyphs: [10, 20, 30, 40].map((x) => glyph(x, 100, 10, 12)) },
      { charStart: 4, rect: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 12, glyphs: [glyph(200, 100, 10, 12), glyph(210, 100, 10, 12)] },
      { charStart: 6, rect: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 1, glyphs: [glyph(0, 0, 0, 0, 2), glyph(0, 0, 0, 0, 2)] },
      { charStart: 8, rect: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 12, glyphs: [10, 20, 30].map((x) => glyph(x, 130, 10, 12)) },
      { charStart: 11, rect: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 24, glyphs: [glyph(40, 128, 20, 24), glyph(60, 128, 20, 24, 1)] },
    ],
  };
  it("matches EmbedPDF's rectsWithinSlice for every character range", () => {
    // The plugin's function takes the geometry's runs with `rect` per run; ours reads only what it needs.
    const last = 12;
    for (let from = 0; from <= last; from++)
      for (let to = from; to <= last; to++)
        expect(pdfRectsWithinSlice(geometry, from, to), `${from}..${to}`).toEqual(
          (rectsWithinSlice as (geo: unknown, from: number, to: number) => unknown)(geometry, from, to)
        );
  });
});
