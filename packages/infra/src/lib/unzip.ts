/**
 * Minimal ZIP extraction for the MinerU result bundle — replaces
 * `zipfile.ZipFile(io.BytesIO(...)).extractall(cache_dir)` in
 * `bibgraph/mineru_client.py` without adding a dependency.
 *
 * Supports what MinerU emits: stored (method 0) and deflated (method 8)
 * members, located via the end-of-central-directory record. Like
 * `ZipFile.extractall`, member names are sanitized (absolute paths and `..`
 * components stripped) before writing. No size caps — the Python has none
 * and the zip comes from the trusted MinerU service over TLS.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** `ZipFile.extractall` name sanitization: strip drive/absolute/`..` parts. */
function safeName(name: string): string | undefined {
  const parts = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..");
  if (parts.length === 0) return undefined;
  return parts.join("/");
}

/** Extract all regular files of a zip buffer into `destDir`. */
export function extractZip(buf: Uint8Array, destDir: string): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan the tail for its signature.
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip (no end-of-central-directory record)");
  const count = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  mkdirSync(destDir, { recursive: true });
  for (let n = 0; n < count; n++) {
    if (cd + 46 > buf.length || view.getUint32(cd, true) !== 0x02014b50) {
      throw new ZipError("corrupt central directory");
    }
    const method = view.getUint16(cd + 10, true);
    const compSize = view.getUint32(cd + 20, true);
    const nameLen = view.getUint16(cd + 28, true);
    const extraLen = view.getUint16(cd + 30, true);
    const commentLen = view.getUint16(cd + 32, true);
    const localOff = view.getUint32(cd + 42, true);
    const rawName = new TextDecoder().decode(buf.subarray(cd + 46, cd + 46 + nameLen));
    cd += 46 + nameLen + extraLen + commentLen;

    const name = safeName(rawName);
    if (name === undefined || rawName.endsWith("/")) continue; // directory entry
    if (localOff + 30 > buf.length || view.getUint32(localOff, true) !== 0x04034b50) {
      throw new ZipError(`corrupt local header for ${rawName}`);
    }
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new ZipError(`truncated data for ${rawName}`);
    const data = buf.subarray(dataStart, dataStart + compSize);
    let out: Uint8Array;
    if (method === 0) out = new Uint8Array(data);
    else if (method === 8) {
      try {
        out = new Uint8Array(inflateRawSync(data));
      } catch (e) {
        throw new ZipError(`inflate failed for ${rawName}: ${String(e)}`);
      }
    } else {
      throw new ZipError(`unsupported compression method ${method} for ${rawName}`);
    }
    const target = join(destDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out);
  }
}
