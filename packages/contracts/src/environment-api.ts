/**
 * The environment check (desktop-app ticket 13): `GET /api/environment` → {@link EnvironmentReport}, answered
 * `no-store`. Each request checks again (the page's "check again" is another GET): where each external program is and
 * from which step of the lookup — the configured TeX directory, PATH, the usual install locations of the platform — its
 * version line, and what is unavailable without it; whether the OS keychain can be used (asked without prompting and
 * without reading anything in it); whether the Writer's compile sandbox works here.
 *
 * Paths name the user's directories: they are in this answer only, never in the user-level log.
 */

import type { ShownPath } from "./settings-api.js";

/** The programs the check reports, in its order. */
export const ENVIRONMENT_TOOLS = [
  "latexmk",
  "pdflatex",
  "xelatex",
  "bibtex",
  "biber",
  "pdftocairo",
  "ghostscript",
  "bwrap",
] as const;
export type EnvironmentTool = (typeof ENVIRONMENT_TOOLS)[number];

/** Which step of the lookup found a program: the configured TeX directory, PATH, the usual install locations. */
export const TOOL_SOURCES = ["tex_dir", "path", "common"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

/** What the workbench cannot do without a program. */
export const ENVIRONMENT_FEATURES = [
  "latex_ingest",
  "writer_render",
  "pdflatex",
  "xelatex",
  "bibtex",
  "biber",
  "figures",
  "eps_figures",
  "copilot_compile",
] as const;
export type EnvironmentFeature = (typeof ENVIRONMENT_FEATURES)[number];

/**
 * What each program is needed for. latexmk runs every compile (ingest and Writer); without pdflatex the compile is
 * tried with xelatex only, and the other way round; bibtex and biber process bibliographies (biber is never run by the
 * Writer); pdftocairo converts the PDF and EPS figures of an ingest (without it they are left out), ghostscript the EPS
 * ones; bubblewrap is the Writer's compile sandbox, without which the Copilot never causes a compile.
 */
export const TOOL_FEATURES: Readonly<Record<EnvironmentTool, readonly EnvironmentFeature[]>> = {
  latexmk: ["latex_ingest", "writer_render"],
  pdflatex: ["pdflatex"],
  xelatex: ["xelatex"],
  bibtex: ["bibtex"],
  biber: ["biber"],
  pdftocairo: ["figures"],
  ghostscript: ["eps_figures"],
  bwrap: ["copilot_compile"],
};

export interface EnvironmentToolStatus {
  tool: EnvironmentTool;
  found: boolean;
  /** Null when not found. */
  source: ToolSource | null;
  path: ShownPath | null;
  /** The first line the program printed for its version option (bounded, control characters removed); may be null. */
  version: string | null;
  /** What is unavailable because the program is missing: {@link TOOL_FEATURES} when not found, empty when found. */
  affects: EnvironmentFeature[];
}

/** The configured TeX directory (`tex_dir`): not set, has latexmk, does not exist, has no latexmk, not absolute. */
export const TEX_DIR_STATES = ["unset", "ok", "missing", "no_latexmk", "not_absolute"] as const;
export type TexDirState = (typeof TEX_DIR_STATES)[number];

export const KEYCHAIN_STATES = ["available", "unavailable", "unknown"] as const;
export type KeychainState = (typeof KEYCHAIN_STATES)[number];
/**
 * Why: a Secret Service runs on the session bus / the bus would start one / macOS or Windows (assumed, not probed) /
 * no session bus / no Secret Service on it / the keyring module does not load / could not ask.
 */
export const KEYCHAIN_REASONS = [
  "secret_service",
  "activatable",
  "platform",
  "no_bus",
  "no_service",
  "no_module",
  "no_probe",
] as const;
export type KeychainReason = (typeof KEYCHAIN_REASONS)[number];

export const ENVIRONMENT_PLATFORMS = ["linux", "darwin", "win32"] as const;

/**
 * Whether the Writer's compile sandbox sees the TeX the workbench found (ticket 13 revision; user decision 2026-10-14:
 * the sandbox is not changed, the check says so). The sandbox has its own PATH — the system directories and the TeX
 * directories it found on the server's PATH — so a TeX only in the configured TeX directory is not there: `not_found`
 * (Writer rendering fails in the sandbox; it never falls back to compiling outside it), or `different` when the system
 * directories hold another TeX, which the sandbox then uses (`path`). `same`; `not_applicable` without a sandbox or
 * without latexmk.
 */
export const SANDBOX_TEX_STATES = ["same", "different", "not_found", "not_applicable"] as const;
export type SandboxTexState = (typeof SANDBOX_TEX_STATES)[number];

/**
 * Whether the directory of the latexmk found would reach the sandbox through the PATH the workbench starts with:
 * `bindable` (it would: putting it on that PATH and restarting helps), `under_usr` (a directory under /usr that is not a
 * system directory, such as TeX Live's own /usr/local/texlive/<year>/bin/<arch>: bound with /usr but never on the
 * sandbox's PATH), `not_bindable` (the home directory, /tmp, /var, /mnt and other places the sandbox never binds).
 */
export const SANDBOX_REACHES = ["bindable", "under_usr", "not_bindable"] as const;
export type SandboxReach = (typeof SANDBOX_REACHES)[number];

export interface EnvironmentReport {
  version: 1;
  /** The platform the lookup used (anything but macOS and Windows is looked up like Linux). */
  platform: (typeof ENVIRONMENT_PLATFORMS)[number];
  texDir: { state: TexDirState; path: ShownPath | null };
  tools: EnvironmentToolStatus[];
  keychain: { state: KeychainState; reason: KeychainReason };
  /** Whether the Writer's compile sandbox works (bubblewrap runs): without it the Copilot never causes a compile. */
  sandbox: "available" | "unavailable";
  /** Which latexmk the sandbox would run, compared with the one found ({@link SANDBOX_TEX_STATES}). */
  writerSandboxTex: {
    state: SandboxTexState;
    /** The latexmk the sandbox would run (`same` / `different`). */
    path: ShownPath | null;
    /** Whether the latexmk the workbench found came from the configured TeX directory. */
    fromTexDir: boolean;
    /** With `different` / `not_found`: whether that latexmk's directory could reach the sandbox; null otherwise. */
    reach: SandboxReach | null;
  };
}

const oneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);
const isShownPath = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { display?: unknown }).display === "string");

/** Whether `value` is a report this version of the page can show: every field of the shape, every enum a known value. */
export function isEnvironmentReport(value: unknown): value is EnvironmentReport {
  const v = value as Partial<EnvironmentReport> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    oneOf(ENVIRONMENT_PLATFORMS, v.platform) &&
    Array.isArray(v.tools) &&
    v.tools.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        oneOf(ENVIRONMENT_TOOLS, t.tool) &&
        typeof t.found === "boolean" &&
        (t.source === null || oneOf(TOOL_SOURCES, t.source)) &&
        isShownPath(t.path) &&
        (t.version === null || typeof t.version === "string") &&
        Array.isArray(t.affects) &&
        t.affects.every((feature) => oneOf(ENVIRONMENT_FEATURES, feature))
    ) &&
    oneOf(TEX_DIR_STATES, v.texDir?.state) &&
    isShownPath(v.texDir?.path ?? null) &&
    oneOf(KEYCHAIN_STATES, v.keychain?.state) &&
    oneOf(KEYCHAIN_REASONS, v.keychain?.reason) &&
    (v.sandbox === "available" || v.sandbox === "unavailable") &&
    oneOf(SANDBOX_TEX_STATES, v.writerSandboxTex?.state) &&
    isShownPath(v.writerSandboxTex?.path ?? null) &&
    typeof v.writerSandboxTex?.fromTexDir === "boolean" &&
    (v.writerSandboxTex?.reach === null || oneOf(SANDBOX_REACHES, v.writerSandboxTex?.reach))
  );
}
