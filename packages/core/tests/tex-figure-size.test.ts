import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { texFigureAssetSize } from "../src/pipelines/tex/fuse/figures.js";

const dir = mkdtempSync(join(tmpdir(), "tex-figure-size-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function png(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

describe("texFigureAssetSize (SVG)", () => {
  it("pdftocairo-style unitless width/height", () => {
    const p = put(
      "a.svg",
      `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="936" height="1296" viewBox="0 0 936 1296"><g/></svg>`
    );
    expect(texFigureAssetSize(p)).toEqual({ w: 936, h: 1296 });
  });

  it("converts pt units to CSS px", () => {
    const p = put("b.svg", `<svg width="504pt" height="360pt" viewBox="0 0 504 360"></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 672, h: 480 });
  });

  it("converts mm units to CSS px", () => {
    const p = put("c.svg", `<svg width="25.4mm" height="50.8mm"></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 96, h: 192 });
  });

  it("falls back to viewBox when width/height are absent", () => {
    const p = put("d.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 100, h: 50 });
  });

  it("falls back to viewBox when width/height are percentages", () => {
    const p = put("e.svg", `<svg width="100%" height="100%" viewBox="10 20 640 480"></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 640, h: 480 });
  });

  it("accepts single-quoted attributes", () => {
    const p = put("f.svg", `<svg width='200' height='100'></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 200, h: 100 });
  });

  it("does not mistake stroke-width for width", () => {
    const p = put("h.svg", `<svg stroke-width="2" viewBox="0 0 640 480"></svg>`);
    expect(texFigureAssetSize(p)).toEqual({ w: 640, h: 480 });
  });

  it("returns undefined without usable dimensions", () => {
    const p = put("g.svg", `<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    expect(texFigureAssetSize(p)).toBeUndefined();
  });
});

describe("texFigureAssetSize (PNG / other)", () => {
  it("reads the PNG IHDR dimensions", () => {
    const p = put("a.png", png(70, 40));
    expect(texFigureAssetSize(p)).toEqual({ w: 70, h: 40 });
  });

  it("rejects truncated/non-PNG bytes", () => {
    const p = put("b.png", Buffer.from("not a png at all, really"));
    expect(texFigureAssetSize(p)).toBeUndefined();
  });

  it("rejects a PNG signature whose first chunk is not IHDR", () => {
    const buf = png(70, 40);
    buf.write("XXXX", 12, "ascii");
    const p = put("c.png", buf);
    expect(texFigureAssetSize(p)).toBeUndefined();
  });

  it("returns undefined for unsupported passthrough formats", () => {
    const p = put("a.jpg", "whatever");
    expect(texFigureAssetSize(p)).toBeUndefined();
  });

  it("returns undefined for missing files (stub ports write nothing)", () => {
    expect(texFigureAssetSize(join(dir, "nope.svg"))).toBeUndefined();
  });
});
