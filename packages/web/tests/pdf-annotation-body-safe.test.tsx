import { cleanup, render } from "@testing-library/react";
import type { PdfAnnotationsFile } from "@argelanderspace/contracts";
import { pdfRectsWithinSlice } from "@argelanderspace/contracts";
import { rectsWithinSlice } from "@embedpdf/plugin-selection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfAnnotationSession } from "../src/doc/PdfAnnotationSession";
import { PdfAnnotationsPanel } from "../src/doc/PdfAnnotationsPanel";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ onAnnotationChanged: () => () => undefined }));

const sha = "a".repeat(64);
const at = "2026-10-05T10:00:00.000Z";
afterEach(cleanup);

describe("a PDF annotation body is written by the user, a model or a pasted text: shown safely (copilot ticket 21)", () => {
  it("shows live HTML and images as text, keeps http links and math, and never runs a script or an event handler", async () => {
    await i18n.changeLanguage("en");
    const hostile = [
      "plain **bold** and $x^2$",
      '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>',
      "[ok](https://example.org/a) [bad](javascript:window.__pwned=3)",
    ].join("\n\n");
    const file: PdfAnnotationsFile = {
      version: 1,
      doc_id: "pdf-safe",
      content_sha256: sha,
      rev: 1,
      annotations: [{ id: "pann_1", kind: "document_comment", body: hostile, created_at: at, updated_at: at }],
    };
    const session = new PdfAnnotationSession("pdf-safe", sha, file);
    session.start();
    const { container } = render(<PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={() => undefined} />);
    const body = container.querySelector('[data-ui="pdf-annotation-body"]') as HTMLElement;
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    for (const element of body.querySelectorAll("*"))
      expect([...element.attributes].filter((attribute) => /^on/i.test(attribute.name))).toEqual([]);
    expect(body.textContent).toContain("<img");
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector(".katex")).toBeTruthy();
    const links = [...body.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.org/a"]);
    expect(body.innerHTML).not.toMatch(/href="javascript:/i);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    session.stop();
  });
});

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
