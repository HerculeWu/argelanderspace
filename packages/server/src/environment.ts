/**
 * The environment check over HTTP (desktop-app ticket 13): `GET /api/environment` → contracts `EnvironmentReport`,
 * `no-store`, behind the same origin guard as the other endpoints. Every request checks again — the TeX directory is
 * read from config.toml then, so a changed `tex_dir` is in the next answer without a restart — and requests that arrive
 * while a check runs share it.
 *
 * The answer names paths (the TeX directory, where each program is): they contain the user's name and folders, and go
 * nowhere else — the start record (log-observers.ts `logEnvironment`) writes paths by the log's rules only.
 */
import {
  type EnvironmentReport,
  type EnvironmentToolStatus,
  TOOL_FEATURES,
} from "@argelanderspace/contracts";
import {
  checkEnvironment,
  configFilePath,
  configuredTexDir,
  type ExternalObserver,
  ensureWriterSandboxProbe,
  type KeychainProbe,
  locateToolchain,
} from "@argelanderspace/infra";
import type { Hono } from "hono";
import { shownPath } from "./settings.js";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

export interface EnvironmentRouteOptions {
  /** The config file the TeX directory is read from, at each check; default `configFilePath()`. */
  configPath?: string | undefined;
  /** Whether the OS keychain can be used; default the probe that asks only the bus daemon (infra `probeKeychain`). */
  keychain?: (() => Promise<KeychainProbe>) | undefined;
  /** Told of the sandbox probe when one runs (lib/observe.ts). */
  observer?: ExternalObserver | undefined;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The environment as the page sees it, checked now. Never throws. */
export async function environmentReport(
  options: EnvironmentRouteOptions = {}
): Promise<EnvironmentReport> {
  const texDir = configuredTexDir(options.configPath ?? configFilePath());
  const toolchain = locateToolchain({ texDir });
  const [check, sandbox] = await Promise.all([
    checkEnvironment({ toolchain, ...(options.keychain ? { keychain: options.keychain } : {}) }),
    ensureWriterSandboxProbe(options.observer).catch(() => false),
  ]);
  const tools: EnvironmentToolStatus[] = check.tools.map(({ tool, located, version }) => ({
    tool,
    found: located !== null,
    source: located?.source ?? null,
    path: located === null ? null : shownPath(located.path),
    version,
    affects: located === null ? [...TOOL_FEATURES[tool]] : [],
  }));
  return {
    version: 1,
    platform: toolchain.platform,
    texDir: { state: toolchain.texDirState, path: texDir === null ? null : shownPath(texDir) },
    tools,
    keychain: { state: check.keychain.state, reason: check.keychain.reason },
    sandbox: sandbox ? "available" : "unavailable",
  };
}

export function mountEnvironmentRoutes(
  app: Hono,
  guardCsrf: Guard,
  options: EnvironmentRouteOptions = {}
): void {
  let inflight: Promise<EnvironmentReport> | null = null;
  app.get("/api/environment", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    inflight ??= environmentReport(options).finally(() => {
      inflight = null;
    });
    return c.json(await inflight, 200, NO_STORE);
  });
}
