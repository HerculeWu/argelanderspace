/**
 * Isolated temporary workspace for TeX compilation (Stage 5 MS1):
 *  - the full source tree is copied under os.tmpdir(); compilation never
 *    happens in the user's directory;
 *  - symlinks are never followed — encountering one is UNSAFE;
 *  - every copied path passes a resolved-path containment check;
 *  - byte and file-count guards are enforced while copying in, and again
 *    over the whole workspace after compilation.
 *
 * Guard violations raise {@link TexWorkspaceError}; the compile port maps
 * them onto the `unsupported-build` outcome kind.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TexWorkspaceLimits {
  maxFiles: number;
  maxBytes: number;
}

/** 10k files / 2 GiB, matching the prototype's workspace guards. */
export const TEX_WORKSPACE_LIMITS: TexWorkspaceLimits = {
  maxFiles: 10_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};

export type TexWorkspaceErrorKind = "unsafe-source" | "resource-limit";

export class TexWorkspaceError extends Error {
  readonly kind: TexWorkspaceErrorKind;
  constructor(kind: TexWorkspaceErrorKind, message: string) {
    super(message);
    this.name = "TexWorkspaceError";
    this.kind = kind;
  }
}

export interface TexWorkspace {
  /** Absolute path of the temporary workspace root. */
  dir: string;
  cleanup(): Promise<void>;
}

interface Counters {
  files: number;
  bytes: number;
}

function isContained(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function copyTree(
  src: string,
  dst: string,
  sourceRoot: string,
  limits: TexWorkspaceLimits,
  counters: Counters
): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const rel = path.relative(sourceRoot, srcPath);

    if (entry.isSymbolicLink()) {
      throw new TexWorkspaceError(
        "unsafe-source",
        `source contains a symlink, which is never followed: ${rel}`
      );
    }

    if (entry.isDirectory()) {
      const real = await fs.realpath(srcPath);
      if (!isContained(real, sourceRoot)) {
        throw new TexWorkspaceError(
          "unsafe-source",
          `path containment violation: ${rel} resolves outside the source directory`
        );
      }
      await copyTree(srcPath, path.join(dst, entry.name), sourceRoot, limits, counters);
      continue;
    }

    if (!entry.isFile()) {
      throw new TexWorkspaceError(
        "unsafe-source",
        `source contains a non-regular file (fifo/socket/device): ${rel}`
      );
    }

    const stat = await fs.stat(srcPath);
    counters.files += 1;
    counters.bytes += stat.size;
    if (counters.files > limits.maxFiles) {
      throw new TexWorkspaceError(
        "resource-limit",
        `file count limit exceeded while copying source (>${limits.maxFiles} files)`
      );
    }
    if (counters.bytes > limits.maxBytes) {
      throw new TexWorkspaceError(
        "resource-limit",
        `workspace byte limit exceeded while copying source (>${limits.maxBytes} bytes)`
      );
    }
    await fs.copyFile(srcPath, path.join(dst, entry.name));
  }
}

/** Copy `sourceDir` into a fresh temporary workspace. */
export async function createTexWorkspace(
  sourceDir: string,
  limits: TexWorkspaceLimits = TEX_WORKSPACE_LIMITS
): Promise<TexWorkspace> {
  const sourceRoot = await fs.realpath(path.resolve(sourceDir));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argelander-tex-"));
  try {
    await copyTree(sourceRoot, dir, sourceRoot, limits, { files: 0, bytes: 0 });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Re-check the workspace after compilation: TeX output counts against the
 * same byte/file guards.
 */
export async function guardTexWorkspaceSize(
  dir: string,
  limits: TexWorkspaceLimits = TEX_WORKSPACE_LIMITS
): Promise<void> {
  const counters: Counters = { files: 0, bytes: 0 };
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        counters.files += 1;
        counters.bytes += (await fs.stat(full)).size;
      }
    }
  };
  await walk(dir);
  if (counters.files > limits.maxFiles) {
    throw new TexWorkspaceError(
      "resource-limit",
      `file count limit exceeded in workspace after compilation (${counters.files} > ${limits.maxFiles})`
    );
  }
  if (counters.bytes > limits.maxBytes) {
    throw new TexWorkspaceError(
      "resource-limit",
      `workspace byte limit exceeded after compilation (${counters.bytes} > ${limits.maxBytes} bytes)`
    );
  }
}
