/**
 * The environment check over HTTP (desktop-app ticket 13): `GET /api/environment` → contracts `EnvironmentReport`,
 * `no-store`, behind the same origin guard as the other endpoints. Every request checks again — the TeX directory is
 * read from config.toml then, so a changed `tex_dir` is in the next answer without a restart. A request shares a check
 * already running only when that check was started with the same TeX directory (the one config.toml sets when the
 * request arrives); otherwise it starts its own, so an answer never describes a TeX directory that was already replaced.
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
  type SandboxViewOptions,
  sandboxTexState,
} from "@argelanderspace/infra";
import type { ProtectedRoutes } from "./protected-app.js";
import { shownPath } from "./settings.js";

export interface EnvironmentRouteOptions {
  /** The config file the TeX directory is read from, at each check; default `configFilePath()`. */
  configPath?: string | undefined;
  /** Whether the OS keychain can be used; default the probe that asks only the bus daemon (infra `probeKeychain`). */
  keychain?: (() => Promise<KeychainProbe>) | undefined;
  /** Told of the sandbox probe when one runs (lib/observe.ts). */
  observer?: ExternalObserver | undefined;
  /** Tests only: where the sandbox's latexmk is looked for (infra `sandbox-view.ts`). */
  sandboxView?: SandboxViewOptions | undefined;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The environment as the page sees it, checked now. Never throws. */
export async function environmentReport(
  options: EnvironmentRouteOptions = {},
  texDir: string | null = configuredTexDir(options.configPath ?? configFilePath())
): Promise<EnvironmentReport> {
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
    writerSandboxTex: (() => {
      const view = sandboxTexState(
        toolchain.tools.latexmk?.path ?? null,
        sandbox,
        options.sandboxView
      );
      return {
        state: view.state,
        path: view.latexmk === null ? null : shownPath(view.latexmk),
        fromTexDir: toolchain.tools.latexmk?.source === "tex_dir",
        reach: view.reach,
      };
    })(),
  };
}

export function mountEnvironmentRoutes(
  routes: ProtectedRoutes,
  options: EnvironmentRouteOptions = {}
): void {
  const app = routes.withDefaults({ noStore: true });
  // Checks running now, by the TeX directory they were started with (`null` = not set).
  const inflight = new Map<string | null, Promise<EnvironmentReport>>();
  app.get("/api/environment", { guard: true }, async (c) => {
    const texDir = configuredTexDir(options.configPath ?? configFilePath());
    let running = inflight.get(texDir);
    if (running === undefined) {
      running = environmentReport(options, texDir).finally(() => {
        inflight.delete(texDir);
      });
      inflight.set(texDir, running);
    }
    return c.json(await running, 200, NO_STORE);
  });
}
