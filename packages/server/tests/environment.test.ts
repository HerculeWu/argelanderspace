/**
 * The environment check over HTTP (desktop-app ticket 13): a real server, real requests. PATH is a constructed
 * directory of fake programs that print a version line, so a program is "taken away" by not putting it there — nothing
 * of the system is moved. The keychain probe is a fake handed in (`keychainProbe`), except in the one test that checks
 * the default probe, which asks only the bus daemon of this test process — a socket that does not exist
 * (isolate-user-dirs.ts) — so the user's real keychain is never reached. The sandbox answer is forced either way.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ENVIRONMENT_TOOLS,
  type EnvironmentReport,
  isEnvironmentReport,
  TOOL_FEATURES,
} from "@argelanderspace/contracts";
import { __setWriterSandboxForTests, type KeychainProbe } from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubSources } from "./helpers.js";

const ORIGINAL_PATH = process.env.PATH;
let root: string;
let bin: string;
let configPath: string;
let srv: RunningServer | undefined;
let base: string;
let keychain: KeychainProbe | null = { state: "available", reason: "secret_service" };

function program(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\necho "${version}"\n`);
  chmodSync(join(dir, name), 0o755);
}

const ALL: Record<string, string> = {
  latexmk: "Latexmk, fake 4.83",
  pdflatex: "pdfTeX fake",
  xelatex: "XeTeX fake",
  bibtex: "BibTeX fake",
  biber: "biber version: fake",
  pdftocairo: "pdftocairo version fake",
  gs: "10.02.1",
  bwrap: "bubblewrap fake",
};

function fillBin(except: string[] = []): void {
  rmSync(bin, { recursive: true, force: true });
  for (const [name, version] of Object.entries(ALL))
    if (!except.includes(name)) program(bin, name, version);
}

async function start(extra: Partial<Parameters<typeof createServer>[0]> = {}): Promise<void> {
  srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir: (() => {
      const dir = makeDataDir();
      made.push(dirname(dir));
      return dir;
    })(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    configPath,
    ...(keychain === null ? {} : { keychainProbe: async () => keychain as KeychainProbe }),
    ...extra,
  });
  base = `http://127.0.0.1:${await srv.ready()}`;
}

async function check(
  headers: Record<string, string> = {}
): Promise<{ status: number; cache: string | null; body: EnvironmentReport }> {
  const res = await fetch(`${base}/api/environment`, { headers });
  return {
    status: res.status,
    cache: res.headers.get("cache-control"),
    body: (await res.json()) as EnvironmentReport,
  };
}
const tool = (report: EnvironmentReport, name: string) => {
  const found = report.tools.find((t) => t.tool === name);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aspace-env-http-"));
  bin = join(root, "bin");
  configPath = join(root, "config.toml");
  __setWriterSandboxForTests(true);
});
/** The temporary project directories `makeDataDir` made: removed after each test. */
const made: string[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env.PATH = ORIGINAL_PATH;
  rmSync(configPath, { force: true });
  keychain = { state: "available", reason: "secret_service" };
});
afterAll(() => {
  __setWriterSandboxForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/environment", () => {
  test("every tool: found, from where, its version line, what is unavailable without it; no-store", async () => {
    fillBin();
    process.env.PATH = bin;
    await start();
    const { status, cache, body } = await check();
    expect(status).toBe(200);
    expect(cache).toBe("no-store");
    expect(isEnvironmentReport(body)).toBe(true);
    expect(body.tools.map((t) => t.tool)).toEqual([...ENVIRONMENT_TOOLS]);
    for (const t of body.tools) {
      expect(t).toEqual({
        tool: t.tool,
        found: true,
        source: "path",
        path: {
          path: join(bin, t.tool === "ghostscript" ? "gs" : t.tool),
          display: join(bin, t.tool === "ghostscript" ? "gs" : t.tool),
        },
        version: t.tool === "ghostscript" ? "Ghostscript 10.02.1" : ALL[t.tool],
        affects: [],
      });
    }
    expect(body.texDir).toEqual({ state: "unset", path: null });
    expect(body.keychain).toEqual({ state: "available", reason: "secret_service" });
    expect(body.sandbox).toBe("available");
    expect(body.platform).toBe("linux");
  });

  test("a tool taken out of PATH: not found, no version, and what is unavailable without it", async () => {
    fillBin(["biber", "gs"]);
    process.env.PATH = bin;
    await start();
    let { body } = await check();
    expect(tool(body, "biber")).toEqual({
      tool: "biber",
      found: false,
      source: null,
      path: null,
      version: null,
      affects: ["biber"],
    });
    expect(tool(body, "ghostscript").affects).toEqual(["eps_figures"]);
    expect(tool(body, "latexmk").affects).toEqual([]);
    // the next check sees the next state: latexmk gone too (no restart)
    fillBin(["latexmk", "pdftocairo", "bwrap"]);
    ({ body } = await check());
    expect(tool(body, "latexmk")).toMatchObject({
      found: false,
      affects: ["latex_ingest", "writer_render"],
    });
    expect(tool(body, "pdftocairo").affects).toEqual(["figures"]);
    // bubblewrap off PATH: looked for where the sandbox runs it from (the system directories), so it is "common" or
    // missing — and when missing, what is unavailable is the Copilot's compiling
    const bwrap = tool(body, "bwrap");
    if (bwrap.found) expect(bwrap.source).toBe("common");
    else expect(bwrap.affects).toEqual([...TOOL_FEATURES.bwrap]);
    expect(tool(body, "biber").found).toBe(true);
  });

  test("the configured TeX directory: before PATH, read again at each check, and its problems reported", async () => {
    fillBin();
    process.env.PATH = bin;
    await start();
    const texDir = join(root, "texbin");
    program(texDir, "latexmk", "Latexmk from the TeX directory");
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(texDir)}\n`);
    let { body } = await check();
    expect(body.texDir).toEqual({ state: "ok", path: { path: texDir, display: texDir } });
    expect(tool(body, "latexmk")).toMatchObject({
      source: "tex_dir",
      version: "Latexmk from the TeX directory",
    });
    expect(tool(body, "pdflatex")).toMatchObject({ source: "path" });
    // changed in the file (no restart): a directory that does not exist, then one without latexmk
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(join(root, "nowhere"))}\n`);
    ({ body } = await check());
    expect(body.texDir.state).toBe("missing");
    expect(tool(body, "latexmk")).toMatchObject({ found: true, source: "path" });
    const empty = join(root, "empty-tex");
    mkdirSync(empty, { recursive: true });
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(empty)}\n`);
    ({ body } = await check());
    expect(body.texDir.state).toBe("no_latexmk");
    // not an error of the settings either: the key is fine as far as the file goes
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as {
      problems: unknown[];
    };
    expect(settings.problems).toEqual([]);
  });

  test("keychain and sandbox: as the probes answer", async () => {
    fillBin();
    process.env.PATH = bin;
    keychain = { state: "unavailable", reason: "no_service" };
    __setWriterSandboxForTests(false);
    try {
      await start();
      const { body } = await check();
      expect(body.keychain).toEqual({ state: "unavailable", reason: "no_service" });
      expect(body.sandbox).toBe("unavailable");
    } finally {
      __setWriterSandboxForTests(true);
    }
  });

  test("the default keychain probe in this test process reaches no keychain: the bus leads nowhere", async () => {
    fillBin();
    process.env.PATH = bin;
    keychain = null;
    expect(process.env.DBUS_SESSION_BUS_ADDRESS?.endsWith("/no-session-bus")).toBe(true);
    await start();
    const { body } = await check();
    expect(body.keychain).toEqual({ state: "unavailable", reason: "no_bus" });
  });

  test("a check running when tex_dir changes is not shared with a request that arrives after the change", async () => {
    fillBin();
    // latexmk on PATH answers slowly: the first check is still running when the file changes
    writeFileSync(join(bin, "latexmk"), '#!/bin/sh\n/bin/sleep 1.5\necho "Latexmk, slow"\n');
    chmodSync(join(bin, "latexmk"), 0o755);
    process.env.PATH = bin;
    await start();
    const first = check();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const texDir = join(root, "texbin-later");
    program(texDir, "latexmk", "Latexmk from the TeX directory");
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(texDir)}\n`);
    const second = await check();
    expect(second.body.texDir.state).toBe("ok");
    expect(tool(second.body, "latexmk")).toMatchObject({
      source: "tex_dir",
      version: "Latexmk from the TeX directory",
    });
    const firstBody = (await first).body;
    expect(firstBody.texDir.state).toBe("unset");
    expect(tool(firstBody, "latexmk")).toMatchObject({ source: "path", version: "Latexmk, slow" });
  });

  test("the Writer sandbox and the TeX directory: not found, another TeX, the same; never asked without a sandbox", async () => {
    fillBin(["latexmk", "pdflatex", "xelatex", "bibtex", "biber"]);
    process.env.PATH = bin;
    const texDir = join(root, "texbin-sb");
    program(texDir, "latexmk", "Latexmk from the TeX directory");
    const systemDir = join(root, "system-bin");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(texDir)}\n`);
    await start({ sandboxView: { systemDirs: [systemDir] } });
    let { body } = await check();
    // a TeX directory under /tmp: never bound, so putting it on PATH would not help
    expect(body.writerSandboxTex).toEqual({
      state: "not_found",
      path: null,
      fromTexDir: true,
      reach: "not_bindable",
    });
    program(systemDir, "latexmk", "Latexmk of the system");
    ({ body } = await check());
    expect(body.writerSandboxTex).toEqual({
      state: "different",
      path: { path: join(systemDir, "latexmk"), display: join(systemDir, "latexmk") },
      fromTexDir: true,
      reach: "not_bindable",
    });
    writeFileSync(configPath, `tex_dir = ${JSON.stringify(systemDir)}\n`);
    ({ body } = await check());
    expect(body.writerSandboxTex.state).toBe("same");
    __setWriterSandboxForTests(false);
    try {
      ({ body } = await check());
      expect(body.writerSandboxTex).toEqual({
        state: "not_applicable",
        path: null,
        fromTexDir: true,
        reach: null,
      });
    } finally {
      __setWriterSandboxForTests(true);
    }
  });

  // Second revision: the four situations the review found (constructed directories; the sandbox forced on, its system
  // directories injected). A latexmk that is a link into /usr/bin or /opt stands for a TeX installed there.
  describe("why the sandbox does not see the TeX found", () => {
    const linkTex = (dir: string, target: string) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, join(dir, "latexmk"));
    };
    const sandboxed = async (pathDirs: string[], systemDir: string) => {
      process.env.PATH = pathDirs.join(":");
      await start({ sandboxView: { systemDirs: [systemDir] } });
      return (await check()).body.writerSandboxTex;
    };

    test.skipIf(!existsSync("/usr/bin/latexmk"))(
      "(1) TeX Live under /usr (not a system directory), found on PATH, no tex_dir: not found, under /usr, not from tex_dir",
      async () => {
        const onPath = join(root, "texlive-under-usr");
        linkTex(onPath, "/usr/bin/latexmk");
        const empty = join(root, "sys-empty-1");
        mkdirSync(empty, { recursive: true });
        expect(await sandboxed([onPath], empty)).toEqual({
          state: "not_found",
          path: null,
          fromTexDir: false,
          reach: "under_usr",
        });
      }
    );

    test("(2) TeX in a place never bound (/tmp here), on PATH: not found, not bindable", async () => {
      const onPath = join(root, "texlive-in-tmp");
      program(onPath, "latexmk", "Latexmk in tmp");
      const empty = join(root, "sys-empty-2");
      mkdirSync(empty, { recursive: true });
      expect(await sandboxed([onPath], empty)).toEqual({
        state: "not_found",
        path: null,
        fromTexDir: false,
        reach: "not_bindable",
      });
    });

    test("(3) no tex_dir, latexmk from PATH, not found: reported as not from tex_dir", async () => {
      const onPath = join(root, "texlive-path-3");
      program(onPath, "latexmk", "Latexmk on PATH");
      const empty = join(root, "sys-empty-3");
      mkdirSync(empty, { recursive: true });
      const view = await sandboxed([onPath], empty);
      expect(view.state).toBe("not_found");
      expect(view.fromTexDir).toBe(false);
    });

    // (4) runs in infra tex-sandbox-view.test.ts: a stand-in for a TeX under /opt must be a real file there, and this
    // endpoint would run it for its version line — nothing outside TeX is run here.
  });
});
