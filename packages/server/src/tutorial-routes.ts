/**
 * Tutorial progress (in-app-tutorial ticket 18; shapes and answers in contracts `tutorial.ts`): `GET /api/tutorial`
 * and `PUT /api/tutorial`, in both forms and in the desktop app's welcome state.
 *
 * The only file these routes write is `tutorial.json` in the global data directory (infra `tutorial-progress.ts`:
 * whole, atomic, no lock, the last writer wins). They also read, never write, two tutorial markers: the bundled
 * sample's (the folder the server was started with, infra `bundledTutorialDir`) and the one at the root of the bound
 * project, whose folder is looked at for every answer. Nothing of a project's data is read.
 *
 * The log gets the reason category of a file that cannot be used (`tutorial.unreadable`, at each read that finds it)
 * and the error of a failed write (`tutorial.write_failed`, its name and code: no path, no content).
 */

import { statSync } from "node:fs";
import {
  TUTORIAL_PUT_MAX_BYTES,
  type TutorialProgress,
  type TutorialPutRefusal,
  type TutorialState,
} from "@argelanderspace/contracts";
import {
  f,
  readTutorialMarker,
  readTutorialProgress,
  TUTORIAL_PROGRESS_PROBLEMS,
  tutorialProgressOf,
  writeTutorialProgress,
} from "@argelanderspace/infra";
import type { Context } from "hono";
import type { ServerLog } from "./log.js";
import { readLimited } from "./page-errors.js";
import type { ProtectedRoutes } from "./protected-app.js";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface TutorialRouteOptions {
  /** `tutorial.json` in the global data directory, looked up at each request. */
  file: () => string;
  /** The bundled tutorial sample's folder (infra `bundledTutorialDir`); absent or null: this installation has none. */
  sampleDir?: string | null | undefined;
  log: ServerLog;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The answer for `progress`, with the bound folder and both markers looked at now. */
function stateOf(progress: TutorialProgress | null, sampleDir: string | null): TutorialState {
  const bundled = sampleDir === null ? null : readTutorialMarker(sampleDir);
  const path = progress?.project?.path ?? null;
  if (path === null) return { progress, project: null, sample: { bundled, project: null } };
  if (!isFolder(path))
    return { progress, project: { path, state: "missing" }, sample: { bundled, project: null } };
  const n = readTutorialMarker(path);
  return {
    progress,
    project: { path, state: n === null ? "unmarked" : "ready" },
    sample: { bundled, project: n },
  };
}

const DETAILS: Record<Exclude<TutorialPutRefusal, "write_failed">, string> = {
  invalid_request: "the body is not a tutorial progress",
  unknown_version: "this build only reads tutorial progress version 1",
  too_large: `the body is larger than ${TUTORIAL_PUT_MAX_BYTES} bytes`,
};

export function mountTutorialRoutes(routes: ProtectedRoutes, options: TutorialRouteOptions): void {
  const app = routes.withDefaults({ noStore: true });
  const sampleDir = options.sampleDir ?? null;
  const { log } = options;

  // Guarded although a read: the answer carries a path of this machine.
  app.get("/api/tutorial", { guard: true }, (c) => {
    const reading = readTutorialProgress(options.file());
    if (reading.problem !== null)
      log.warn("tutorial.unreadable", {
        reason: f.oneOf(TUTORIAL_PROGRESS_PROBLEMS, reading.problem),
      });
    return c.json(stateOf(reading.progress, sampleDir), 200, NO_STORE);
  });

  app.put("/api/tutorial", async (c: Context) => {
    const refuse = (code: Exclude<TutorialPutRefusal, "write_failed">, status: 400 | 413) =>
      c.json({ code, detail: DETAILS[code] }, status, NO_STORE);
    let body: unknown;
    try {
      const bytes = await readLimited(c, TUTORIAL_PUT_MAX_BYTES);
      if (bytes === null) return refuse("too_large", 413);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return refuse("invalid_request", 400);
    }
    const checked = tutorialProgressOf(body);
    if (!checked.ok)
      return refuse(
        checked.problem === "unknown_version" ? "unknown_version" : "invalid_request",
        400
      );
    try {
      writeTutorialProgress(options.file(), checked.progress);
    } catch (error) {
      log.warn("tutorial.write_failed", { error: f.error(error, { omitSystemPath: true }) });
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return c.json(
        {
          code: "write_failed" satisfies TutorialPutRefusal,
          detail: typeof code === "string" ? code : "UNKNOWN",
        },
        500,
        NO_STORE
      );
    }
    return c.json(stateOf(checked.progress, sampleDir), 200, NO_STORE);
  });
}
