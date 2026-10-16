/**
 * A real boundary for Writer compiles (copilot ticket 23, spec 14.1). Text that reaches the TeX engine can come from an
 * agent (directly, or through library BibTeX it imported), and TeX has file-reading primitives that ignore kpathsea's
 * `openin_any` (pdfTeX `\pdfobj file{...}`, `\pdfximage`, XeTeX `\XeTeXpdffile`, biber): no setting of the engine makes
 * it safe. So when bubblewrap works, the Writer's latexmk runs inside it: read-only system trees and the TeX Live
 * installation, the compile workspace read-write at the fixed path /work, no network, and nothing else of the
 * filesystem (no HOME, no data directory, no /tmp, no /etc beyond TeX's own). The sandbox gets a minimal PATH, HOME and
 * TMPDIR=/work, a fixed hostname, and its arguments through a file descriptor (so /proc/1/cmdline shows no host path).
 * Without bubblewrap there is no such boundary and the compile runs unsandboxed (the user's Render and the Copilot's alike).
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { type ExternalObserver, type ExternalProgramCall, reportProgram } from "../lib/observe.js";

export const SANDBOX_WORKDIR = "/work";
const PROBE_RETRY_MS = 60_000;

let override: boolean | null = null;
let available: boolean | null = null;
let probedAt = 0;
let inflight: Promise<boolean> | null = null;
/** Who is told how the probe in flight ended. */
let watching: Set<ExternalObserver> | null = null;
/** Tests only: the program the probe runs as bwrap. */
let forcedBwrap: string | null = null;
/** Read-only extras beyond /usr: the TeX Live installation root and the directories of the TeX binaries, if elsewhere. */
let texBinds: string[] = [];
let texBinDirs: string[] = [];
let bwrapPath = "bwrap";

/** Tests only: force the sandbox on/off (null = detect). */
export function __setWriterSandboxForTests(value: boolean | null): void {
  override = value;
}

/**
 * Tests only: forget what the last probe found and run `bwrap` as the program the next probes use (null = look for the
 * real one). Returns once a probe in flight has ended.
 */
export async function __resetWriterSandboxProbeForTests(bwrap: string | null): Promise<void> {
  await inflight?.catch(() => {});
  forcedBwrap = bwrap;
  available = null;
  probedAt = 0;
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

/** How the probe's one run of bwrap ended, as it is reported (lib/observe.ts). */
type ProbeEnd = Pick<ExternalProgramCall, "exitCode" | "signal" | "timedOut" | "error">;

/**
 * One real probe: bwrap is run once (or cannot be), and that is one call to report — a bwrap that is not there is a
 * program that could not be started (`error`), not one that exited.
 */
async function probe(): Promise<{ ok: boolean; call: ExternalProgramCall }> {
  const started = performance.now();
  const ended = (end: ProbeEnd): ExternalProgramCall => ({
    program: "bwrap",
    sandboxed: false,
    ...end,
    durationMs: performance.now() - started,
  });
  try {
    await discoverTexRoots();
    bwrapPath =
      forcedBwrap ?? ((await run("sh", ["-c", "command -v bwrap"])).stdout.trim() || "bwrap");
    const child = spawn(bwrapPath, [...baseArgs(), "/usr/bin/true"], {
      stdio: "ignore",
      env: { PATH: SAFE_SYSTEM_PATH.join(":") },
    });
    // The first of the three that happens is how it ended (a bwrap that cannot be started gets `error`, then `close`).
    const end = await new Promise<ProbeEnd>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ exitCode: null, signal: "SIGKILL", timedOut: true });
      }, 10_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, signal: null, timedOut: false, error });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal, timedOut: false });
      });
    });
    return { ok: end.exitCode === 0 && end.error === undefined && !end.timedOut, call: ended(end) };
  } catch {
    // The probe failed before it got to run bwrap (the TeX installation could not be looked at): not started, and
    // no system code to say why — the error here is not bwrap's.
    return {
      ok: false,
      call: ended({ exitCode: null, signal: null, timedOut: false, error: new Error("not run") }),
    };
  }
}

/**
 * Probe (asynchronously, never blocking the event loop) whether the bubblewrap boundary really works here. A positive
 * answer is kept; a negative one is retried at most once a minute, so a machine that gains bwrap or user namespaces is
 * picked up without a restart.
 *
 * Every real probe is reported once to each observer that asked while it ran — also to one that joined a probe
 * somebody else started (the cached-answer gate below starts them too). A cached answer is not a probe and is not
 * reported.
 */
export function ensureWriterSandboxProbe(observer?: ExternalObserver): Promise<boolean> {
  if (override !== null) return Promise.resolve(override);
  if (available === true) return Promise.resolve(true);
  if (available === false && Date.now() - probedAt < PROBE_RETRY_MS) return Promise.resolve(false);
  if (inflight === null) {
    const told = new Set<ExternalObserver>();
    watching = told;
    inflight = probe()
      .then(({ ok, call }) => {
        available = ok;
        probedAt = Date.now();
        for (const each of told) reportProgram(each, call);
        return ok;
      })
      .finally(() => {
        inflight = null;
        watching = null;
      });
  }
  if (observer !== undefined) watching?.add(observer);
  return inflight;
}

/**
 * The cached answer, never blocking: false until a probe has said true (so a caller that asks before the first probe
 * finished is conservative). No product code calls it any more (the compile awaits `ensureWriterSandboxProbe`). A stale negative triggers a background re-probe, reported to `observer` like any other.
 */
export function writerSandboxAvailable(observer?: ExternalObserver): boolean {
  if (override !== null) return override;
  if (available !== true) void ensureWriterSandboxProbe(observer);
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
