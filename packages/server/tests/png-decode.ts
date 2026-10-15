import { inflateSync } from "node:zlib";

/** A reference PNG decoder for the encoder's output: inflate, undo each row's filter, expand to RGBA. */
export function decodePng(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25] as number;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString() === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const left = i >= bpp ? (pixels[y * stride + i - bpp] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const upLeft = y > 0 && i >= bpp ? (pixels[(y - 1) * stride + i - bpp] as number) : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft,
      ][filter] as number;
      pixels[y * stride + i] = (x + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = (k: number) => pixels[p * bpp + k] as number;
    rgba.set(
      bpp === 4
        ? [v(0), v(1), v(2), v(3)]
        : bpp === 3
          ? [v(0), v(1), v(2), 255]
          : [v(0), v(0), v(0), 255],
      p * 4
    );
  }
  return { width, height, rgba };
}
