// The production license allowlist, in one place: scripts/license-scan.mjs checks the dependency closure in the
// lockfile against it, and the desktop package's license check (packages/app/scripts/desktop-package-lib.mjs) checks
// what is actually shipped against it; the desktop shell's Rust crates (shell-notices.mjs) are checked against it plus
// the crate-only additions at the end. Change it here only, and only on a decision (docs/engineering.md).

/** The licenses that occur in the shipped closure and are acceptable (SPDX ids). */
export const PROD_LICENSE_ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "OFL-1.1", // fonts (embedpdf)
]);

/** `X WITH exception` is unknown unless the whole phrase is listed here. */
export const WITH_LICENSE_ALLOWED = new Set([]);

/**
 * The Rust crates linked into the desktop shell (packages/app/scripts/shell-notices.mjs) accept these besides the list
 * above: the user's decision of 2026-10-15 in desktop-app ticket 26 ("Rust crate licenses: accept all"). Unicode-3.0
 * (ICU4X), Zlib (foldhash, zlib-rs) and MPL-2.0 (Servo's cssparser and selectors, dtoa-short, option-ext). For the
 * crates only, not for the npm closure that the list above guards: the decision was about the shell's crates, and
 * MPL-2.0 asks a binary to say where the covered source is, which only the crate notice does (it names each MPL crate's
 * crates.io release and repository commit). An npm package under one of these needs a decision of its own.
 */
export const SHELL_CRATE_LICENSE_ALLOWED = new Set([
  ...PROD_LICENSE_ALLOWED,
  "Unicode-3.0",
  "Zlib",
  "MPL-2.0",
]);
