/**
 * Project intake, the entry's one server fact (project-intake ticket 06): `GET /api/intake` reports whether the Project
 * root holds `argelanderspace-intake.md` (existence only, the content is never read), `unknown` when the root cannot
 * be looked at, and the watcher fires when it appears or goes. Throwaway folders only.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTAKE_CHECKLIST_FILE } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { intakeChecklistState } from "../src/intake-state.js";
import { JobRunner } from "../src/jobs.js";
import { createServer } from "../src/server.js";
import { startWatcher, type Watcher } from "../src/watch.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const roots: string[] = [];
const watchers: Watcher[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "aspace-intake-"));
  roots.push(root);
  return root;
}

describe("intakeChecklistState", () => {
  test("absent / present, by existence alone (an empty file is present)", () => {
    const root = project();
    expect(intakeChecklistState(root)).toBe("absent");
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "");
    expect(intakeChecklistState(root)).toBe("present");
  });

  test("a link to the checklist is present; a dangling one is too (it names a file)", () => {
    const root = project();
    symlinkSync(join(root, "elsewhere.md"), join(root, INTAKE_CHECKLIST_FILE));
    expect(intakeChecklistState(root)).toBe("present");
  });

  test("a folder by that name is not a checklist and not a clean no: unknown", () => {
    const root = project();
    mkdirSync(join(root, INTAKE_CHECKLIST_FILE));
    expect(intakeChecklistState(root)).toBe("unknown");
  });

  test("a root that cannot be looked at is unknown, not absent", () => {
    const root = project();
    // the root is a file: lstat of a path below it fails with ENOTDIR, not ENOENT
    writeFileSync(join(root, "not-a-folder"), "x");
    expect(intakeChecklistState(join(root, "not-a-folder"))).toBe("unknown");
  });

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable root (no search permission) is unknown",
    () => {
      const root = project();
      const inner = join(root, "inner");
      mkdirSync(inner);
      writeFileSync(join(inner, INTAKE_CHECKLIST_FILE), "x");
      chmodSync(inner, 0o000);
      expect(intakeChecklistState(inner)).toBe("unknown");
      chmodSync(inner, 0o700);
    }
  );
});

describe("the tutorial Project", () => {
  test("the bundled sample holds no checklist, and its Library is not empty: the entry shows neither there", () => {
    const sample = join(import.meta.dirname, "..", "..", "..", "tutorial-sample");
    expect(intakeChecklistState(sample)).toBe("absent");
    const library = JSON.parse(
      readFileSync(join(sample, "literatures", "library", "library.json"), "utf8")
    );
    expect(library.works.length).toBeGreaterThan(0);
  });
});

describe("GET /api/intake", () => {
  function boot(projectRoot: string) {
    const dataDir = makeDataDir();
    roots.push(dataDir);
    return createApp({
      paths: libraryPaths(dataDir),
      statusDir: join(dataDir, "..", "status"),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "..", "jobs") }),
      projectRoot,
      broadcast: () => {},
    });
  }

  test("reports the three states, uncached, as one field", async () => {
    const root = project();
    const app = boot(root);
    const ask = async () => {
      const response = await app.request("/api/intake");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json();
    };
    expect(await ask()).toEqual({ checklist: "absent" });
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "- 状态：进行中\n");
    expect(await ask()).toEqual({ checklist: "present" });
    rmSync(join(root, INTAKE_CHECKLIST_FILE));
    mkdirSync(join(root, INTAKE_CHECKLIST_FILE));
    expect(await ask()).toEqual({ checklist: "unknown" });
  });
});

describe("the watcher", () => {
  function watch(projectRoot: string): { fires: () => number } {
    let fired = 0;
    const dataDir = join(projectRoot, "data");
    watchers.push(
      startWatcher({
        dataDir,
        statusDir: join(projectRoot, "status"),
        intervalMs: 50,
        onLibraryChange: () => {},
        onPlansChange: () => {},
        onAnnotationsChange: () => {},
        projectRoot,
        onIntakeChange: () => fired++,
      })
    );
    return { fires: () => fired };
  }

  async function waitFor(pred: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
      await sleep(20);
    }
  }

  test("a checklist already there is the baseline; appearing and going each fire once", async () => {
    const root = project();
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "x");
    const { fires } = watch(root);
    await sleep(200);
    expect(fires()).toBe(0);
    rmSync(join(root, INTAKE_CHECKLIST_FILE));
    await waitFor(() => fires() === 1);
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "y");
    await waitFor(() => fires() === 2);
    await sleep(200);
    expect(fires()).toBe(2);
  });

  test("rewriting the checklist is not a change of state: silent", async () => {
    const root = project();
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "a");
    const { fires } = watch(root);
    await sleep(150);
    writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "bb");
    await sleep(250);
    expect(fires()).toBe(0);
  });
});

describe("the checklist reaches the page over /ws", () => {
  test("appearing and going each broadcast `intake.changed`; the one Project root serves both the route and the watcher", async () => {
    const root = project();
    const dataDir = makeDataDir();
    roots.push(dataDir);
    const srv = createServer({
      globalDirs: isolatedGlobalDirs(),
      dataDir,
      projectRoot: root,
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      deps: { makeSources: () => stubSources() },
      watchIntervalMs: 30,
    });
    const port = await srv.ready();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { type: string };
          got.push(message.type);
          if (message.type === "hello") resolve();
        });
        socket.on("error", reject);
      });
      const changes = () => got.filter((type) => type === "intake.changed").length;
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/api/intake`)).json()).toEqual({ checklist: "absent" });
      writeFileSync(join(root, INTAKE_CHECKLIST_FILE), "x");
      await until(() => changes() === 1);
      expect(await (await fetch(`${base}/api/intake`)).json()).toEqual({ checklist: "present" });
      rmSync(join(root, INTAKE_CHECKLIST_FILE));
      await until(() => changes() === 2);
      await sleep(150);
      expect(changes()).toBe(2);
    } finally {
      socket.close();
      await srv.close();
    }
  });
});

async function until(pred: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}
