/**
 * Minimal ZIP *writer* (Stage 10 writer export) — the mirror of the
 * dependency-free `unzip.ts` extractor. Entries are deflate-compressed
 * (method 8) via zlib; CRC32 uses Node ≥20.15's `zlib.crc32` with a small
 * table fallback. No npm dependency, no third-party format edge cases:
 * we write exactly what we control (manuscript.tex / references.bib /
 * assets) and nothing streamed from untrusted sources.
 */

import { Buffer } from "node:buffer";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";

export interface ZipEntryInput {
  /** Archive member name; forward slashes, no leading `/` or drive letters. */
  name: string;
  data: Uint8Array | string;
}

// ---- CRC32 ----------------------------------------------------------------- //

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  return table;
}
function crc32(buf: Uint8Array): number {
  if (typeof zlibCrc32 === "function") return Number(zlibCrc32(buf));
  const t = crcTable();
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ (t[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- writer ---------------------------------------------------------------- //

function dosDateTime(d: Date): { date: number; time: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a zip archive (deflate, UTF-8 names) and return it as a Buffer. */
export function zipEntries(entries: ZipEntryInput[], when: Date = new Date()): Buffer {
  const { date, time } = dosDateTime(when);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(typeof entry.data === "string" ? entry.data : entry.data);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, name, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    // extra/comment lengths, disk numbers, internal attrs: all 0
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, name);

    offset += 30 + name.length + compressed.length;
  }

  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}
