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

function jpeg(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  let o = 0;
  buf.writeUInt16BE(0xffd8, o); // SOI
  o += 2;
  buf.writeUInt16BE(0xffe0, o); // APP0
  buf.writeUInt16BE(16, o + 2);
  buf.write("JFIF\0", o + 4, "ascii");
  o += 18;
  buf.writeUInt16BE(0xffc0, o); // SOF0
  buf.writeUInt16BE(11, o + 2); // length (incl. itself)
  buf.writeUInt8(8, o + 4); // precision
  buf.writeUInt16BE(h, o + 5);
  buf.writeUInt16BE(w, o + 7);
  buf.writeUInt8(1, o + 9); // one component
  return buf;
}

function gif(w: number, h: number, sig = "GIF89a"): Buffer {
  const buf = Buffer.alloc(10);
  buf.write(sig, 0, "ascii");
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

function webp(chunk: string, data: Buffer): Buffer {
  const buf = Buffer.alloc(20 + data.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(12 + data.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write(chunk, 12, "ascii");
  buf.writeUInt32LE(data.length, 16);
  data.copy(buf, 20);
  return buf;
}

function webpVp8x(w: number, h: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(w - 1, 4, 3);
  data.writeUIntLE(h - 1, 7, 3);
  return webp("VP8X", data);
}

function webpVp8(w: number, h: number): Buffer {
  const data = Buffer.alloc(10);
  // 3-byte frame tag, then the 9d 01 2a start code, then 14-bit w/h (LE)
  data.writeUInt16LE(0x019d, 3);
  data.writeUInt8(0x2a, 5);
  data.writeUInt16LE(w, 6);
  data.writeUInt16LE(h, 8);
  return webp("VP8 ", data);
}

function webpVp8l(w: number, h: number): Buffer {
  const data = Buffer.alloc(5);
  data.writeUInt8(0x2f, 0);
  data.writeUInt32LE((w - 1) | ((h - 1) << 14), 1);
  return webp("VP8L", data);
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

  it("returns undefined for missing files (stub ports write nothing)", () => {
    expect(texFigureAssetSize(join(dir, "nope.svg"))).toBeUndefined();
  });
});

describe("texFigureAssetSize (JPEG / GIF / WebP passthrough)", () => {
  it("reads JPEG dimensions from the SOF segment", () => {
    const p = put("a.jpg", jpeg(640, 480));
    expect(texFigureAssetSize(p)).toEqual({ w: 640, h: 480 });
  });

  it("skips non-SOF markers (DHT) while scanning", () => {
    const buf = jpeg(640, 480);
    buf.writeUInt16BE(0xffc4, 2); // rewrite APP0 as a DHT segment
    const p = put("b.jpg", buf);
    expect(texFigureAssetSize(p)).toEqual({ w: 640, h: 480 });
  });

  it("reads the SOF after a 0xFF fill byte (T.81 B.1.1.2)", () => {
    const base = jpeg(640, 480); // SOF0 segment starts at offset 20
    const buf = Buffer.concat([base.subarray(0, 20), Buffer.from([0xff]), base.subarray(20)]);
    const p = put("fill.jpg", buf);
    expect(texFigureAssetSize(p)).toEqual({ w: 640, h: 480 });
  });

  it("a fill byte before a large APPn cannot forge SOF dimensions", () => {
    // FF FF E1 C0 10 …: fill byte, then APP1 whose length's high byte (0xC0)
    // must not be mistaken for an SOF0 marker.
    const buf = Buffer.alloc(12);
    buf.writeUInt16BE(0xffd8, 0); // SOI
    buf.writeUInt8(0xff, 2); // marker prefix
    buf.writeUInt8(0xff, 3); // fill byte
    buf.writeUInt8(0xe1, 4); // APP1
    buf.writeUInt16BE(0xc010, 5); // declared length (far past EOF)
    buf.writeUInt16BE(111, 8); // payload the buggy scan read as height
    buf.writeUInt16BE(222, 10); // …and as width
    const p = put("fill-appn.jpg", buf);
    expect(texFigureAssetSize(p)).toBeUndefined();
  });

  it("rejects garbage bytes and a stream hitting SOS without SOF", () => {
    expect(texFigureAssetSize(put("c.jpg", "whatever"))).toBeUndefined();
    const buf = Buffer.alloc(6);
    buf.writeUInt16BE(0xffd8, 0);
    buf.writeUInt16BE(0xffda, 2); // SOS before any SOF
    expect(texFigureAssetSize(put("d.jpg", buf))).toBeUndefined();
  });

  it("reads GIF87a/GIF89a logical screen dimensions", () => {
    expect(texFigureAssetSize(put("a.gif", gif(320, 200)))).toEqual({ w: 320, h: 200 });
    expect(texFigureAssetSize(put("b.gif", gif(1, 1, "GIF87a")))).toEqual({ w: 1, h: 1 });
  });

  it("rejects a bad GIF signature", () => {
    expect(texFigureAssetSize(put("c.gif", gif(320, 200, "GIF00a")))).toBeUndefined();
    expect(texFigureAssetSize(put("d.gif", Buffer.alloc(4)))).toBeUndefined();
  });

  it("reads WebP VP8X canvas dimensions (24-bit minus one)", () => {
    const p = put("a.webp", webpVp8x(1200, 800));
    expect(texFigureAssetSize(p)).toEqual({ w: 1200, h: 800 });
  });

  it("reads WebP VP8 (lossy) 14-bit frame dimensions", () => {
    const p = put("b.webp", webpVp8(500, 375));
    expect(texFigureAssetSize(p)).toEqual({ w: 500, h: 375 });
  });

  it("reads WebP VP8L (lossless) packed dimensions", () => {
    const p = put("c.webp", webpVp8l(1024, 768));
    expect(texFigureAssetSize(p)).toEqual({ w: 1024, h: 768 });
  });

  it("rejects malformed WebP headers", () => {
    const badRiff = webpVp8x(100, 100);
    badRiff.write("RAFF", 0, "ascii");
    expect(texFigureAssetSize(put("d.webp", badRiff))).toBeUndefined();
    const badStart = webpVp8(100, 100);
    badStart.writeUInt8(0x00, 24); // corrupt the 9d 01 2a start code
    expect(texFigureAssetSize(put("e.webp", badStart))).toBeUndefined();
    const unknownChunk = webp("ALPH", Buffer.alloc(6));
    expect(texFigureAssetSize(put("f.webp", unknownChunk))).toBeUndefined();
  });
});
