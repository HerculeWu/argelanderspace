/**
 * The command-line tool's launcher (desktop-app ticket 24): a marked script in the user's own executable directory that
 * runs the desktop app's Node on its CLI. Installing never overwrites a file without the mark, uninstalling removes only
 * a marked one, and the PATH report says whether the directory is on PATH and the line the user would add. Nothing here
 * changes an environment variable or a shell configuration.
 *
 * Every file is under a temporary home made for the test (the isolated HOME of isolate-user-dirs.ts is not touched
 * either); the guard (isolation-guard.test.ts) checks the default directory is inside the isolated root.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  bundledSkillsDir,
  CLI_COMMAND,
  CLI_LAUNCHER_MARK,
  cliLauncherFile,
  cliLauncherStatus,
  dirOnPath,
  installCliLauncher,
  launcherScript,
  pathLineFor,
  resolveUserBinDir,
  uninstallCliLauncher,
} from "../src/cli-launcher.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway home; the name has a space and a quote so that every quoting of a path is exercised. */
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-launcher-"));
  made.push(root);
  const home = join(root, "a home 'q'");
  mkdirSync(home);
  return home;
}

/** A stand-in for the app: its Node (the running one) and a CLI that prints its arguments. */
function fakeApp(home: string): { node: string; cli: string; root: string } {
  const root = join(home, "app dir 'x'");
  mkdirSync(join(root, "dist"), { recursive: true });
  const cli = join(root, "dist", "bin.js");
  writeFileSync(
    cli,
    "console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.EXIT ?? 0));\n"
  );
  return { node: process.execPath, cli, root };
}

const linux = (home: string, PATH = "/usr/bin:/bin") => ({
  platform: "linux" as const,
  home,
  env: { PATH },
});

describe("where the launcher goes", () => {
  test("Linux and macOS: ~/.local/bin/argelanderspace, the npm package's command name", () => {
    const home = tempHome();
    expect(CLI_COMMAND).toBe("argelanderspace");
    expect(resolveUserBinDir({ platform: "linux", home, env: {} })).toBe(
      join(home, ".local", "bin")
    );
    expect(resolveUserBinDir({ platform: "darwin", home, env: {} })).toBe(
      join(home, ".local", "bin")
    );
    expect(cliLauncherFile({ platform: "linux", home, env: {} })).toBe(
      join(home, ".local", "bin", "argelanderspace")
    );
  });

  test("the command name is the bin name of the npm package", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "app", "package.json"), "utf8")
    ) as {
      bin: Record<string, string>;
    };
    expect(Object.keys(pkg.bin)).toEqual([CLI_COMMAND]);
  });

  test("Windows: %LOCALAPPDATA%\\Programs\\argelanderspace\\bin\\argelanderspace.cmd, else below the home", () => {
    expect(
      resolveUserBinDir({
        platform: "win32",
        home: "C:\\Users\\u",
        env: { LOCALAPPDATA: "D:\\Local" },
      })
    ).toBe("D:\\Local\\Programs\\argelanderspace\\bin");
    expect(resolveUserBinDir({ platform: "win32", home: "C:\\Users\\u", env: {} })).toBe(
      "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin"
    );
    expect(cliLauncherFile({ platform: "win32", home: "C:\\Users\\u", env: {} })).toBe(
      win32.join(
        "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin",
        "argelanderspace.cmd"
      )
    );
  });
});

describe("the PATH report", () => {
  test("whether the directory is on PATH (POSIX: exact entries, a trailing slash ignored)", () => {
    expect(dirOnPath("/h/.local/bin", "/usr/bin:/h/.local/bin", "linux")).toBe(true);
    expect(dirOnPath("/h/.local/bin", "/usr/bin:/h/.local/bin/", "linux")).toBe(true);
    expect(dirOnPath("/h/.local/bin", "/usr/bin:/h/.local/bin2:/h/.local", "linux")).toBe(false);
    expect(dirOnPath("/h/.local/bin", "", "linux")).toBe(false);
    expect(dirOnPath("/h/.local/bin", undefined, "linux")).toBe(false);
    // A relative entry is not the directory (it depends on where the shell is).
    expect(dirOnPath("/h/.local/bin", ".local/bin", "linux")).toBe(false);
  });

  test("Windows: entries split at ';', compared without case, quotes and a trailing backslash", () => {
    const dir = "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin";
    expect(
      dirOnPath(
        dir,
        "C:\\Windows;c:\\users\\U\\appdata\\local\\programs\\ArgelanderSpace\\bin\\",
        "win32"
      )
    ).toBe(true);
    expect(dirOnPath(dir, `C:\\Windows;"${dir}"`, "win32")).toBe(true);
    expect(dirOnPath(dir, "C:\\Windows", "win32")).toBe(false);
  });

  test("the line to add: $HOME form below the home, the quoted path elsewhere, the directory itself on Windows", () => {
    expect(pathLineFor("/h/.local/bin", "linux", "/h")).toBe(
      'export PATH="$HOME/.local/bin:$PATH"'
    );
    expect(pathLineFor("/opt/my bin", "darwin", "/h")).toBe('export PATH="/opt/my bin:$PATH"');
    expect(pathLineFor('/opt/a"$`\\b', "linux", "/h")).toBe(
      'export PATH="/opt/a\\"\\$\\`\\\\b:$PATH"'
    );
    expect(pathLineFor("C:\\x\\bin", "win32", "C:\\Users\\u")).toBe("C:\\x\\bin");
  });

  test("the status reports it from the environment it is given; nothing in the environment is changed", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const dir = join(home, ".local", "bin");
    const before = { ...process.env };
    const off = cliLauncherStatus(app, linux(home));
    expect(off).toMatchObject({
      state: "not_installed",
      dir,
      file: join(dir, "argelanderspace"),
      inPath: false,
      platform: "posix",
    });
    expect(off.pathLine).toBe('export PATH="$HOME/.local/bin:$PATH"');
    expect(cliLauncherStatus(app, linux(home, `/usr/bin:${dir}`)).inPath).toBe(true);
    installCliLauncher(app, linux(home));
    expect(process.env).toEqual(before);
    // No shell configuration was written: the home holds the launcher's directory and the app stand-in, nothing else.
    expect(readdirSync(home).sort()).toEqual([".local", "app dir 'x'"]);
    expect(readdirSync(join(home, ".local"))).toEqual(["bin"]);
  });
});

describe("install", () => {
  test("writes an executable script with the mark that runs the app's Node on its CLI", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const result = installCliLauncher(app, linux(home));
    expect(result.outcome).toBe("installed");
    expect(result.status.state).toBe("installed");
    const file = join(home, ".local", "bin", "argelanderspace");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(CLI_LAUNCHER_MARK);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(text).toBe(launcherScript(app, "linux", file));
    // No temporary file is left next to it.
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["argelanderspace"]);
    const run = spawnSync(file, ["read", "a b", "it's"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(["read", "a b", "it's"]);
    // The CLI's exit code is the command's.
    const failing = spawnSync(file, [], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", EXIT: "3" },
    });
    expect(failing.status).toBe(3);
  });

  test("again over its own script: replaced, still one file", () => {
    const home = tempHome();
    const app = fakeApp(home);
    installCliLauncher(app, linux(home));
    const again = installCliLauncher(app, linux(home));
    expect(again.outcome).toBe("installed");
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["argelanderspace"]);
  });

  test("its own script for another place of the app is outdated; installing points it here", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const file = join(home, ".local", "bin", "argelanderspace");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(file, launcherScript({ node: "/old/node", cli: "/old/bin.js" }, "linux", file), {
      mode: 0o755,
    });
    expect(cliLauncherStatus(app, linux(home)).state).toBe("outdated");
    expect(installCliLauncher(app, linux(home)).status.state).toBe("installed");
    expect(readFileSync(file, "utf8")).toContain(app.cli.replace(/'/g, "'\\''"));
  });

  test("a file of the same name without the mark is not overwritten and is reported", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const dir = join(home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "argelanderspace");
    writeFileSync(file, "#!/bin/sh\necho mine\n", { mode: 0o700 });
    const result = installCliLauncher(app, linux(home));
    expect(result.outcome).toBe("foreign");
    expect(result.status.state).toBe("foreign");
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(statSync(file).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(["argelanderspace"]);
  });

  test("a symbolic link there (an npm global install's, say) is foreign: neither it nor its target is touched", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const dir = join(home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    // Even a link to a marked script: what is at that name is a link, not the app's script.
    const target = join(home, "marked");
    writeFileSync(target, launcherScript(app, "linux", target));
    symlinkSync(target, join(dir, "argelanderspace"));
    expect(cliLauncherStatus(app, linux(home)).state).toBe("foreign");
    expect(installCliLauncher(app, linux(home)).outcome).toBe("foreign");
    expect(lstatSync(join(dir, "argelanderspace")).isSymbolicLink()).toBe(true);
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("foreign");
    expect(lstatSync(join(dir, "argelanderspace")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(launcherScript(app, "linux", target));
  });

  test("a directory of that name is foreign too", () => {
    const home = tempHome();
    const app = fakeApp(home);
    mkdirSync(join(home, ".local", "bin", "argelanderspace"), { recursive: true });
    expect(installCliLauncher(app, linux(home)).outcome).toBe("foreign");
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("foreign");
    expect(statSync(join(home, ".local", "bin", "argelanderspace")).isDirectory()).toBe(true);
  });

  test("a directory that cannot be written: the error is thrown, nothing is left", () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    const home = tempHome();
    const app = fakeApp(home);
    const dir = join(home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => installCliLauncher(app, linux(home))).toThrow(
        expect.objectContaining({ code: "EACCES" })
      );
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a path the launcher cannot carry is refused before anything is written", () => {
    const home = tempHome();
    expect(() =>
      installCliLauncher({ node: "relative/node", cli: "/a/bin.js" }, linux(home))
    ).toThrow();
    expect(() => installCliLauncher({ node: "/a/node", cli: "/a/b\0.js" }, linux(home))).toThrow();
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});

describe("when the app is moved or removed", () => {
  test("the script says which file is missing and what to do, exit 1, instead of a bare 'not found'", () => {
    const home = tempHome();
    const app = fakeApp(home);
    installCliLauncher(app, linux(home));
    const file = join(home, ".local", "bin", "argelanderspace");
    renameSync(app.root, `${app.root}-moved`);
    const run = spawnSync(file, ["--version"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`error: ${app.cli} is missing`);
    expect(run.stderr).toContain("ArgelanderSpace desktop app");
    expect(run.stderr).toContain("moved or removed");
    expect(run.stderr).toContain(file);
    expect(run.stderr).not.toMatch(/No such file|not found/);
  });

  test("a missing Node is named the same way", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const node = join(home, "node 'n'");
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    installCliLauncher({ node, cli: app.cli }, linux(home));
    rmSync(node);
    const run = spawnSync(join(home, ".local", "bin", "argelanderspace"), [], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`error: ${node} is missing`);
  });
});

describe("uninstall", () => {
  test("removes its own script only; the directory stays", () => {
    const home = tempHome();
    const app = fakeApp(home);
    installCliLauncher(app, linux(home));
    const result = uninstallCliLauncher(linux(home));
    expect(result.outcome).toBe("removed");
    expect(result.status.state).toBe("not_installed");
    expect(existsSync(join(home, ".local", "bin", "argelanderspace"))).toBe(false);
    expect(statSync(join(home, ".local", "bin")).isDirectory()).toBe(true);
  });

  test("its own outdated script is removed too", () => {
    const home = tempHome();
    const file = join(home, ".local", "bin", "argelanderspace");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(file, launcherScript({ node: "/old/node", cli: "/old/bin.js" }, "linux", file));
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("removed");
    expect(existsSync(file)).toBe(false);
  });

  test("a file without the mark is left as it is", () => {
    const home = tempHome();
    const file = join(home, ".local", "bin", "argelanderspace");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    // The mark's words in a comment of someone else's script are not the mark line.
    const mine = `#!/bin/sh\n# not an ${CLI_LAUNCHER_MARK} file\necho mine\n`;
    writeFileSync(file, mine);
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("foreign");
    expect(readFileSync(file, "utf8")).toBe(mine);
  });

  test("nothing there: not installed, nothing created", () => {
    const home = tempHome();
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("not_installed");
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});

describe("the Windows script", () => {
  const target = {
    node: "C:\\Program Files\\ArgelanderSpace\\node.exe",
    cli: "C:\\Program Files\\ArgelanderSpace\\app 100%&co\\bin.js",
  };
  const file = "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin\\argelanderspace.cmd";

  test("a .cmd with CRLF lines, the mark, %% for a percent sign, and the same message when a file is missing", () => {
    const text = launcherScript(target, "win32", file);
    expect(text.split("\r\n").length).toBeGreaterThan(5);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text.startsWith("@echo off\r\n")).toBe(true);
    expect(text).toContain(`rem ${CLI_LAUNCHER_MARK}`);
    expect(text).toContain('set "AS_NODE=C:\\Program Files\\ArgelanderSpace\\node.exe"');
    expect(text).toContain('set "AS_CLI=C:\\Program Files\\ArgelanderSpace\\app 100%%&co\\bin.js"');
    expect(text).toContain('"%AS_NODE%" "%AS_CLI%" %*');
    expect(text).toContain("moved or removed");
    expect(text).toContain("exit /b 1");
  });

  test("a path with a double quote or a line break cannot be written into it", () => {
    expect(() => launcherScript({ ...target, cli: 'C:\\a"b\\bin.js' }, "win32", file)).toThrow();
    expect(() => launcherScript({ ...target, cli: "C:\\a\nb\\bin.js" }, "win32", file)).toThrow();
  });

  test("its mark is recognised like the POSIX one", () => {
    const home = tempHome();
    const dir = join(home, "bin");
    mkdirSync(dir);
    // Simulated on this machine: the Windows layout below the temporary home, only the reading of the mark matters.
    writeFileSync(join(dir, "probe"), launcherScript(target, "win32", file));
    expect(readFileSync(join(dir, "probe"), "utf8")).toContain(CLI_LAUNCHER_MARK);
  });
});

describe("the bundled skills", () => {
  test("found three levels up from the CLI, as in the package (sidecar/app/dist) and the repository (packages/app/dist)", () => {
    const home = tempHome();
    const resources = join(home, "usr", "lib", "argelanderspace");
    mkdirSync(join(resources, "sidecar", "app", "dist"), { recursive: true });
    mkdirSync(join(resources, "skills"));
    writeFileSync(join(resources, "skills", "README.md"), "# skills\n");
    expect(bundledSkillsDir(join(resources, "sidecar", "app", "dist", "bin.js"))).toBe(
      join(resources, "skills")
    );
    // The repository's own.
    const repoBin = join(__dirname, "..", "..", "app", "dist", "bin.js");
    expect(bundledSkillsDir(repoBin)).toBe(join(__dirname, "..", "..", "..", "skills"));
  });

  test("none where there is no such folder (an npm install, say)", () => {
    const home = tempHome();
    mkdirSync(join(home, "lib", "node_modules", "argelanderspace", "dist"), { recursive: true });
    expect(
      bundledSkillsDir(join(home, "lib", "node_modules", "argelanderspace", "dist", "bin.js"))
    ).toBeNull();
    // A folder named skills without the README is not taken for it.
    mkdirSync(join(home, "skills"));
    expect(bundledSkillsDir(join(home, "a", "b", "c", "bin.js"))).toBeNull();
  });
});
