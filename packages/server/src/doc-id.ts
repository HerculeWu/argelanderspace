/**
 * The server's one Doc id path-traversal guard (Python `_paper_path` /
 * `get_image` parity). Every route that turns a Doc id into a path under
 * `output/` or `annotations/` uses this, so DELETE, reads and publishing all
 * judge the same id the same way. The empty string is NOT bad here: callers
 * pair the guard with their own `!id.trim()` check. The CLI deliberately has
 * no such guard (contracts I015).
 */
export function badDocId(id: string): boolean {
  return id.includes("/") || id.includes("\\") || id.startsWith(".");
}

/**
 * The same single-path-segment guard, named for user-supplied file names
 * (manuscript asset names, upload filenames) rather than Doc ids.
 */
export const badFileName = badDocId;
