import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PDF_MAX_BYTES } from "@argelanderspace/contracts";
import { normalizePdfFilename } from "./pdf-filename.js";

/**
 * Reading one PDF from a local path for `attach_local_pdf` (contracts "项目迁入"). This module is only the read: the
 * bytes then enter the upload's own server path (`startPdfUpload`), which does the trusted parse, the memory and page
 * checks, the dedupe and the publication.
 *
 * The source is touched read-only and once: `lstat` (a symbolic link must lead to a regular file), then one
 * read-only, non-blocking open whose handle is checked again with `fstat` (a path swapped for a pipe or device between
 * the two cannot block or be read), then the bytes are read from that handle, which is asked once more (`fstat`) before it is closed; a length or modification time that differs from the first answer is `changed_while_reading`. It is never opened for
 * writing, moved, renamed, truncated or deleted, and nothing here knows the data directory.
 */
export type LocalPdfFailure =
  | "path_not_absolute"
  | "source_not_found"
  | "not_regular_file"
  | "unreadable"
  | "too_large"
  | "changed_while_reading"
  | "empty"
  | "invalid_filename";

export type LocalPdfRead =
  | { ok: true; bytes: Buffer; filename: string }
  | { ok: false; reason: LocalPdfFailure };

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | null)?.code ?? "");

export function readLocalPdf(path: string): LocalPdfRead {
  if (!isAbsolute(path) || path.includes("\0")) return { ok: false, reason: "path_not_absolute" };
  const filename = normalizePdfFilename(path);
  if (filename === null) return { ok: false, reason: "invalid_filename" };
  let fd: number | undefined;
  try {
    try {
      const entry = lstatSync(path);
      // A link is followed only to a regular file; anything else (a directory, a device, a pipe) is refused.
      const target = entry.isSymbolicLink() ? statSync(path) : entry;
      if (!target.isFile()) return { ok: false, reason: "not_regular_file" };
      fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile()) return { ok: false, reason: "not_regular_file" };
      if (opened.size > PDF_MAX_BYTES) return { ok: false, reason: "too_large" };
      // Exactly the size the handle reported, then one probe byte: a file that is longer or shorter than that (it
      // changed while being read, or a pseudo-file reports a size that is not its length) is refused, never cut.
      const buffer = Buffer.allocUnsafe(opened.size);
      let total = 0;
      while (total < buffer.length) {
        const n = readSync(fd, buffer, total, buffer.length - total, null);
        if (n === 0) break;
        total += n;
      }
      if (total !== opened.size || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
        return { ok: false, reason: "changed_while_reading" };
      // The same handle, asked again: a rewrite that kept the length shows in the size or the modification time.
      const after = fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
        return { ok: false, reason: "changed_while_reading" };
      if (total === 0) return { ok: false, reason: "empty" };
      return { ok: true, bytes: buffer, filename };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch (error) {
    return { ok: false, reason: missing(error) ? "source_not_found" : "unreadable" };
  }
}
