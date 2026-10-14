/**
 * Which latexmk the Writer's sandbox would run (desktop-app ticket 13 revision; user decision 2026-10-14: the sandbox
 * itself is not changed, the environment check only says so). `sandbox.ts` gives the sandbox a minimal PATH — the
 * system directories, then the directories of the TeX programs it found on the server's PATH when it probed
 * (`discoverTexRoots`: latexmk, pdflatex, xelatex, bibtex, kpsewhich; outside /usr and safe to bind) — so a TeX that is
 * only in the configured TeX directory is not there, and a TeX in the system directories may be used instead.
 *
 * This repeats that discovery without running anything (it reads `sandbox.ts`'s rule, it does not share its state): it
 * is asked now, with the PATH of now, while the sandbox decided at its probe. A PATH changed since the probe (not
 * possible for a running server, whose PATH is fixed) would make the two differ.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSafeTexRoot } from "./sandbox.js";

/** The system directories first on the sandbox's PATH (`sandbox.ts` `SAFE_SYSTEM_PATH`). */
export const SANDBOX_SYSTEM_DIRS: readonly string[] = ["/usr/local/bin", "/usr/bin", "/bin"];
const DISCOVERED = ["latexmk", "pdflatex", "xelatex", "bibtex", "kpsewhich"];

export interface SandboxViewOptions {
  /** The server's PATH (default `process.env.PATH`). */
  hostPath?: string | undefined;
  /** Tests only: the system directories (default {@link SANDBOX_SYSTEM_DIRS}). */
  systemDirs?: readonly string[];
}

function program(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether a directory, put on the PATH the workbench starts with, would be on the sandbox's PATH: `bindable` (not under
 * /usr and `isSafeTexRoot`), `under_usr` (bound with /usr but never on the sandbox's PATH, e.g. TeX Live's own
 * /usr/local/texlive/<year>/bin/<arch>), `not_bindable` (the home directory, /tmp, /var, /mnt and the other places
 * `isSafeTexRoot` refuses). By the directory's real path, as `sandbox.ts` does.
 */
export type SandboxReach = "bindable" | "under_usr" | "not_bindable";

export function sandboxReach(dir: string): SandboxReach {
  const r = real(dir);
  if (r === "/usr" || r.startsWith("/usr/")) return "under_usr";
  return isSafeTexRoot(r) ? "bindable" : "not_bindable";
}

/** The directories of the sandbox's PATH, in order: the system directories, then the TeX directories found on PATH. */
export function sandboxPathDirs(opts: SandboxViewOptions = {}): string[] {
  const hostDirs = (opts.hostPath ?? process.env.PATH ?? "").split(":");
  const bins: string[] = [];
  for (const name of DISCOVERED) {
    for (const dir of hostDirs) {
      const candidate = path.join(dir, name);
      if (!dir || !existsSync(candidate)) continue;
      const dirOf = path.dirname(real(candidate));
      if (sandboxReach(dirOf) === "bindable" && !bins.includes(dirOf)) bins.push(dirOf);
      break;
    }
  }
  return [...(opts.systemDirs ?? SANDBOX_SYSTEM_DIRS), ...bins];
}

/** The latexmk the sandbox would find on its PATH, as the real path of the file; null when it has none. */
export function sandboxLatexmk(opts: SandboxViewOptions = {}): string | null {
  for (const dir of sandboxPathDirs(opts)) {
    const candidate = path.join(dir, "latexmk");
    if (program(candidate)) return real(candidate);
  }
  return null;
}

/**
 * How the sandbox's latexmk compares with the one the workbench found (`located`): the same file, another one, none;
 * `not_applicable` when the sandbox is not used here or no latexmk was found at all. With `different` / `not_found`,
 * `reach` says whether the found latexmk's directory could reach the sandbox through the PATH the workbench starts with.
 */
export type SandboxTexState = "same" | "different" | "not_found" | "not_applicable";

export function sandboxTexState(
  located: string | null,
  sandboxAvailable: boolean,
  opts: SandboxViewOptions = {}
): { state: SandboxTexState; latexmk: string | null; reach: SandboxReach | null } {
  if (!sandboxAvailable || located === null)
    return { state: "not_applicable", latexmk: null, reach: null };
  const inside = sandboxLatexmk(opts);
  const reach = sandboxReach(path.dirname(real(located)));
  if (inside === null) return { state: "not_found", latexmk: null, reach };
  return inside === real(located)
    ? { state: "same", latexmk: inside, reach: null }
    : { state: "different", latexmk: inside, reach };
}
