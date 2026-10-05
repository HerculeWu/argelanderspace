/**
 * Image assets of a text Doc (copilot ticket 27): bounded bytes in, a controlled file name out.
 *
 * - Content is judged by its BYTES (PNG / JPEG / WebP signatures and structure), never by a name or a client-declared
 *   type; the pixel size is read from the header (nothing is decoded here), so a decompression bomb is refused before
 *   any decoder sees it.
 * - The stored name is `<stem>-<sha8>.<ext>`: the stem is the user's file name made safe, the extension comes from the
 *   sniffed type, the hash makes a changed image a different file. An existing file is NEVER overwritten (`wx`), so an
 *   already published reading text keeps the exact bytes it was generated with.
 * - A file name that tries a path (separator, `..`, leading dot, NUL) is refused, not repaired. `assets/` must be a real
 *   directory (not a symlink) of a real Doc directory.
 *
 * Locks belong to the caller (the server's text lock): the image is written first, then the source (`rev`, asset list),
 * and an image this call created is removed again if the source write fails.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TEXT_ASSET_MAX_BYTES,
  TEXT_ASSET_MAX_COUNT,
  TEXT_ASSET_MAX_PIXELS,
  TEXT_ASSET_MAX_SIDE,
  TEXT_ASSET_NAME_PATTERN,
  type TextAssetMediaType,
  type TextDocSource,
  type TextSourceAsset,
} from "@argelanderspace/contracts";
import type { LibraryPaths } from "./library/store.js";
import { readTextSource, replaceTextSource, TextDocError, textDocDir } from "./text-docs.js";

export type TextAssetErrorCode =
  | "bad_name"
  | "too_large"
  | "empty"
  | "unsupported_type"
  | "corrupt_image"
  | "too_many_pixels"
  | "too_many_assets"
  | "unsafe"
  | "write_failed";

export class TextAssetError extends Error {
  readonly code: TextAssetErrorCode;
  constructor(code: TextAssetErrorCode, message: string) {
    super(message);
    this.name = "TextAssetError";
    this.code = code;
  }
}

export interface SniffedImage {
  mediaType: TextAssetMediaType;
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function sniffPng(b: Buffer): SniffedImage | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR")
    throw new TextAssetError("corrupt_image", "the PNG has no readable header");
  if (!b.subarray(b.length - 12).equals(PNG_IEND))
    throw new TextAssetError("corrupt_image", "the PNG is truncated or damaged");
  return {
    mediaType: "image/png",
    ext: "png",
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  };
}

function sniffJpeg(b: Buffer): SniffedImage | null {
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let end = b.length;
  while (end > 2 && b[end - 1] === 0) end -= 1;
  if (b[end - 2] !== 0xff || b[end - 1] !== 0xd9)
    throw new TextAssetError("corrupt_image", "the JPEG is truncated or damaged");
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    while (b[i + 1] === 0xff) i += 1;
    const marker = b[i + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(i + 2);
    if (length < 2) break;
    const sof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (i + 9 > b.length) break;
      return {
        mediaType: "image/jpeg",
        ext: "jpg",
        height: b.readUInt16BE(i + 5),
        width: b.readUInt16BE(i + 7),
      };
    }
    i += 2 + length;
  }
  throw new TextAssetError("corrupt_image", "the JPEG has no readable frame header");
}

function sniffWebp(b: Buffer): SniffedImage | null {
  if (
    b.length < 12 ||
    b.toString("latin1", 0, 4) !== "RIFF" ||
    b.toString("latin1", 8, 12) !== "WEBP"
  )
    return null;
  if (b.length < 30 || b.readUInt32LE(4) + 8 > b.length)
    throw new TextAssetError("corrupt_image", "the WebP is truncated or damaged");
  const chunk = b.toString("latin1", 12, 16);
  const byte = (i: number): number => b[i] as number;
  let width = 0;
  let height = 0;
  if (chunk === "VP8 ") {
    if (byte(23) !== 0x9d || byte(24) !== 0x01 || byte(25) !== 0x2a)
      throw new TextAssetError("corrupt_image", "the WebP has no readable frame header");
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (chunk === "VP8L") {
    if (byte(20) !== 0x2f)
      throw new TextAssetError("corrupt_image", "the WebP has no readable frame header");
    width = 1 + (byte(21) | ((byte(22) & 0x3f) << 8));
    height = 1 + ((byte(22) >> 6) | (byte(23) << 2) | ((byte(24) & 0x0f) << 10));
  } else if (chunk === "VP8X") {
    width = 1 + (byte(24) | (byte(25) << 8) | (byte(26) << 16));
    height = 1 + (byte(27) | (byte(28) << 8) | (byte(29) << 16));
  } else throw new TextAssetError("corrupt_image", "the WebP has no readable frame header");
  return { mediaType: "image/webp", ext: "webp", width, height };
}

/** The type and size of an image judged by its bytes; throws {@link TextAssetError} for anything else. */
export function sniffImage(bytes: Buffer): SniffedImage {
  if (bytes.length === 0) throw new TextAssetError("empty", "the file is empty");
  if (bytes.length > TEXT_ASSET_MAX_BYTES)
    throw new TextAssetError("too_large", `the file is larger than ${TEXT_ASSET_MAX_BYTES} bytes`);
  const found = sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
  if (found === null)
    throw new TextAssetError("unsupported_type", "only PNG, JPEG and WebP images are accepted");
  if (found.width < 1 || found.height < 1)
    throw new TextAssetError("corrupt_image", "the image has no size");
  if (
    found.width > TEXT_ASSET_MAX_SIDE ||
    found.height > TEXT_ASSET_MAX_SIDE ||
    found.width * found.height > TEXT_ASSET_MAX_PIXELS
  )
    throw new TextAssetError(
      "too_many_pixels",
      `the image is ${found.width}x${found.height} pixels; at most ${TEXT_ASSET_MAX_PIXELS} pixels (side up to ${TEXT_ASSET_MAX_SIDE}) are accepted`
    );
  return found;
}

/** The user's file name made into a stem; a name that tries a path is refused. Empty or absent gives `image`. */
export function assetStem(filename: string | undefined): string {
  if (filename === undefined || filename.trim() === "") return "image";
  if (
    /[\\/\0]/.test(filename) ||
    filename.includes("..") ||
    filename.startsWith(".") ||
    /^[A-Za-z]:/.test(filename)
  )
    throw new TextAssetError("bad_name", "the file name must not contain a path");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const stem = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
  return stem === "" ? "image" : stem;
}

export function assetFileName(stem: string, sha256: string, ext: string): string {
  const name = `${stem}-${sha256.slice(0, 8)}.${ext}`;
  if (!TEXT_ASSET_NAME_PATTERN.test(name)) throw new TextAssetError("bad_name", "bad asset name");
  return name;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `<docDir>/assets`, which must be a real directory of a real Doc directory (never a symlink). */
function assetsDirOf(paths: LibraryPaths, docId: string, create: boolean): string {
  const dir = textDocDir(paths, docId);
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new TextAssetError("unsafe", "unsafe text Doc directory");
  const assets = join(dir, "assets");
  if (existsSync(assets) || isLink(assets)) {
    const a = lstatSync(assets);
    if (!a.isDirectory() || a.isSymbolicLink())
      throw new TextAssetError("unsafe", "the assets directory is not a plain directory");
  } else if (create) mkdirSync(assets);
  return assets;
}

export type AddTextAssetResult =
  | { kind: "added" | "reused"; source: TextDocSource; asset: TextSourceAsset }
  | { kind: "conflict"; source: TextDocSource };

/**
 * Register one image: validated by its bytes, written with a new controlled name (never over an existing file), and
 * entered in the source's asset list with `rev + 1`. The same bytes registered again return the existing asset and
 * change nothing. `expectedRev` must be the stored revision, else `conflict` and nothing is written. The caller holds
 * the Doc's text lock.
 */
export function addTextAsset(
  paths: LibraryPaths,
  docId: string,
  input: { expectedRev: number; bytes: Buffer; filename?: string },
  now: Date = new Date()
): AddTextAssetResult {
  const current = readTextSource(paths, docId);
  if (current.rev !== input.expectedRev) return { kind: "conflict", source: current };
  const stem = assetStem(input.filename);
  const sniffed = sniffImage(input.bytes);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const known = current.assets.find((a) => a.sha256 === sha256);
  if (known) return { kind: "reused", source: current, asset: known };
  if (current.assets.length >= TEXT_ASSET_MAX_COUNT)
    throw new TextAssetError(
      "too_many_assets",
      `a text Doc holds at most ${TEXT_ASSET_MAX_COUNT} images`
    );
  const name = assetFileName(stem, sha256, sniffed.ext);
  const asset: TextSourceAsset = {
    name,
    sha256,
    byte_length: input.bytes.length,
    media_type: sniffed.mediaType,
    width: sniffed.width,
    height: sniffed.height,
  };
  const dir = assetsDirOf(paths, docId, true);
  const file = join(dir, name);
  let created = false;
  try {
    // `wx`: an existing file (registered or not) is never touched
    writeFileSync(file, input.bytes, { flag: "wx" });
    created = true;
    const next: TextDocSource = {
      ...current,
      rev: current.rev + 1,
      assets: [...current.assets, asset],
      updated_at: now.toISOString(),
    };
    const saved = replaceTextSource(paths, docId, next);
    return { kind: "added", source: saved, asset };
  } catch (error) {
    if (created) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* an orphan file is harmless: it is not registered and is never overwritten */
      }
    }
    if (error instanceof TextAssetError || error instanceof TextDocError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new TextAssetError(
        "write_failed",
        "an unregistered file of this name already exists; nothing was changed"
      );
    throw new TextAssetError(
      "write_failed",
      `the image could not be saved: ${(error as Error).message}`
    );
  }
}

/** The bytes of a registered asset, verified against its registered hash; throws when missing or changed. */
export function readTextAsset(paths: LibraryPaths, docId: string, asset: TextSourceAsset): Buffer {
  const dir = assetsDirOf(paths, docId, false);
  if (!TEXT_ASSET_NAME_PATTERN.test(asset.name))
    throw new TextAssetError("bad_name", "bad asset name");
  const file = join(dir, asset.name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new TextAssetError("unsafe", "unsafe asset file");
  const bytes = readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new TextAssetError(
      "corrupt_image",
      `asset "${asset.name}" no longer matches its registered hash`
    );
  return bytes;
}
