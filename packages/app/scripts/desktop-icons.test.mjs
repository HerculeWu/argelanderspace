// The app icon's classic ICNS 16/32 px entries (desktop-app ticket 30; the user's decision of 2026-10-16): the
// run-length encoding of packages/desktop/scripts/icns-lib.mjs, round trips, and the committed icon.icns's layout.
// Whether macOS reads the entries the same way is checked on the release workflow's macOS runners
// (build-icons.mjs --check-iconset against iconutil's output).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLASSIC,
  classicEntries,
  compareRgba,
  decodeClassic,
  icns,
  packBits,
  readIcns,
  unpackBits,
} from "../../desktop/scripts/icns-lib.mjs";

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "icons");

// A small deterministic generator (no Math.random: the same bytes every run).
function bytes(n, seed, levels = 256) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) % levels;
  }
  return out;
}

test("run-length packets: runs of 3..130 as c >= 0x80, literals of 1..128 as c < 0x80", () => {
  assert.deepEqual([...packBits(Buffer.from([1, 1, 1, 1, 2, 3]))], [0x81, 1, 0x01, 2, 3]);
  assert.deepEqual([...packBits(Buffer.from([7, 7]))], [0x01, 7, 7]);
  assert.deepEqual([...packBits(Buffer.from([5]))], [0x00, 5]);
  assert.deepEqual([...packBits(Buffer.alloc(130, 9))], [0xff, 9]);
  assert.deepEqual([...packBits(Buffer.alloc(131, 9))], [0xff, 9, 0x00, 9]);
  assert.deepEqual([...packBits(Buffer.alloc(133, 9))], [0xff, 9, 0x80, 9]);
  const literal = Buffer.from(Array.from({ length: 129 }, (_, i) => i % 2));
  const packed = packBits(literal);
  assert.equal(packed[0], 127);
  assert.equal(packed[129], 0);
  assert.equal(packed.length, 1 + 128 + 1 + 1);
});

test("run-length round trip on runs, literals and mixtures of every length up to 1024", () => {
  for (let n = 1; n <= 1024; n += n < 300 ? 1 : 37) {
    for (const [seed, levels] of [
      [n, 256],
      [n * 7 + 1, 2],
      [n * 13 + 5, 3],
    ]) {
      const plane = bytes(n, seed, levels);
      const packed = packBits(plane);
      const { plane: back, pos } = unpackBits(packed, 0, n);
      assert.ok(back.equals(plane), `n=${n} levels=${levels}`);
      assert.equal(pos, packed.length);
    }
  }
  const zeros = Buffer.alloc(1024);
  assert.ok(unpackBits(packBits(zeros), 0, 1024).plane.equals(zeros));
});

test("unpacking refuses data that ends early or overruns the plane", () => {
  assert.throws(() => unpackBits(Buffer.from([0x05, 1, 2]), 0, 6), /ends early|overruns/);
  assert.throws(() => unpackBits(Buffer.from([0x85, 1]), 0, 4), /overruns/);
  assert.throws(() => unpackBits(Buffer.from([]), 0, 1), /ends early/);
});

test("classic entries: three planes R, G, B with no prefix, an uncompressed mask; round trip to the same RGBA", () => {
  for (const size of [16, 32]) {
    const count = size * size;
    // A plate-like picture: transparent corners, flat colour, some noise (as an antialiased edge).
    const px = Buffer.alloc(count * 4);
    const noise = bytes(count * 4, size);
    for (let i = 0; i < count; i++) {
      const x = i % size,
        y = Math.floor(i / size);
      const inside = x > 1 && y > 1 && x < size - 2 && y < size - 2;
      const edge = inside && (x === 2 || y === 2);
      px[i * 4] = inside ? (edge ? noise[i * 4] : 30) : 0;
      px[i * 4 + 1] = inside ? (edge ? noise[i * 4 + 1] : 60) : 0;
      px[i * 4 + 2] = inside ? 200 : 0;
      px[i * 4 + 3] = inside ? (edge ? noise[i * 4 + 3] : 255) : 0;
    }
    const image = { width: size, height: size, px };
    const { color, mask } = classicEntries(image);
    assert.equal(mask.length, count);
    assert.ok(color.length < count * 3, "compressed");
    // No it32-style prefix: the first byte is a packet header and the red plane alone decodes from offset 0.
    const red = unpackBits(color, 0, count).plane;
    for (let i = 0; i < count; i++) assert.equal(red[i], px[i * 4]);
    const back = decodeClassic(color, mask, size, size);
    assert.ok(back.px.equals(px));
    assert.equal(compareRgba(image, back).ok, true);
  }
});

test("pixel comparison: equal within 1 passes, a scrambled image fails, fully transparent pixels are ignored", () => {
  const size = 16;
  const a = { width: size, height: size, px: Buffer.alloc(size * size * 4) };
  for (let i = 0; i < size * size; i++) a.px.set([200, 100, 50, i % 3 === 0 ? 0 : 255], i * 4);
  const near = { width: size, height: size, px: Buffer.from(a.px) };
  for (let i = 0; i < size * size; i++) near.px[i * 4] += 1;
  assert.equal(compareRgba(a, near).ok, true);
  const hidden = { width: size, height: size, px: Buffer.from(a.px) };
  for (let i = 0; i < size * size; i += 3) hidden.px.set([1, 2, 3, 0], i * 4);
  assert.equal(compareRgba(a, hidden).ok, true);
  const noise = { width: size, height: size, px: bytes(size * size * 4, 99) };
  const r = compareRgba(a, noise);
  assert.equal(r.ok, false);
  assert.ok(r.bad > 0 && r.worst > 1);
  assert.equal(compareRgba(a, { width: 32, height: 32, px: Buffer.alloc(32 * 32 * 4) }).ok, false);
});

test("ICNS container round trip", () => {
  const entries = [
    { type: "is32", data: Buffer.from([1, 2, 3]) },
    { type: "s8mk", data: Buffer.alloc(0) },
  ];
  const back = readIcns(icns(entries));
  assert.deepEqual(
    back.map((e) => [e.type, [...e.data]]),
    entries.map((e) => [e.type, [...e.data]])
  );
  assert.throws(() => readIcns(Buffer.from("icnx\0\0\0\x08", "latin1")), /not an ICNS/);
});

test("the committed icon.icns holds 16 and 32 px as classic entries, no icp4/icp5, and they decode", () => {
  const entries = readIcns(readFileSync(join(iconsDir, "icon.icns")));
  const types = entries.map((e) => e.type);
  assert.deepEqual(types, [
    "is32",
    "s8mk",
    "il32",
    "l8mk",
    "ic11",
    "ic12",
    "ic07",
    "ic13",
    "ic08",
    "ic14",
    "ic09",
    "ic10",
  ]);
  for (const size of [16, 32]) {
    const [colorType, maskType] = CLASSIC[size];
    const color = entries.find((e) => e.type === colorType).data;
    const mask = entries.find((e) => e.type === maskType).data;
    const image = decodeClassic(color, mask, size, size);
    let opaque = 0;
    for (let i = 0; i < size * size; i++) if (image.px[i * 4 + 3] === 255) opaque++;
    assert.ok(opaque > (size * size) / 2, `${size} px: mostly opaque plate`);
    assert.equal(image.px[3], 0, `${size} px: transparent corner`);
  }
});
