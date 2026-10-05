/**
 * A real boundary for Writer compiles (copilot ticket 23, spec 14.1). Text that reaches the TeX engine can be written
 * by an agent, and TeX has file-reading primitives that ignore kpathsea's `openin_any` (pdfTeX `\pdfobj file{...}`,
 * `\pdfximage`, XeTeX `\XeTeXpdffile`, biber): no setting of the engine makes it safe. So when bubblewrap works, the
 * Writer's latexmk runs inside it: read-only system trees TeX needs, the compile workspace read-write, no network and
 * nothing else of the filesystem (no HOME, no data directory, no /tmp beyond the workspace, no /etc beyond TeX's own).
 * Without bubblewrap there is no such boundary; callers must then refuse to compile or accept agent text (the server
 * does: see `writerSandboxAvailable`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

let override: boolean | null = null;
let probed: boolean | null = null;

/** Tests only: force the sandbox on/off (null = detect). */
export function __setWriterSandboxForTests(value: boolean | null): void {
  override = value;
}

const SYSTEM_TREES = ["/usr"];
const SYMLINKED_ROOTS = ["bin", "lib", "lib64", "sbin"];
/** The only parts of /etc, /var and /run a TeX run reads (fonts, TeX configuration, the loader cache). */
const SYSTEM_EXTRAS = [
  "/etc/texmf",
  "/etc/fonts",
  "/etc/alternatives",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/var/lib/texmf",
  "/var/cache/fontconfig",
];

function baseArgs(): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
  for (const tree of SYSTEM_TREES) args.push("--ro-bind", tree, tree);
  for (const name of SYMLINKED_ROOTS) {
    const host = `/${name}`;
    if (!existsSync(host)) continue;
    // On a merged-/usr system these are links into /usr; elsewhere they are real directories.
    if (lstatSync(host).isSymbolicLink())
      args.push("--symlink", path.relative("/", realpathSync(host)), host);
    else args.push("--ro-bind", host, host);
  }
  for (const extra of SYSTEM_EXTRAS) args.push("--ro-bind-try", extra, extra);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  return args;
}

/** Whether the bubblewrap boundary really works here (binary present and unprivileged namespaces allowed). */
export function writerSandboxAvailable(): boolean {
  if (override !== null) return override;
  if (probed !== null) return probed;
  try {
    const run = spawnSync("bwrap", [...baseArgs(), "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    probed = run.status === 0;
  } catch {
    probed = false;
  }
  return probed;
}

/** `bwrap ... <cmd> <args>` for a compile in `workDir` with exactly `env` as its environment. */
export function writerSandboxCommand(
  workDir: string,
  env: Record<string, string>,
  cmd: string,
  args: readonly string[]
): { cmd: string; args: string[] } {
  const out = baseArgs();
  // A TeX Live installed outside /usr (a /opt or /usr/local tree) must be visible too, read-only.
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || dir.startsWith("/usr") || dir.startsWith("/bin") || dir.startsWith("/sbin"))
      continue;
    if (existsSync(path.join(dir, cmd))) {
      const root = realpathSync(path.join(dir, cmd)).split(path.sep).slice(0, 3).join(path.sep);
      if (root && root !== "/" && !root.startsWith("/home") && !root.startsWith("/root"))
        out.push("--ro-bind-try", root, root);
    }
  }
  out.push("--bind", workDir, workDir, "--chdir", workDir);
  for (const [key, value] of Object.entries(env)) out.push("--setenv", key, value);
  return { cmd: "bwrap", args: [...out, cmd, ...args] };
}
