/**
 * A real boundary for Writer compiles (copilot ticket 23, spec 14.1). Text that reaches the TeX engine can come from an
 * agent (directly, or through library BibTeX it imported), and TeX has file-reading primitives that ignore kpathsea's
 * `openin_any` (pdfTeX `\pdfobj file{...}`, `\pdfximage`, XeTeX `\XeTeXpdffile`, biber): no setting of the engine makes
 * it safe. So when bubblewrap works, the Writer's latexmk runs inside it: read-only system trees and the TeX Live
 * installation, the compile workspace read-write at the fixed path /work, no network, and nothing else of the
 * filesystem (no HOME, no data directory, no /tmp, no /etc beyond TeX's own). The sandbox gets a minimal PATH, HOME and
 * TMPDIR=/work, a fixed hostname, and its arguments through a file descriptor (so /proc/1/cmdline shows no host path).
 * Without bubblewrap there is no such boundary: the server then never lets the Copilot cause a compile.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { type ExternalObserver, reportProgram } from "../lib/observe.js";

export const SANDBOX_WORKDIR = "/work";
const PROBE_RETRY_MS = 60_000;

let override: boolean | null = null;
let available: boolean | null = null;
let probedAt = 0;
let inflight: Promise<boolean> | null = null;
/** Read-only extras beyond /usr: the TeX Live installation root and the directories of the TeX binaries, if elsewhere. */
let texBinds: string[] = [];
let texBinDirs: string[] = [];
let bwrapPath = "bwrap";

/** Tests only: force the sandbox on/off (null = detect). */
export function __setWriterSandboxForTests(value: boolean | null): void {
  override = value;
}

const SYSTEM_TREES = ["/usr"];
const SYMLINKED_ROOTS = ["bin", "lib", "lib64", "sbin"];
/** The only parts of /etc and /var a TeX run reads (fonts, TeX configuration, the loader cache). */
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
const SAFE_SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];

/**
 * A directory that may be bound read-only as part of the TeX installation: never a root, never a parent of a place that
 * holds user data (home directories, /root, /tmp, /mnt, /media, /srv, /var), never inside /usr (bound already).
 */
export function isSafeTexRoot(dir: string): boolean {
  if (!path.isAbsolute(dir) || dir === "/") return false;
  const clean = path.normalize(dir).replace(/\/+$/, "");
  if (clean.split("/").filter(Boolean).length < 2) return false;
  for (const private_ of [
    "/home",
    "/root",
    "/tmp",
    "/mnt",
    "/media",
    "/srv",
    "/var",
    "/run",
    "/etc",
  ]) {
    if (clean === private_ || clean.startsWith(`${private_}/`) || private_.startsWith(`${clean}/`))
      return false;
  }
  return !(clean === "/usr" || clean.startsWith("/usr/"));
}

function baseArgs(): string[] {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--hostname",
    "writer-sandbox",
  ];
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
  for (const dir of texBinds) args.push("--ro-bind-try", dir, dir);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  return args;
}

const run = (
  cmd: string,
  args: string[],
  timeout = 10_000
): Promise<{ status: number | null; stdout: string }> =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, env: { PATH: process.env.PATH ?? SAFE_SYSTEM_PATH.join(":") } },
      (error, stdout) => {
        resolve({
          status: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout ?? ""),
        });
      }
    );
  });

/** Where the TeX installation lives when it is not under /usr (asks the TeX tools themselves, never guesses). */
async function discoverTexRoots(): Promise<void> {
  const binds = new Set<string>();
  const bins = new Set<string>();
  const root = (await run("kpsewhich", ["-var-value=SELFAUTOPARENT"])).stdout.trim();
  if (isSafeTexRoot(root)) binds.add(root);
  for (const name of ["latexmk", "pdflatex", "xelatex", "bibtex", "kpsewhich"]) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = path.join(dir, name);
      if (!dir || !existsSync(candidate)) continue;
      const real = path.dirname(realpathSync(candidate));
      if (!real.startsWith("/usr/") && real !== "/usr" && isSafeTexRoot(real)) {
        bins.add(real);
        binds.add(real);
      }
      break;
    }
  }
  texBinds = [...binds];
  texBinDirs = [...bins];
}

async function probe(observer: ExternalObserver | undefined): Promise<boolean> {
  const started = performance.now();
  try {
    await discoverTexRoots();
    bwrapPath = (await run("sh", ["-c", "command -v bwrap"])).stdout.trim() || "bwrap";
    const child = spawn(bwrapPath, [...baseArgs(), "/usr/bin/true"], {
      stdio: "ignore",
      env: { PATH: SAFE_SYSTEM_PATH.join(":") },
    });
    const status = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 10_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    reportProgram(observer, {
      program: "bwrap",
      sandboxed: false,
      exitCode: status,
      signal: null,
      timedOut: false,
      durationMs: performance.now() - started,
    });
    return status === 0;
  } catch {
    return false;
  }
}

/**
 * Probe (asynchronously, never blocking the event loop) whether the bubblewrap boundary really works here. A positive
 * answer is kept; a negative one is retried at most once a minute, so a machine that gains bwrap or user namespaces is
 * picked up without a restart.
 */
export function ensureWriterSandboxProbe(observer?: ExternalObserver): Promise<boolean> {
  if (override !== null) return Promise.resolve(override);
  if (available === true) return Promise.resolve(true);
  if (available === false && Date.now() - probedAt < PROBE_RETRY_MS) return Promise.resolve(false);
  inflight ??= probe(observer)
    .then((ok) => {
      available = ok;
      probedAt = Date.now();
      return ok;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The cached answer, never blocking: false until a probe has said true (so a gate that asks before the first probe
 * finished is conservative). A stale negative triggers a background re-probe.
 */
export function writerSandboxAvailable(): boolean {
  if (override !== null) return override;
  if (available !== true) void ensureWriterSandboxProbe();
  return available === true;
}

/**
 * `bwrap ... <cmd> <args>` for a compile in `workDir`. The workspace appears at /work; the sandbox sees only a minimal
 * environment (no host path in it); the bwrap options (which name the host workspace) travel through `fdInput`
 * (`--args 3`), and the command line holds only relative names, so no host path is in any command line either.
 */
export function writerSandboxCommand(
  workDir: string,
  env: Record<string, string>,
  cmd: string,
  args: readonly string[]
): { cmd: string; args: string[]; fdInput: Buffer; env: Record<string, string>; cwd: string } {
  const out = baseArgs();
  out.push("--bind", workDir, SANDBOX_WORKDIR, "--chdir", SANDBOX_WORKDIR);
  const inner: Record<string, string> = {
    PATH: [...SAFE_SYSTEM_PATH, ...texBinDirs].join(":"),
    HOME: SANDBOX_WORKDIR,
    TMPDIR: SANDBOX_WORKDIR,
  };
  // Only settings and locale cross over: a TEX* variable of the host names host paths that are not mounted anyway.
  for (const [key, value] of Object.entries(env)) {
    if (
      /^(shell_escape|openin_any|openout_any|LANG|LC_[A-Z]+|TZ|SOURCE_DATE_EPOCH|FORCE_SOURCE_DATE)$/.test(
        key
      )
    )
      inner[key] = value;
  }
  for (const [key, value] of Object.entries(inner)) out.push("--setenv", key, value);

  return {
    cmd: bwrapPath,
    // the command and its arguments name no host path (the workspace is /work, files are relative)
    args: ["--args", "3", cmd, ...args],
    fdInput: Buffer.from(`${out.join("\0")}\0`),
    env: { PATH: SAFE_SYSTEM_PATH.join(":") },
    cwd: "/",
  };
}

/** The read-only extra trees the sandbox binds beyond /usr (for tests and diagnostics). */
export function writerSandboxBinds(): string[] {
  return [...texBinds];
}
