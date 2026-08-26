/**
 * Minimal POSIX ustar reader for arXiv e-print tarballs — replaces the
 * `tarfile.open(archive, "r:*")` half of `bibgraph/ingest_latex/fetch.py`
 * without adding a dependency (Node has zlib built in but no tar).
 *
 * Fidelity to the Python:
 * - gzipped or plain tar (`"r:*"`), plus GNU longname (`L`) and PAX (`x`)
 *   path/size overrides, which GNU-tar-created arXiv submissions may carry.
 * - The same decompression-bomb caps (800 MB uncompressed total, 50 000
 *   members).
 * - `filter="data"` member guards: absolute names are made relative, `..`
 *   escaping the destination raises, and symlink/hardlink/device members
 *   raise (tarfile's SpecialFileError/LinkOutsideDestinationError).
 * - A structurally invalid *first* header means "not a tar" ({@link NotATarError})
 *   so the caller can fall back to the single-gzipped-file path; corruption
 *   deeper in the stream is a hard {@link TarCorruptError} (Python splits the
 *   same cases between `tarfile.ReadError` at open and the other TarErrors).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_EXTRACT_BYTES = 800 * 1024 * 1024; // 800 MB total uncompressed
export const MAX_MEMBERS = 50_000;

/** The buffer is not a tar at all — caller may try the gzip fallback. */
export class NotATarError extends Error {}
/** A tar that started valid but is truncated/corrupt/unsafe. */
export class TarCorruptError extends Error {}

export function isGzip(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Gunzip with an output cap so a gzip bomb can't exhaust memory. */
export function gunzipCapped(buf: Uint8Array, maxBytes: number): Uint8Array {
  return new Uint8Array(gunzipSync(buf, { maxOutputLength: maxBytes }));
}

function octal(field: Uint8Array): number {
  // octal ASCII, space/NUL terminated (POSIX); tolerate leading spaces.
  let n = 0;
  let started = false;
  for (const b of field) {
    if (b === 0) break;
    if (b === 0x20 && !started) continue;
    if (b < 0x30 || b > 0x37) break;
    n = n * 8 + (b - 0x30);
    started = true;
  }
  return n;
}

function cstr(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end < 0) end = field.length;
  return new TextDecoder().decode(field.subarray(0, end));
}

function headerChecksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  }
  return sum === octal(block.subarray(148, 156));
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < 512; i++) if (block[i] !== 0) return false;
  return true;
}

/** `os.path.normpath` + the data-filter containment check, on a tar member name. */
function safeMemberName(rawName: string): string {
  // data filter: absolute paths are made relative (leading slashes stripped).
  let name = rawName.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const seg of name.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) {
        throw new TarCorruptError(`member '${rawName}' would extract outside the destination`);
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  name = parts.join("/");
  if (name === "") throw new TarCorruptError(`member '${rawName}' has no usable path`);
  return name;
}

/**
 * Extract a (possibly gzipped) tar buffer into `dest`. Throws NotATarError
 * when the first block isn't a tar header; TarCorruptError for truncation,
 * bombs, or members the data filter would refuse.
 */
export function extractTar(
  archive: Uint8Array,
  dest: string,
  opts: { maxBytes?: number; maxMembers?: number } = {}
): void {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_BYTES;
  const maxMembers = opts.maxMembers ?? MAX_MEMBERS;
  mkdirSync(dest, { recursive: true });
  let buf = archive;
  if (isGzip(buf)) {
    try {
      // tar stream ≈ member bytes + 1 KiB overhead per member + padding.
      buf = gunzipCapped(buf, maxBytes + 1024 * (maxMembers + 2));
    } catch (e) {
      throw new TarCorruptError(`gzip stream unreadable or beyond the size cap: ${String(e)}`);
    }
  }
  let offset = 0;
  let members = 0;
  let totalBytes = 0;
  let pendingName: string | undefined;
  let pendingSize: number | undefined;
  let sawHeader = false;

  const fail = (msg: string): never => {
    throw sawHeader ? new TarCorruptError(msg) : new NotATarError(msg);
  };

  for (;;) {
    if (offset + 512 > buf.length) {
      if (offset === buf.length) break; // exact end (unpadded)
      fail("truncated tar: short header block");
    }
    const header = buf.subarray(offset, offset + 512);
    // End-of-archive marker; a zero *first* block is a valid empty tar
    // (tarfile.next() returns None there), a 0-byte file is not a tar.
    if (isZeroBlock(header)) break;
    if (!headerChecksumOk(header)) fail("not a tar (bad header checksum)");
    sawHeader = true;

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = pendingSize ?? octal(header.subarray(124, 136));
    let name = pendingName ?? cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    if (pendingName === undefined && prefix !== "") name = `${prefix}/${name}`;
    pendingName = undefined;
    pendingSize = undefined;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) fail(`truncated tar: member '${name}' overruns the archive`);
    offset = dataStart + Math.ceil(size / 512) * 512;

    members += 1;
    if (members > maxMembers) {
      throw new TarCorruptError(`${members} members exceeds cap (${maxMembers}); refusing.`);
    }

    if (typeflag === "L") {
      // GNU longname: NUL-terminated name applies to the next member.
      pendingName = cstr(buf.subarray(dataStart, dataEnd));
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      // PAX records: "len key=value\n"; honor per-file path/size overrides.
      if (typeflag === "x") {
        const text = new TextDecoder().decode(buf.subarray(dataStart, dataEnd));
        for (const rec of parsePax(text)) {
          if (rec.key === "path") pendingName = rec.value;
          else if (rec.key === "size") pendingSize = Number(rec.value);
        }
      }
      continue;
    }
    if (typeflag === "0" || typeflag === "\0" || typeflag === "5") {
      const safe = safeMemberName(name);
      if (typeflag === "5") {
        mkdirSync(join(dest, safe), { recursive: true });
        continue;
      }
      totalBytes += size;
      if (totalBytes > maxBytes) {
        throw new TarCorruptError(
          `archive expands to ${totalBytes} bytes (> ${maxBytes}); refusing (bomb?).`
        );
      }
      const target = join(dest, safe);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf.subarray(dataStart, dataEnd));
      continue;
    }
    // data filter: no symlinks/hardlinks/devices/fifos.
    throw new TarCorruptError(`refusing unsafe tar member '${name}' (type '${typeflag}')`);
  }
  if (buf.length === 0) throw new NotATarError("empty input is not a tar");
}

function parsePax(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1); // strip trailing \n
    const eq = rec.indexOf("=");
    if (eq > 0) out.push({ key: rec.slice(0, eq), value: rec.slice(eq + 1) });
    i += len;
  }
  return out;
}
