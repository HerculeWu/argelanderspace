// The production license allowlist, in one place: scripts/license-scan.mjs checks the dependency closure in the
// lockfile against it, and the desktop package's license check (packages/app/scripts/desktop-package-lib.mjs) checks
// what is actually shipped against it. Change it here only, and only on a decision (docs/engineering.md).

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
