/**
 * Diagnostics (desktop-app ticket 14; shapes in contracts `diagnostics-api.ts`): where the user-level log is, and a
 * diagnostics bundle — a zip made only when the user asks for one, as the answer to that request. Nothing is sent
 * anywhere: there is no upload, telemetry or crash report in the workbench.
 *
 * What a bundle holds:
 *   - `logs/<name>`: every regular file at the top of the log directory (links and directories are not followed). The
 *     log is written to be handed on (contracts「用户日志」): it has no content of the user's;
 *   - `environment-report.json`: the app's version and form, the system and Node, the browser or webview the page
 *     names, the environment check, the config file's values in effect, and the credentials' state. Left out of it:
 *     the contact email, the global directories (data and cache), the secret keys of the file (`openalex_api_key`,
 *     `ads_dev_key`); paths are written as the page shows them, the home directory as `~`, and every other string the
 *     report holds has the home directory replaced as well. A credential is reported by where it is saved, never by
 *     a value;
 *   - only when the user ticks the box, `compile-failures/…`: the compile-failure logs ticket 08 keeps in this
 *     project (`jobs/<job id>.compile.log`, `manuscripts/m_<id>/build/compile-failure.log`), newest first up to
 *     {@link DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES}. They quote the paper's or manuscript's source — which is why the box
 *     is not ticked by default. A file that is still being collected (`.partial`) is never taken.
 *
 * Member names carry no user name: they are fixed words, log file names (time, process kind, pid), job ids (a kind
 * and a random uuid) and manuscript ids (`m_` and eight hex digits).
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTICS_CLIENT_MAX_LENGTH,
  DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES,
  DIAGNOSTICS_EXPORT_BODY_MAX_BYTES,
  type DiagnosticsCompileLog,
  type DiagnosticsInfo,
  type EnvironmentReport,
  JobKindSchema,
  ManuscriptIdSchema,
  type RunningSettings,
  SETTING_KEYS,
  type SettingKey,
} from "@argelanderspace/contracts";
import { ADS_TOKEN_ID, type CredentialStore, f, zipEntries } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { WRITER_FAILURE_LOG_NAME } from "./compile-failure-log.js";
import type { ServerLog, ServerMode } from "./log.js";
import { readLimited } from "./page-errors.js";
import { displayPath, readSettings, shownPath } from "./settings.js";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

const NO_STORE = { "Cache-Control": "no-store" } as const;
const YES_NO = ["yes", "no"] as const;

/** The keys of the config file the environment report leaves out, value and source alike. */
export const DIAGNOSTICS_OMITTED_KEYS = [
  "contact_email",
  "global_dir",
  "global_cache_dir",
  "openalex_api_key",
  "ads_dev_key",
] as const satisfies readonly SettingKey[];

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
  /** What the process uses for the restart-only keys (settings.ts). */
  running: () => RunningSettings;
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

/** The regular files at the top of the log directory, by name. */
export function listLogFiles(logDir: string): Array<{ name: string; path: string; bytes: number }> {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
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
 * within `limit` bytes.
 */
export function listCompileLogs(
  dataDir: string,
  limit = DIAGNOSTICS_COMPILE_LOGS_MAX_BYTES
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
  return found.map(({ name, path, bytes }) => {
    const included = total + bytes <= limit;
    if (included) total += bytes;
    return { name, path, bytes, included };
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

/**
 * Every string of a value with the home directory written as `~` wherever it appears (`displayPath` only looks at the
 * start); a `{path, display}` pair becomes its display. A last pass over the whole report: no field of it is meant to
 * hold the home directory.
 */
export function withoutHome(value: unknown, home: string = homedir()): unknown {
  if (typeof value === "string") {
    const base = home.replace(/[\\/]+$/, "");
    return base.length > 1 ? value.split(base).join("~") : value;
  }
  if (Array.isArray(value)) return value.map((item) => withoutHome(item, home));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 2 && typeof record.path === "string" && typeof record.display === "string")
      return withoutHome(record.display, home);
    return Object.fromEntries(keys.map((key) => [key, withoutHome(record[key], home)]));
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
    // A path value is written as the page shows paths; the secret keys are among the omitted ones.
    values[key] = typeof value === "string" ? displayPath(value) : value;
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
      project_root: running.project_root.display,
      data_dir: running.data_dir.display,
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
  request: { includeCompileLogs: boolean; client: string | null }
): Promise<{ name: string; zip: Buffer }> {
  const at = options.now?.() ?? new Date();
  const report = await environmentReportFile(options, request.client);
  const entries: Array<{ name: string; data: Uint8Array | string }> = [
    { name: "environment-report.json", data: `${JSON.stringify(report, null, 2)}\n` },
  ];
  for (const file of listLogFiles(options.logDir())) {
    try {
      entries.push({ name: `logs/${file.name}`, data: readFileSync(file.path) });
    } catch {
      /* removed meanwhile (another process's cleanup) */
    }
  }
  if (request.includeCompileLogs) {
    for (const file of listCompileLogs(options.dataDir)) {
      if (!file.included) continue;
      try {
        entries.push({ name: file.name, data: readFileSync(file.path) });
      } catch {
        /* removed meanwhile (pruned, or replaced by a render that succeeded) */
      }
    }
  }
  return { name: bundleName(at), zip: zipEntries(entries, at) };
}

/** `{includeCompileLogs?: boolean, client?: string}` and nothing else; null for anything that is not. */
function exportRequestOf(
  body: unknown
): { includeCompileLogs: boolean; client: string | null } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "includeCompileLogs" && key !== "client") return null;
  if (record.includeCompileLogs !== undefined && typeof record.includeCompileLogs !== "boolean")
    return null;
  if (record.client !== undefined && typeof record.client !== "string") return null;
  return {
    includeCompileLogs: record.includeCompileLogs === true,
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
    return c.body(new Uint8Array(bundle.zip), 200, {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.name}"`,
    });
  });
}
