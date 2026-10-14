/**
 * The environment check (desktop-app ticket 13): where each external program is, its version line, and whether the
 * OS keychain can be used — without ever asking the keychain for anything.
 *
 * **The keychain probe never touches the keychain.** On Linux the keychain is the Secret Service on the D-Bus session
 * bus. Asking it anything about a collection or an item (even reading one, which `@napi-rs/keyring` does) can make the
 * keyring daemon show an unlock prompt. So the probe only asks the *bus daemon* (`org.freedesktop.DBus`, not the
 * keyring) two questions that never reach the Secret Service: `NameHasOwner("org.freedesktop.secrets")` — is a Secret
 * Service running? — and, when not, `ListActivatableNames` — would the bus start one on first use? Neither activates a
 * service, opens a session, reads a collection or an item, or can prompt. It runs `dbus-send` with an environment that
 * holds only PATH and the bus address (no DISPLAY: nothing it starts could show a window), with a time limit.
 *
 * What the answer does not say (limits): "available" means that a Secret Service is there (or can be started), not that
 * it is unlocked — the first real use may still show the daemon's unlock prompt, as it always did; a service that is
 * there but broken is reported available. Without `dbus-send` on the machine the answer is `unknown`. macOS (Keychain)
 * and Windows (Credential Manager) always have their keychain: they are reported available without a probe — assumed,
 * not checked on a real machine. The native module of `@napi-rs/keyring` failing to load makes the keychain
 * unavailable for the credential store, so it is checked too (loading it does not touch any keychain).
 *
 * **Version lines** are the first non-empty line a program prints for a fixed version option (never an argument from
 * the user or the config), with control characters removed and at most {@link VERSION_LINE_MAX} characters; a program
 * that does not answer within {@link VERSION_TIMEOUT_MS} has none. A Windows batch file (`.bat` / `.cmd`) is not run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { KeychainReason, KeychainState } from "@argelanderspace/contracts";
import {
  currentToolchain,
  type LocatedTool,
  type Toolchain,
  type ToolchainTool,
  texChildEnv,
} from "./tex/toolchain.js";

export const VERSION_LINE_MAX = 160;
export const VERSION_TIMEOUT_MS = 10_000;
export const KEYCHAIN_PROBE_TIMEOUT_MS = 3_000;

/** The answer of the probe: contracts' `KeychainState` and `KeychainReason` (see there for each reason). */
export interface KeychainProbe {
  state: KeychainState;
  reason: KeychainReason;
}

/** One run of `dbus-send`: its standard output, or how it failed. */
export type DbusSend = (
  args: readonly string[],
  env: Record<string, string>
) => Promise<{ ok: true; stdout: string } | { ok: false; missing: boolean }>;

function runCapture(
  cmd: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; missing: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (
      value: { ok: true; stdout: string; stderr: string } | { ok: false; missing: boolean }
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ ok: false, missing: false });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const keep = (into: Buffer[]) => (d: Buffer) => {
      // A version line is short: 64 KiB of output is plenty, the rest is not kept.
      if (size < 65_536) into.push(d);
      size += d.length;
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, missing: false });
    }, timeoutMs);
    child.on("error", (e) =>
      finish({ ok: false, missing: (e as NodeJS.ErrnoException).code === "ENOENT" })
    );
    // Whatever the exit code: some programs print their version and exit non-zero.
    child.on("close", () =>
      finish({
        ok: true,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      })
    );
  });
}

/** `dbus-send` as the probe runs it: only the bus daemon is asked, with a short limit. */
export const defaultDbusSend: DbusSend = async (args, env) => {
  const r = await new Promise<
    { ok: true; stdout: string; code: number | null } | { ok: false; missing: boolean }
  >((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("dbus-send", [...args], { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ ok: false, missing: false });
      return;
    }
    const out: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), KEYCHAIN_PROBE_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: (e as NodeJS.ErrnoException).code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: true, stdout: Buffer.concat(out).toString("utf8"), code });
    });
  });
  if (!r.ok) return r;
  return r.code === 0 ? { ok: true, stdout: r.stdout } : { ok: false, missing: false };
};

export interface KeychainProbeOptions {
  platform?: NodeJS.Platform;
  /** Where the bus address comes from: `DBUS_SESSION_BUS_ADDRESS`, else `$XDG_RUNTIME_DIR/bus`; default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  dbusSend?: DbusSend;
  /** Whether the keyring's native module loads (default: it is imported, which touches no keychain). */
  moduleLoads?: () => Promise<boolean>;
}

const defaultModuleLoads = async (): Promise<boolean> => {
  try {
    await import("@napi-rs/keyring");
    return true;
  } catch {
    return false;
  }
};

/** The session bus to ask, or null: never the one a library would guess or start (no autolaunch). */
function sessionBus(env: Readonly<Record<string, string | undefined>>): string | null {
  const given = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  if (given) return given;
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime && posix.isAbsolute(runtime) && existsSync(posix.join(runtime, "bus"))) {
    return `unix:path=${posix.join(runtime, "bus")}`;
  }
  return null;
}

const BUS_ARGS = [
  "--session",
  "--print-reply=literal",
  "--reply-timeout=2000",
  "--dest=org.freedesktop.DBus",
  "/org/freedesktop/DBus",
];

/**
 * Whether the OS keychain can be used, asked without prompting and without reading or writing anything in it (see the
 * file comment for how, and what the answer does not say). Never throws.
 */
export async function probeKeychain(opts: KeychainProbeOptions = {}): Promise<KeychainProbe> {
  try {
    const platform = opts.platform ?? process.platform;
    if (!(await (opts.moduleLoads ?? defaultModuleLoads)()))
      return { state: "unavailable", reason: "no_module" };
    if (platform === "darwin" || platform === "win32")
      return { state: "available", reason: "platform" };
    const env = opts.env ?? process.env;
    const bus = sessionBus(env);
    if (bus === null) return { state: "unavailable", reason: "no_bus" };
    const send = opts.dbusSend ?? defaultDbusSend;
    // dbus-send is a system program: looked for in the system's directories, whatever PATH the workbench got.
    const childEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: bus };
    const owner = await send(
      [...BUS_ARGS, "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"],
      childEnv
    );
    if (!owner.ok)
      return owner.missing
        ? { state: "unknown", reason: "no_probe" }
        : { state: "unavailable", reason: "no_bus" };
    if (/\btrue\b/.test(owner.stdout)) return { state: "available", reason: "secret_service" };
    const names = await send([...BUS_ARGS, "org.freedesktop.DBus.ListActivatableNames"], childEnv);
    if (names.ok && /(^|[\s"])org\.freedesktop\.secrets([\s"]|$)/.test(names.stdout)) {
      return { state: "available", reason: "activatable" };
    }
    return { state: "unavailable", reason: "no_service" };
  } catch {
    return { state: "unknown", reason: "no_probe" };
  }
}

/** The fixed option each program prints its version for. */
const VERSION_ARGS: Record<ToolchainTool, readonly string[]> = {
  latexmk: ["-v"],
  pdflatex: ["--version"],
  xelatex: ["--version"],
  bibtex: ["--version"],
  biber: ["--version"],
  pdftocairo: ["-v"],
  ghostscript: ["--version"],
  bwrap: ["--version"],
};

/** The first non-empty line of `text`, without control characters, cut to {@link VERSION_LINE_MAX}. */
export function versionLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    const line = raw.replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g, " ").trim();
    if (line === "") continue;
    return line.length > VERSION_LINE_MAX ? `${line.slice(0, VERSION_LINE_MAX - 1)}…` : line;
  }
  return null;
}

/** The version line of one located program, or null (no answer, a batch file, nothing printed). */
export async function toolVersion(
  tool: ToolchainTool,
  located: LocatedTool,
  env: Record<string, string>
): Promise<string | null> {
  if (/\.(bat|cmd)$/i.test(located.path)) return null;
  const r = await runCapture(located.path, VERSION_ARGS[tool], env, VERSION_TIMEOUT_MS);
  if (!r.ok) return null;
  // ghostscript prints only the number; pdftocairo writes to standard error.
  const line = versionLine(r.stdout) ?? versionLine(r.stderr);
  if (line === null) return null;
  return tool === "ghostscript" && /^\d/.test(line) ? `Ghostscript ${line}` : line;
}

export interface ToolReport {
  tool: ToolchainTool;
  located: LocatedTool | null;
  version: string | null;
}

export interface EnvironmentCheck {
  toolchain: Toolchain;
  tools: ToolReport[];
  keychain: KeychainProbe;
}

export interface EnvironmentCheckOptions {
  /** Where the programs are; default: looked up now with the TeX directory config.toml sets now. */
  toolchain?: Toolchain;
  /** Whether version lines are asked for (the start record does not need them). Default true. */
  versions?: boolean;
  keychain?: () => Promise<KeychainProbe>;
}

/** Every program and the keychain, checked now. Never throws. */
export async function checkEnvironment(
  opts: EnvironmentCheckOptions = {}
): Promise<EnvironmentCheck> {
  const toolchain = opts.toolchain ?? currentToolchain();
  const env = texChildEnv(toolchain);
  const [tools, keychain] = await Promise.all([
    Promise.all(
      (Object.keys(toolchain.tools) as ToolchainTool[]).map(async (tool) => {
        const located = toolchain.tools[tool];
        const version =
          located !== null && opts.versions !== false
            ? await toolVersion(tool, located, env).catch(() => null)
            : null;
        return { tool, located, version };
      })
    ),
    (opts.keychain ?? (() => probeKeychain()))().catch(
      (): KeychainProbe => ({ state: "unknown", reason: "no_probe" })
    ),
  ]);
  return { toolchain, tools, keychain };
}
