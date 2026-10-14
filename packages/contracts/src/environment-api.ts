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

export interface EnvironmentReport {
  version: 1;
  /** The platform the lookup used (anything but macOS and Windows is looked up like Linux). */
  platform: (typeof ENVIRONMENT_PLATFORMS)[number];
  texDir: { state: TexDirState; path: ShownPath | null };
  tools: EnvironmentToolStatus[];
  keychain: { state: KeychainState; reason: KeychainReason };
  /** Whether the Writer's compile sandbox works (bubblewrap runs): without it the Copilot never causes a compile. */
  sandbox: "available" | "unavailable";
}

/** Whether `value` is a report this version of the page can show. */
export function isEnvironmentReport(value: unknown): value is EnvironmentReport {
  const v = value as Partial<EnvironmentReport> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    Array.isArray(v.tools) &&
    v.tools.every(
      (t) =>
        (ENVIRONMENT_TOOLS as readonly unknown[]).includes(t?.tool) &&
        typeof t.found === "boolean" &&
        Array.isArray(t.affects)
    ) &&
    (TEX_DIR_STATES as readonly unknown[]).includes(v.texDir?.state) &&
    (KEYCHAIN_STATES as readonly unknown[]).includes(v.keychain?.state) &&
    (v.sandbox === "available" || v.sandbox === "unavailable")
  );
}
