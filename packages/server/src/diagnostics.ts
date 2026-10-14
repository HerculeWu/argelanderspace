/**
 * Diagnostics (desktop-app ticket 14; shapes in contracts `diagnostics-api.ts`): where the user-level log is, and a
 * diagnostics bundle — a zip made only when the user asks for one, as the answer to that request. Nothing is sent
 * anywhere: there is no upload, telemetry or crash report in the workbench.
 *
 * What a bundle holds:
 *   - `logs/<name>`: the log files at the top of the log directory — regular files whose names are a log file's (infra
 *     `isLogFileName`, the rule the cleanup goes by); anything else there, links and directories are not taken. The
 *     log is written to be handed on (contracts「用户日志」): it has no content of the user's;
 *   - `environment-report.json`: the app's version and form, the system and Node, the browser or webview the page
 *     names, the environment check, the config file's values in effect, and the credentials' state. Left out of it:
 *     the contact email, the global directories (data and cache), every secret key of the schema (`openalex_api_key`,
 *     `ads_dev_key` today); paths are written as the page shows them, and every string of the report has the home
 *     directory, where it is the leading part of a path, written as `~` ({@link withoutHome}). A credential is reported by where it is saved, never by
 *     a value;
 *   - only when the user ticks the box, `compile-failures/…`: of the compile-failure logs ticket 08 keeps in this
 *     project (`jobs/<job id>.compile.log`, `manuscripts/m_<id>/build/compile-failure.log`), those the dialog listed
 *     — the request names them — newest first within {@link DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES} and
 *     {@link DIAGNOSTICS_COMPILE_LOGS_MAX_FILES}. They quote the paper's or manuscript's source — which is why the box
 *     is not ticked by default. A file that is still being collected (`.partial`) is never taken, nor one that
 *     appeared after the dialog listed them.
 *
 * The bundle is compressed on the thread pool (infra `zipEntriesAsync`) and its files are read asynchronously, so the
 * server keeps answering while it is made.
 *
 * Member names carry no user name: they are fixed words, log file names (time, process kind, pid), job ids (a kind
 * and a random uuid) and manuscript ids (`m_` and eight hex digits).
 */

import { lstatSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTICS_CLIENT_MAX_LENGTH,
  DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES,
  DIAGNOSTICS_COMPILE_LOGS_MAX_FILES,
  DIAGNOSTICS_EXPORT_BODY_MAX_BYTES,
  type DiagnosticsCompileLog,
  type DiagnosticsInfo,
  type EnvironmentReport,
  JobKindSchema,
  ManuscriptIdSchema,
  type RunningSettings,
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  type SettingKey,
} from "@argelanderspace/contracts";
import {
  ADS_TOKEN_ID,
  type CredentialStore,
  f,
  isLogFileName,
  zipEntriesAsync,
} from "@argelanderspace/infra";
import type { Hono } from "hono";
import { WRITER_FAILURE_LOG_NAME } from "./compile-failure-log.js";
import type { ServerLog, ServerMode } from "./log.js";
import { readLimited } from "./page-errors.js";
import { readSettings, shownPath } from "./settings.js";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

const NO_STORE = { "Cache-Control": "no-store" } as const;
const YES_NO = ["yes", "no"] as const;

/**
 * The keys of the config file the environment report leaves out, value and source alike: every secret key of the
 * schema (so a secret key added later is left out without a change here), the contact email and the global
 * directories.
 */
export const DIAGNOSTICS_OMITTED_KEYS: readonly SettingKey[] = [
  ...SECRET_SETTING_KEYS,
  "contact_email",
  "global_dir",
  "global_cache_dir",
];

/** What the report says of the running process (the global directories are not in it). */
export interface DiagnosticsRunning {
  project_root: RunningSettings["project_root"];
  data_dir: RunningSettings["data_dir"];
  port: RunningSettings["port"];
  from_flag: RunningSettings["from_flag"];
}

export interface DiagnosticsRouteOptions {
  /** The project data directory (its `jobs/` and `manuscripts/` hold the compile-failure logs). */
  dataDir: string;
  /** The user-level log directory, asked at each request. */
  logDir: () => string;
  /** The config file; default `configFilePath()` (settings.ts `readSettings`). */
  configPath?: string | undefined;
  log: ServerLog;
  version?: string | undefined;
  mode: ServerMode;
  /** Where the process's project and data are, and its port (settings.ts `running`, without the global directories). */
  running: () => DiagnosticsRunning;
  /** The ADS token's store: only its status is asked. */
  adsCredentials: CredentialStore;
  /** The environment check (environment.ts `environmentReport`). */
  environment: () => Promise<EnvironmentReport>;
  now?: () => Date;
}

// --------------------------------------------------------------------------- //
// What is there
// --------------------------------------------------------------------------- //

/** A regular file (not a link) and its size; null for anything else. */
function regularSize(path: string): { bytes: number; mtimeMs: number } | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? { bytes: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The log files at the top of the log directory (regular files named as the log writes them), by name. */
export function listLogFiles(logDir: string): Array<{ name: string; path: string; bytes: number }> {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    if (!isLogFileName(name)) return [];
    const path = join(logDir, name);
    const size = regularSize(path);
    return size === null ? [] : [{ name, path, bytes: size.bytes }];
  });
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A kept ingest log, by name: `<kind>-<uuid>.compile.log` — a collecting `.partial` is not one. */
const INGEST_LOG = new RegExp(`^(?:${JobKindSchema.options.join("|")})-${UUID}\\.compile\\.log$`);

interface CompileLogFile extends DiagnosticsCompileLog {
  path: string;
}

/**
 * The compile-failure logs of the project, newest first; each is included while the ones before it and it stay
 * within `limit` bytes and {@link DIAGNOSTICS_COMPILE_LOGS_MAX_FILES} files. With `only`, the logs whose member names
 * are not in it are left out before the limits are applied: what the dialog listed, as far as it is still there.
 */
export function listCompileLogs(
  dataDir: string,
  limit = DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES,
  only?: ReadonlySet<string>
): CompileLogFile[] {
  const found: Array<{ name: string; path: string; bytes: number; mtimeMs: number }> = [];
  const jobs = join(dataDir, "jobs");
  try {
    for (const name of readdirSync(jobs)) {
      if (!INGEST_LOG.test(name)) continue;
      const path = join(jobs, name);
      const size = regularSize(path);
      if (size) found.push({ name: `compile-failures/jobs/${name}`, path, ...size });
    }
  } catch {
    /* no jobs directory */
  }
  const manuscripts = join(dataDir, "manuscripts");
  try {
    for (const id of readdirSync(manuscripts)) {
      if (!ManuscriptIdSchema.safeParse(id).success) continue;
      const path = join(manuscripts, id, "build", WRITER_FAILURE_LOG_NAME);
      const size = regularSize(path);
      if (size)
        found.push({
          name: `compile-failures/manuscripts/${id}/build/${WRITER_FAILURE_LOG_NAME}`,
          path,
          ...size,
        });
    }
  } catch {
    /* no manuscripts */
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  let total = 0;
  let count = 0;
  // The newest first until the next one would go over: from then on every older one stays out too, so what is left
  // out is always older than what goes in (the dialog says so).
  let full = false;
  return found
    .filter(({ name }) => only === undefined || only.has(name))
    .map(({ name, path, bytes }) => {
      full ||= total + bytes > limit || count >= DIAGNOSTICS_COMPILE_LOGS_MAX_FILES;
      if (!full) {
        total += bytes;
        count += 1;
      }
      return { name, path, bytes, included: !full };
    });
}

export function diagnosticsInfo(
  options: Pick<DiagnosticsRouteOptions, "dataDir" | "logDir">
): DiagnosticsInfo {
  const logDir = options.logDir();
  const logs = listLogFiles(logDir);
  return {
    version: 1,
    logDir: shownPath(logDir),
    logFiles: { count: logs.length, bytes: logs.reduce((sum, file) => sum + file.bytes, 0) },
    compileLogs: listCompileLogs(options.dataDir).map(({ name, bytes, included }) => ({
      name,
      bytes,
      included,
    })),
    compileLogsLimitBytes: DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES,
  };
}

// --------------------------------------------------------------------------- //
// The environment report
// --------------------------------------------------------------------------- //

/** The page's browser identification: printable ASCII (anything else `?`), at most the limit; null when none. */
export function clientIdentification(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, DIAGNOSTICS_CLIENT_MAX_LENGTH);
}

/** Characters a path may go on with after a directory name: what follows the home directory must be none of these. */
const NAME_CHAR = /[^\\/\s"'`:;,()<>[\]{}|]/u;

/**
 * A text with the home directory written as `~` wherever it is the leading part of a path: what follows it must be a
 * separator, the end, or a character no path name goes on with (`/home/x2` and `/home/x.old` are other directories).
 * On Windows the two separators count as one and case does not matter (`C:/Users/Wu/…` and `c:\users\wu\…` are the
 * home `C:\Users\Wu`).
 */
export function replaceHome(
  text: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const windows = platform === "win32";
  // Only ASCII letters are folded: `toLowerCase` can lengthen a string (`İ`), and the cut below needs equal lengths.
  const norm = (t: string) =>
    windows ? t.replaceAll("\\", "/").replace(/[A-Z]/g, (c) => c.toLowerCase()) : t;
  const base = norm(home).replace(/\/+$/, "");
  if (base.length <= 1) return text;
  // Same length either way: the replacement is found on the normalized text and cut from the original.
  const hay = norm(text);
  let out = "";
  let from = 0;
  for (let at = hay.indexOf(base); at >= 0; at = hay.indexOf(base, at + 1)) {
    if (at < from) continue;
    const next = text.charAt(at + base.length);
    if (next !== "" && next !== "/" && !(windows && next === "\\") && NAME_CHAR.test(next))
      continue;
    out += `${text.slice(from, at)}~`;
    from = at + base.length;
  }
  return out + text.slice(from);
}

/**
 * Every string of a value through {@link replaceHome}; a `{path, display}` pair becomes one string, its path written
 * that way. A last pass over the whole report: no field of it is meant to hold the home directory.
 */
export function withoutHome(
  value: unknown,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): unknown {
  if (typeof value === "string") return replaceHome(value, home, platform);
  if (Array.isArray(value)) return value.map((item) => withoutHome(item, home, platform));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 2 && typeof record.path === "string" && typeof record.display === "string")
      return replaceHome(record.path, home, platform);
    return Object.fromEntries(keys.map((key) => [key, withoutHome(record[key], home, platform)]));
  }
  return value;
}

export async function environmentReportFile(
  options: DiagnosticsRouteOptions,
  client: string | null
): Promise<Record<string, unknown>> {
  const reading = readSettings(options.configPath);
  const omitted = new Set<string>(DIAGNOSTICS_OMITTED_KEYS);
  const kept = SETTING_KEYS.filter((key) => !omitted.has(key));
  const values: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const key of kept) {
    const value = reading.values[key];
    // The secret keys are among the omitted ones; a path's home directory is written `~` by the last pass.
    values[key] = value;
    sources[key] = reading.sources[key];
  }
  const running = options.running();
  let adsToken: string;
  try {
    const status = await options.adsCredentials.status(ADS_TOKEN_ID);
    adsToken =
      status.status === "stored"
        ? status.protection
        : status.status === "not-found"
          ? "none"
          : "unreadable";
  } catch {
    adsToken = "unreadable";
  }
  let environment: unknown;
  try {
    environment = await options.environment();
  } catch {
    environment = null;
  }
  return withoutHome({
    version: 1,
    generated_at: (options.now?.() ?? new Date()).toISOString(),
    app: { version: options.version ?? null, mode: options.mode },
    system: { platform: process.platform, arch: process.arch, release: release() },
    node: process.version,
    client,
    environment,
    config: {
      file: reading.file,
      values,
      sources,
      problems: reading.problems,
    },
    running: {
      project_root: running.project_root,
      data_dir: running.data_dir,
      port: running.port,
      from_flag: running.from_flag,
    },
    credentials: { ads_token: adsToken },
  }) as Record<string, unknown>;
}

// --------------------------------------------------------------------------- //
// The bundle
// --------------------------------------------------------------------------- //

const pad = (n: number) => String(n).padStart(2, "0");
/** `argelanderspace-diagnostics-YYYYMMDD-HHMMSS.zip`, in UTC. */
export function bundleName(at: Date): string {
  const d = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const t = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `argelanderspace-diagnostics-${d}-${t}.zip`;
}

export async function buildDiagnosticsBundle(
  options: DiagnosticsRouteOptions,
  request: ExportRequest
): Promise<{ name: string; zip: Buffer }> {
  const at = options.now?.() ?? new Date();
  const report = await environmentReportFile(options, request.client);
  const entries: Array<{ name: string; data: Uint8Array | string }> = [
    { name: "environment-report.json", data: `${JSON.stringify(report, null, 2)}\n` },
  ];
  for (const file of listLogFiles(options.logDir())) {
    try {
      entries.push({ name: `logs/${file.name}`, data: await readFile(file.path) });
    } catch {
      /* removed meanwhile (another process's cleanup) */
    }
  }
  if (request.includeCompileLogs) {
    // Only what the dialog listed and is still a kept log now (any other name matches nothing), within the limits.
    const only = new Set(request.compileLogs);
    for (const file of listCompileLogs(options.dataDir, DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES, only)) {
      if (!file.included) continue;
      try {
        entries.push({ name: file.name, data: await readFile(file.path) });
      } catch {
        /* removed meanwhile (pruned, or replaced by a render that succeeded) */
      }
    }
  }
  return { name: bundleName(at), zip: await zipEntriesAsync(entries, at) };
}

interface ExportRequest {
  includeCompileLogs: boolean;
  /** The member names the dialog listed (empty when not ticked). */
  compileLogs: string[];
  client: string | null;
}

/**
 * `{includeCompileLogs?: boolean, compileLogs?: string[], client?: string}` and nothing else; null for anything that is
 * not. Ticked without a list is not a request: the server never chooses the compile logs itself, so a bundle takes
 * only what the user was shown.
 */
function exportRequestOf(body: unknown): ExportRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "includeCompileLogs" && key !== "compileLogs" && key !== "client") return null;
  if (record.includeCompileLogs !== undefined && typeof record.includeCompileLogs !== "boolean")
    return null;
  if (record.client !== undefined && typeof record.client !== "string") return null;
  const list = record.compileLogs;
  if (
    list !== undefined &&
    (!Array.isArray(list) ||
      list.length > DIAGNOSTICS_COMPILE_LOGS_MAX_FILES ||
      !list.every((name) => typeof name === "string"))
  )
    return null;
  const includeCompileLogs = record.includeCompileLogs === true;
  if (includeCompileLogs && list === undefined) return null;
  return {
    includeCompileLogs,
    compileLogs: includeCompileLogs ? (list as string[]) : [],
    client: clientIdentification(record.client),
  };
}

export function mountDiagnosticsRoutes(
  app: Hono,
  guardCsrf: Guard,
  options: DiagnosticsRouteOptions
): void {
  app.get("/api/diagnostics", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    return c.json(diagnosticsInfo(options), 200, NO_STORE);
  });

  app.post("/api/diagnostics/export", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    let body: unknown;
    try {
      const bytes = await readLimited(c, DIAGNOSTICS_EXPORT_BODY_MAX_BYTES);
      if (bytes === null) return c.json({ detail: "invalid request" }, 400, NO_STORE);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return c.json({ detail: "invalid request" }, 400, NO_STORE);
    }
    const request = exportRequestOf(body);
    if (request === null) return c.json({ detail: "invalid request" }, 400, NO_STORE);
    // Recorded first, so the bundle's own log has it: the event and whether compile logs were asked for, nothing else.
    options.log.info("diagnostics.exported", {
      compile_logs: f.oneOf(YES_NO, request.includeCompileLogs ? "yes" : "no"),
    });
    const bundle = await buildDiagnosticsBundle(options, request);
    // The Buffer itself (no copy): `Buffer.concat` allocates an ordinary ArrayBuffer, never a shared one.
    return c.body(bundle.zip as Uint8Array<ArrayBuffer>, 200, {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.name}"`,
    });
  });
}
