// Generates the desktop app's icon set (desktop-app ticket 25) in packages/desktop/icons/ from the two source SVGs in
// icons/source/ (original artwork, see the comments in them):
//   app-icon.svg        full version, used from 48 px up
//   app-icon-small.svg  simplified version, used at 16, 24 and 32 px
// Outputs: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256 and icon.png (512) for Linux (the deb puts every PNG listed in
// tauri.conf.json under /usr/share/icons/hicolor; the first PNG listed is also the window icon). No Tauri-style
// 128x128@2x.png: the deb bundler would install a 256 px file as hicolor's 256x256@2 (a 512 px slot).
// Also icon.ico for Windows (16, 24, 32, 48, 64 as 32-bit BMP, 256 as PNG); icon.icns for macOS (16 to 1024, PNG entries).
// The macOS variants put the plate on Apple's grid instead: the 448 plate of the 512 canvas becomes 824 on a 1024
// canvas, with a soft shadow in the margin; the drawing inside is scaled as a whole, not redrawn.
//
// Rasterising is done by the Tauri CLI's `icon --png` (resvg), the same tool the desktop package already needs
// (docs/engineering.md, desktop package); everything else is plain Node. The repository does not depend on it.
// Usage (from anywhere): node packages/desktop/scripts/build-icons.mjs --tauri-cli <path to cargo-tauri>
//   --tauri-cli defaults to `cargo-tauri` on PATH. Re-running with the same CLI gives the same bytes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const sourceDir = join(iconsDir, 'source');

const args = process.argv.slice(2);
let tauriCli = 'cargo-tauri';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tauri-cli' && args[i + 1]) tauriCli = args[++i];
  else {
    console.error(`unknown argument: ${args[i]}\nusage: node build-icons.mjs [--tauri-cli <path to cargo-tauri>]`);
    process.exit(1);
  }
}

// ---- the macOS variants: 512 canvas with plate 448 at 32 -> 1024 canvas with plate 824 at 100 ----
const MAC_SCALE = 824 / 448;
const MAC_SHIFT = 100 - 32 * MAC_SCALE;
function macVariant(svg) {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><filter id="mac-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/></filter></defs>
  <g filter="url(#mac-shadow)"><g transform="translate(${MAC_SHIFT.toFixed(4)} ${MAC_SHIFT.toFixed(4)}) scale(${MAC_SCALE.toFixed(6)})">${inner}</g></g>
</svg>
`;
}

// ---- rasterising (Tauri CLI `icon --png`, which writes <n>x<n>.png) ----
const work = mkdtempSync(join(tmpdir(), 'aspace-icons-'));
function rasterise(svgText, name, sizes) {
  const src = join(work, `${name}.svg`);
  const out = join(work, name);
  writeFileSync(src, svgText);
  execFileSync(tauriCli, ['icon', src, '-o', out, '--png', sizes.join(',')], { stdio: ['ignore', 'ignore', 'inherit'] });
  return Object.fromEntries(sizes.map(n => [n, readFileSync(join(out, `${n}x${n}.png`))]));
}

// ---- a minimal PNG reader (8-bit RGBA, not interlaced: what resvg writes) for the ICO's BMP entries ----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected an 8-bit RGBA, non-interlaced PNG');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? px[y * stride + x - 4] : 0, up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px };
}

// A 32-bit BMP icon entry: BITMAPINFOHEADER (height doubled for the AND mask), BGRA rows bottom-up, an all-zero mask.
function bmpEntry(png) {
  const { width, height, px } = decodePng(png);
  const maskStride = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = ((height - 1 - y) * width + x) * 4;
      pixels[d] = px[s + 2];
      pixels[d + 1] = px[s + 1];
      pixels[d + 2] = px[s];
      pixels[d + 3] = px[s + 3];
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * height)]);
}

function ico(entries) {
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map(e => e.data)]);
}

function icns(entries) {
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

try {
  const version = execFileSync(tauriCli, ['--version'], { encoding: 'utf8' }).trim();
  const full = readFileSync(join(sourceDir, 'app-icon.svg'), 'utf8');
  const small = readFileSync(join(sourceDir, 'app-icon-small.svg'), 'utf8');
  const f = rasterise(full, 'full', [48, 64, 128, 256, 512]);
  const s = rasterise(small, 'small', [16, 24, 32]);
  const mf = rasterise(macVariant(full), 'mac-full', [64, 128, 256, 512, 1024]);
  const ms = rasterise(macVariant(small), 'mac-small', [16, 32]);

  const written = {
    '16x16.png': s[16],
    '32x32.png': s[32],
    '48x48.png': f[48],
    '64x64.png': f[64],
    '128x128.png': f[128],
    '256x256.png': f[256],
    'icon.png': f[512],
    'icon.ico': ico([
      { size: 16, data: bmpEntry(s[16]) },
      { size: 24, data: bmpEntry(s[24]) },
      { size: 32, data: bmpEntry(s[32]) },
      { size: 48, data: bmpEntry(f[48]) },
      { size: 64, data: bmpEntry(f[64]) },
      { size: 256, data: f[256] },
    ]),
    // PNG entries: 16/32 pt at 1x and 2x, then 128/256/512 pt at 1x and 2x.
    'icon.icns': icns([
      { type: 'icp4', data: ms[16] },
      { type: 'ic11', data: ms[32] },
      { type: 'icp5', data: ms[32] },
      { type: 'ic12', data: mf[64] },
      { type: 'ic07', data: mf[128] },
      { type: 'ic13', data: mf[256] },
      { type: 'ic08', data: mf[256] },
      { type: 'ic14', data: mf[512] },
      { type: 'ic09', data: mf[512] },
      { type: 'ic10', data: mf[1024] },
    ]),
  };
  for (const [name, data] of Object.entries(written)) writeFileSync(join(iconsDir, name), data);
  console.log(`${version}: wrote ${Object.keys(written).join(', ')} in ${iconsDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
