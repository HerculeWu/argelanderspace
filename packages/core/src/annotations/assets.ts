/** Concrete filesystem reads. Legacy fingerprint callers deliberately skip the
 * server precheck: their symlink/error behavior is a frozen CLI contract. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function readAssetBytes(path: string): Buffer {
  if (!statSync(path).isFile()) throw new Error("not a regular file");
  return readFileSync(path);
}

export function assetBytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class DocumentAssetError extends Error {
  constructor(
    readonly code: "invalid" | "missing" | "read",
    message: string
  ) {
    super(message);
    this.name = "DocumentAssetError";
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Server-only precheck + one byte read/hash. No ensure, writes, or history.
 * Cross-process replacement between filesystem checks is not supported. */
export function readDocumentAsset(
  docDir: string,
  imgPath: string
): {
  bytes: Buffer;
  sha256: string;
} {
  if (
    imgPath.includes("\\") ||
    imgPath.includes("\0") ||
    imgPath.split("/").some((s) => s === "" || s.startsWith("."))
  ) {
    throw new DocumentAssetError("invalid", "bad filename");
  }
  const root = resolve(docDir);
  const parts = imgPath.includes("/") ? imgPath.split("/") : ["assets", imgPath];
  const path = resolve(root, ...parts);
  if (!contained(root, path)) throw new DocumentAssetError("invalid", "bad filename");
  try {
    // Reject symlinks at the document root and every relative component, even
    // when currently pointing inside. Realpath containment also checks aliases.
    let current = root;
    for (const part of ["", ...parts]) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        throw new DocumentAssetError("invalid", "unsafe asset symlink");
      }
    }
    if (!contained(realpathSync(root), realpathSync(path))) {
      throw new DocumentAssetError("invalid", "unsafe asset path");
    }
    const bytes = readAssetBytes(path);
    return { bytes, sha256: assetBytesHash(bytes) };
  } catch (err) {
    if (err instanceof DocumentAssetError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new DocumentAssetError(
      code === "ENOENT" || code === "ENOTDIR" ? "missing" : "read",
      `cannot read asset "${imgPath}": ${(err as Error).message}`
    );
  }
}
