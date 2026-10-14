/**
 * The environment check (desktop-app ticket 13): the keychain probe with an injected `dbus-send` (no test here asks
 * a real bus: the isolation setup points the session bus at a socket that does not exist, and the one test that runs
 * the real `dbus-send` asserts that it does), and the version lines of constructed programs.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkEnvironment,
  type DbusSend,
  probeKeychain,
  toolVersion,
  versionLine,
} from "../src/environment.js";
import { locateTool, locateToolchain } from "../src/tex/toolchain.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const loads = async () => true;

/** A fake `dbus-send`: answers from a table keyed by the method asked, and records what it was asked. */
function fakeBus(answers: Record<string, string | "fail" | "missing">) {
  const asked: { args: readonly string[]; env: Record<string, string> }[] = [];
  const send: DbusSend = async (args, env) => {
    asked.push({ args, env });
    const method = args.find((a) => a.startsWith("org.freedesktop.DBus.")) ?? "";
    const answer = answers[method];
    if (answer === "missing") return { ok: false, missing: true };
    if (answer === undefined || answer === "fail") return { ok: false, missing: false };
    return { ok: true, stdout: answer };
  };
  return { send, asked };
}

describe("the keychain probe asks only the bus daemon", () => {
  test("a Secret Service on the bus: available, and nothing but the bus daemon was asked", async () => {
    const bus = fakeBus({ "org.freedesktop.DBus.NameHasOwner": "   boolean true\n" });
    const r = await probeKeychain({
      platform: "linux",
      env: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/x/bus",
        PATH: "/usr/bin",
        DISPLAY: ":0",
        HOME: "/home/u",
      },
      dbusSend: bus.send,
      moduleLoads: loads,
    });
    expect(r).toEqual({ state: "available", reason: "secret_service" });
    expect(bus.asked).toHaveLength(1);
    const [{ args, env } = { args: [], env: {} }] = bus.asked;
    expect(args).toContain("--dest=org.freedesktop.DBus");
    expect(args).toContain("/org/freedesktop/DBus");
    expect(args.join(" ")).not.toMatch(
      /org\.freedesktop\.Secret\b|Unlock|GetSecret|SearchItems|Collection/
    );
    // only the bus address and PATH: no display, no home
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/x/bus",
    });
  });

  test("none running but activatable: available; neither: unavailable", async () => {
    const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/x/bus" };
    const activatable = fakeBus({
      "org.freedesktop.DBus.NameHasOwner": "boolean false",
      "org.freedesktop.DBus.ListActivatableNames": 'array [\n string "org.freedesktop.secrets"\n]',
    });
    expect(
      await probeKeychain({
        platform: "linux",
        env,
        dbusSend: activatable.send,
        moduleLoads: loads,
      })
    ).toEqual({
      state: "available",
      reason: "activatable",
    });
    const none = fakeBus({
      "org.freedesktop.DBus.NameHasOwner": "boolean false",
      "org.freedesktop.DBus.ListActivatableNames": 'array [ string "org.freedesktop.secrets.foo" ]',
    });
    expect(
      await probeKeychain({ platform: "linux", env, dbusSend: none.send, moduleLoads: loads })
    ).toEqual({
      state: "unavailable",
      reason: "no_service",
    });
  });

  test("no bus address: unavailable without asking anything; a bus that does not answer: unavailable", async () => {
    const bus = fakeBus({});
    expect(
      await probeKeychain({ platform: "linux", env: {}, dbusSend: bus.send, moduleLoads: loads })
    ).toEqual({
      state: "unavailable",
      reason: "no_bus",
    });
    expect(bus.asked).toHaveLength(0);
    expect(
      await probeKeychain({
        platform: "linux",
        env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nope" },
        dbusSend: fakeBus({ "org.freedesktop.DBus.NameHasOwner": "fail" }).send,
        moduleLoads: loads,
      })
    ).toEqual({ state: "unavailable", reason: "no_bus" });
  });

  test("no dbus-send: unknown; the keyring module not loading: unavailable; macOS and Windows: assumed", async () => {
    const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/x/bus" };
    expect(
      await probeKeychain({
        platform: "linux",
        env,
        dbusSend: fakeBus({ "org.freedesktop.DBus.NameHasOwner": "missing" }).send,
        moduleLoads: loads,
      })
    ).toEqual({ state: "unknown", reason: "no_probe" });
    expect(await probeKeychain({ platform: "linux", env, moduleLoads: async () => false })).toEqual(
      {
        state: "unavailable",
        reason: "no_module",
      }
    );
    const bus = fakeBus({});
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        await probeKeychain({ platform, env, dbusSend: bus.send, moduleLoads: loads })
      ).toEqual({
        state: "available",
        reason: "platform",
      });
    }
    expect(bus.asked).toHaveLength(0);
  });

  test("in this test process the session bus leads nowhere: the real probe says unavailable", async () => {
    // isolate-user-dirs.ts: the bus address is a socket under the temporary root that does not exist
    const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
    expect(address.startsWith(`unix:path=${tmpdir()}/`)).toBe(true);
    expect(address.endsWith("/no-session-bus")).toBe(true);
    expect(await probeKeychain({ moduleLoads: loads })).toEqual({
      state: "unavailable",
      reason: "no_bus",
    });
  });
});

describe("version lines", () => {
  test("the first non-empty line, without control characters, cut to a bound", () => {
    expect(versionLine("\n\nLatexmk, John Collins, version 4.83\nmore")).toBe(
      "Latexmk, John Collins, version 4.83"
    );
    expect(versionLine("a\u001b[31mb‮c")).toBe("a [31mb c");
    expect(versionLine("x".repeat(400))?.length).toBe(160);
    expect(versionLine("  \n \n")).toBeNull();
  });

  test("each found program is asked its version with a fixed option; one that prints nothing, or is missing, has none", async () => {
    const r = mkdtempSync(join(tmpdir(), "aspace-env-"));
    roots.push(r);
    const bin = join(r, "bin");
    mkdirSync(bin);
    const prog = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    prog("latexmk", 'echo; echo "Latexmk, fake, args: $*"');
    prog("pdflatex", 'echo "pdfTeX fake $*"; echo second line');
    prog("gs", "echo 10.02.1");
    prog("pdftocairo", 'echo "pdftocairo version 24.02.0" >&2; exit 99');
    prog("biber", "true");
    const toolchain = locateToolchain({ platform: "linux", env: { PATH: bin } });
    const check = await checkEnvironment({
      toolchain,
      keychain: async () => ({ state: "available", reason: "secret_service" }),
    });
    const { bwrap, ...version } = Object.fromEntries(check.tools.map((t) => [t.tool, t.version]));
    // bubblewrap is also looked for in the system directories (where the sandbox runs it from): this machine's, or none
    expect(bwrap === null || /^bubblewrap /.test(String(bwrap))).toBe(true);
    expect(version).toEqual({
      latexmk: "Latexmk, fake, args: -norc -v",
      pdflatex: "pdfTeX fake --version",
      xelatex: null,
      bibtex: null,
      biber: null,
      pdftocairo: "pdftocairo version 24.02.0",
      ghostscript: "Ghostscript 10.02.1",
    });
    expect(check.tools.find((t) => t.tool === "xelatex")?.located).toBeNull();
    expect(check.keychain).toEqual({ state: "available", reason: "secret_service" });
  });
});

describe("revision: the bus address, the version lines, and what is never run", () => {
  test("without DBUS_SESSION_BUS_ADDRESS, $XDG_RUNTIME_DIR/bus is used only when it exists", async () => {
    const r = mkdtempSync(join(tmpdir(), "aspace-env-run-"));
    roots.push(r);
    const bus = fakeBus({ "org.freedesktop.DBus.NameHasOwner": "boolean true" });
    expect(
      await probeKeychain({
        platform: "linux",
        env: { XDG_RUNTIME_DIR: r },
        dbusSend: bus.send,
        moduleLoads: loads,
      })
    ).toEqual({ state: "unavailable", reason: "no_bus" });
    expect(bus.asked).toHaveLength(0);
    writeFileSync(join(r, "bus"), "");
    expect(
      await probeKeychain({
        platform: "linux",
        env: { XDG_RUNTIME_DIR: r },
        dbusSend: bus.send,
        moduleLoads: loads,
      })
    ).toEqual({ state: "available", reason: "secret_service" });
    expect(bus.asked[0]?.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${join(r, "bus")}`);
  });

  test("invisible characters of every kind are replaced; C1 controls too; cut by code points with an ellipsis", () => {
    const invisible = [
      "\u0085",
      "\u00ad",
      "\u061c",
      "\u180e",
      "\u200b",
      "\u2028",
      "\u2029",
      "\u2066",
      "\ufeff",
      "\ufff9",
      "\ufffb",
      "\u{e0001}",
      "\u{e007f}",
    ];
    for (const ch of invisible) expect(versionLine(`a${ch}b`)).toBe("a b");
    const long = versionLine(`${"x".repeat(158)}\u{1f600}\u{1f600}tail`);
    expect(long).toBe(`${"x".repeat(158)}\u{1f600}…`);
    expect(Array.from(long ?? "")).toHaveLength(160);
    // never half of a surrogate pair at the cut
    const emoji = versionLine("\u{1f600}".repeat(200)) ?? "";
    expect(emoji.endsWith("\u{1f600}…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false);
  });

  test("a program that does not answer in time has no version line; a batch file is never run", async () => {
    const r = mkdtempSync(join(tmpdir(), "aspace-env-slow-"));
    roots.push(r);
    const slow = join(r, "biber");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\necho late\n");
    chmodSync(slow, 0o755);
    const started = Date.now();
    expect(
      await toolVersion("biber", { path: slow, source: "path" }, {}, { cwd: r, timeoutMs: 300 })
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    const mark = join(r, "batch-ran");
    for (const name of ["latexmk.bat", "latexmk.CMD"]) {
      const bat = join(r, name);
      writeFileSync(bat, `#!/bin/sh\necho ran > ${JSON.stringify(mark)}\necho Latexmk\n`);
      chmodSync(bat, 0o755);
      expect(
        await toolVersion("latexmk", { path: bat, source: "path" }, {}, { cwd: r })
      ).toBeNull();
    }
    expect(existsSync(mark)).toBe(false);
  });

  test("the version commands run in an empty directory of their own, removed afterwards", async () => {
    const r = mkdtempSync(join(tmpdir(), "aspace-env-cwd-"));
    roots.push(r);
    const bin = join(r, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "latexmk"), '#!/bin/sh\necho "cwd: $(pwd) files: $(ls -A | wc -l)"\n');
    chmodSync(join(bin, "latexmk"), 0o755);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("aspace-env-check-"));
    const check = await checkEnvironment({
      toolchain: locateToolchain({ platform: "linux", env: { PATH: bin } }),
      keychain: async () => ({ state: "unknown", reason: "no_probe" }),
    });
    const line = check.tools.find((t) => t.tool === "latexmk")?.version ?? "";
    expect(line).toMatch(/^cwd: .*aspace-env-check-.* files: 0$/);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("aspace-env-check-"));
    expect(after.sort()).toEqual(before.sort());
  });
});

const REAL_LATEXMK = locateTool("latexmk");
describe.skipIf(REAL_LATEXMK === null)(
  "the real latexmk is asked for its version without reading an rc file",
  () => {
    test("a latexmkrc in the working directory and a ~/.latexmkrc that leave a mark: no mark, a normal line", async () => {
      // the home directory is the isolated one of this test file (isolate-user-dirs.ts)
      expect(homedir().startsWith(tmpdir())).toBe(true);
      const r = mkdtempSync(join(tmpdir(), "aspace-env-rc-"));
      roots.push(r);
      const markHome = join(r, "home-rc-ran");
      const markCwd = join(r, "cwd-rc-ran");
      const homeRc = join(homedir(), ".latexmkrc");
      writeFileSync(
        homeRc,
        `open(my $f, '>', ${JSON.stringify(markHome)}); print $f "x"; close $f; print "RC OUTPUT\\n";\n`
      );
      const previous = process.cwd();
      writeFileSync(
        join(r, "latexmkrc"),
        `open(my $f, '>', ${JSON.stringify(markCwd)}); print $f "x"; close $f; print "RC OUTPUT\\n";\n`
      );
      process.chdir(r);
      try {
        const check = await checkEnvironment({
          toolchain: locateToolchain(),
          keychain: async () => ({ state: "unknown", reason: "no_probe" }),
        });
        const line = check.tools.find((t) => t.tool === "latexmk")?.version ?? "";
        expect(line).toMatch(/^Latexmk, /);
        expect(existsSync(markHome)).toBe(false);
        expect(existsSync(markCwd)).toBe(false);
      } finally {
        process.chdir(previous);
        rmSync(homeRc, { force: true });
      }
    });
  }
);
