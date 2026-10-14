/**
 * Diagnostics (desktop-app ticket 14): where the user-level log is, and a diagnostics bundle made only when the user
 * asks for one.
 *
 * - `GET  /api/diagnostics`         → {@link DiagnosticsInfo}: the log directory, what is in it, and the compile-failure
 *                                     logs that would go into a bundle if the user ticks the box.
 * - `POST /api/diagnostics/export`  {@link DiagnosticsExportRequest} → a zip (`application/zip`, an attachment). It
 *                                     holds the log files of the log directory, `environment-report.json`, and — only
 *                                     when asked — the compile-failure logs the dialog listed, by name.
 *
 * Nothing is ever sent anywhere: the zip is the answer to the page's request, and the page hands it to the browser's
 * (or the desktop host's) save. Both answers are `no-store`.
 */

import type { ShownPath } from "./settings-api.js";

/** The most bytes of compile-failure logs a bundle takes: the newest first, until the next one would go over. */
export const DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES = 32 * 1024 * 1024;
/**
 * The most compile-failure logs a bundle takes (newest first). With {@link DIAGNOSTICS_CLIENT_MAX_LENGTH}, it keeps the
 * longest request the page can send within {@link DIAGNOSTICS_EXPORT_BODY_MAX_BYTES}.
 */
export const DIAGNOSTICS_COMPILE_LOGS_MAX_FILES = 40;
/** The longest browser or webview identification the page may hand in; longer is cut (the page cuts it too). */
export const DIAGNOSTICS_CLIENT_MAX_LENGTH = 512;
/** The largest export request body. */
export const DIAGNOSTICS_EXPORT_BODY_MAX_BYTES = 4096;

/** A kept compile-failure log, as it would be named inside the bundle. */
export interface DiagnosticsCompileLog {
  /** The member name in the zip: `compile-failures/jobs/<job id>.compile.log` or `compile-failures/manuscripts/m_<id>/build/compile-failure.log`. */
  name: string;
  bytes: number;
  /**
   * False when taking it would put the logs over {@link DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES} or their number over
   * {@link DIAGNOSTICS_COMPILE_LOGS_MAX_FILES}.
   */
  included: boolean;
}

export interface DiagnosticsInfo {
  version: 1;
  /** The user-level log directory (global data, `logs/`); `display` has the home directory written as `~`. */
  logDir: ShownPath;
  /** The log files of the log directory now (named as the log writes them; nothing else): how many, their size together. */
  logFiles: { count: number; bytes: number };
  /** The compile-failure logs of this project, newest first; empty when there are none. */
  compileLogs: DiagnosticsCompileLog[];
  compileLogsLimitBytes: number;
}

export interface DiagnosticsExportRequest {
  /** Put compile-failure logs into the bundle. Default false. When true, `compileLogs` is required. */
  includeCompileLogs?: boolean;
  /**
   * The member names the dialog listed as going in (`DiagnosticsCompileLog.name` with `included`), at most
   * {@link DIAGNOSTICS_COMPILE_LOGS_MAX_FILES}. The server takes only those of them that are still kept compile-failure
   * logs, within the limits; a name of anything else is ignored. A log that appeared after the listing is not taken.
   */
  compileLogs?: string[];
  /** The browser's or webview's identification (`navigator.userAgent`), for the environment report. */
  client?: string;
}

export function isDiagnosticsInfo(value: unknown): value is DiagnosticsInfo {
  const v = value as Partial<DiagnosticsInfo> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    typeof v.logDir === "object" &&
    v.logDir !== null &&
    typeof v.logDir.path === "string" &&
    typeof v.logDir.display === "string" &&
    typeof v.logFiles === "object" &&
    v.logFiles !== null &&
    typeof v.logFiles.count === "number" &&
    typeof v.logFiles.bytes === "number" &&
    Array.isArray(v.compileLogs) &&
    v.compileLogs.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof c.name === "string" &&
        typeof c.bytes === "number" &&
        typeof c.included === "boolean"
    ) &&
    typeof v.compileLogsLimitBytes === "number"
  );
}
