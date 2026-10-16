// The app icon's file formats (desktop-app tickets 25 and 30), plain Node: a minimal PNG reader, the ICNS container,
// and the classic ICNS 16/32 px entries.
//
// Classic entries (the user's decision of 2026-10-16 in ticket 30): macOS's own decoder (iconutil, and Finder/the Dock
// as far as the runner shows) read the PNG-holding `icp4`/`icp5` entries as noise, so 16 and 32 px are stored the
// classic way: `is32` (16) / `il32` (32) hold the colour, `s8mk` / `l8mk` the 8-bit alpha. The colour is three planes
// (all red, then all green, then all blue; not premultiplied), each run-length encoded on its own, with no prefix (the
// 4-byte zero prefix belongs to `it32` only). A packet starts with a byte c: c < 0x80 copies the next c + 1 bytes;
// c >= 0x80 repeats the next byte c - 0x80 + 3 times. The masks are one alpha byte per pixel, not compressed.
import { inflateSync } from 'node:zlib';

// ---- PNG (8-bit, RGB or RGBA, not interlaced: what resvg and iconutil write) -> RGBA ----
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 6 && data[9] !== 2)) {
        throw new Error(`expected an 8-bit RGB(A), non-interlaced PNG (depth ${data[8]}, colour ${data[9]}, interlace ${data[12]})`);
      }
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0, up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      rows[y * stride + x] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, px: rows };
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rows.copy(px, i * 4, i * 3, i * 3 + 3);
    px[i * 4 + 3] = 255;
  }
  return { width, height, px };
}

// ---- ICNS container ----
export function icns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

export function readIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('not an ICNS file');
  const entries = [];
  for (let pos = 8; pos < buf.length;) {
    const type = buf.toString('latin1', pos, pos + 4), len = buf.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > buf.length) throw new Error(`bad ICNS entry ${type} at ${pos}`);
    entries.push({ type, data: buf.subarray(pos + 8, pos + len) });
    pos += len;
  }
  return entries;
}

// ---- the classic entries' run-length encoding (one plane) ----
export function packBits(plane) {
  const out = [];
  let i = 0;
  const runAt = j => j + 2 < plane.length && plane[j] === plane[j + 1] && plane[j] === plane[j + 2];
  while (i < plane.length) {
    if (runAt(i)) {
      let n = 3;
      while (n < 130 && i + n < plane.length && plane[i + n] === plane[i]) n++;
      out.push(0x80 + n - 3, plane[i]);
      i += n;
    } else {
      const start = i;
      while (i < plane.length && i - start < 128 && !runAt(i)) i++;
      out.push(i - start - 1, ...plane.subarray(start, i));
    }
  }
  return Buffer.from(out);
}

/** Decodes `count` bytes of one plane from `data` at `pos`; returns the plane and the position after it. */
export function unpackBits(data, pos, count) {
  const plane = Buffer.alloc(count);
  let n = 0;
  while (n < count) {
    if (pos >= data.length) throw new Error('run-length data ends early');
    const c = data[pos++];
    if (c < 0x80) {
      const len = c + 1;
      if (n + len > count || pos + len > data.length) throw new Error('run-length literal overruns');
      data.copy(plane, n, pos, pos + len);
      pos += len;
      n += len;
    } else {
      const len = c - 0x80 + 3;
      if (n + len > count || pos >= data.length) throw new Error('run-length run overruns');
      plane.fill(data[pos++], n, n + len);
      n += len;
    }
  }
  return { plane, pos };
}

/** RGBA (straight alpha) -> the classic colour entry (three run-length planes) and its 8-bit mask. */
export function classicEntries({ width, height, px }) {
  const count = width * height;
  const planes = [0, 1, 2].map(c => {
    const plane = Buffer.alloc(count);
    for (let i = 0; i < count; i++) plane[i] = px[i * 4 + c];
    return packBits(plane);
  });
  const color = Buffer.concat(planes);
  // A colour entry exactly w*h*3 bytes long could be read as uncompressed by some readers: never write one.
  if (color.length === count * 3) throw new Error(`the ${width} px colour entry is exactly ${count * 3} bytes`);
  const mask = Buffer.alloc(count);
  for (let i = 0; i < count; i++) mask[i] = px[i * 4 + 3];
  return { color, mask };
}

/** The classic colour entry and mask -> RGBA. */
export function decodeClassic(color, mask, width, height) {
  const count = width * height;
  if (mask.length !== count) throw new Error(`mask is ${mask.length} bytes, expected ${count}`);
  const px = Buffer.alloc(count * 4);
  let pos = 0;
  for (let c = 0; c < 3; c++) {
    const r = unpackBits(color, pos, count);
    pos = r.pos;
    for (let i = 0; i < count; i++) px[i * 4 + c] = r.plane[i];
  }
  if (pos !== color.length) throw new Error(`${color.length - pos} bytes left after the colour planes`);
  for (let i = 0; i < count; i++) px[i * 4 + 3] = mask[i];
  return { width, height, px };
}

export const CLASSIC = { 16: ['is32', 's8mk'], 32: ['il32', 'l8mk'] };

/**
 * Compares two RGBA images where either has alpha > 0: alpha and the premultiplied colour (c * a / 255) may differ
 * by at most `tolerance`. Returns the worst difference, the number of pixels over the tolerance and the first one.
 */
export function compareRgba(a, b, tolerance = 1) {
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}`, worst: Infinity, bad: a.width * a.height };
  }
  let worst = 0, bad = 0, compared = 0, first = null;
  for (let i = 0; i < a.width * a.height; i++) {
    const aa = a.px[i * 4 + 3], ba = b.px[i * 4 + 3];
    if (aa === 0 && ba === 0) continue;
    compared++;
    let d = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) {
      d = Math.max(d, Math.abs(Math.round((a.px[i * 4 + c] * aa) / 255) - Math.round((b.px[i * 4 + c] * ba) / 255)));
    }
    worst = Math.max(worst, d);
    if (d > tolerance) {
      bad++;
      if (!first) first = { x: i % a.width, y: Math.floor(i / a.width), a: [...a.px.subarray(i * 4, i * 4 + 4)], b: [...b.px.subarray(i * 4, i * 4 + 4)] };
    }
  }
  return { ok: bad === 0 && compared > 0, worst, bad, compared, first };
}
