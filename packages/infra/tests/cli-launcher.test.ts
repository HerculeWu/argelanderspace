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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  bundledSkillsDir,
  bundledTutorialDir,
  CLI_COMMAND,
  CLI_LAUNCHER_MARK,
  cliLauncherFile,
  cliLauncherStatus,
  cliLauncherUnavailable,
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

  test("a script longer than the first bytes read for the mark (long paths) is still known as installed", () => {
    const home = tempHome();
    const deep = (name: string) => `/${"d".repeat(250)}/`.repeat(12) + name;
    const target = { node: deep("node"), cli: deep("bin.js") };
    const result = installCliLauncher(target, linux(home));
    const file = join(home, ".local", "bin", "argelanderspace");
    expect(statSync(file).size).toBeGreaterThan(4096);
    expect(result.status.state).toBe("installed");
    expect(cliLauncherStatus(target, linux(home)).state).toBe("installed");
  });

  test("a marked file larger than any script of the app's is not read whole: outdated, and still removable", () => {
    const home = tempHome();
    const app = fakeApp(home);
    const file = join(home, ".local", "bin", "argelanderspace");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const text = launcherScript(app, "linux", file);
    writeFileSync(file, text + "#".repeat(2 * 1024 * 1024));
    expect(cliLauncherStatus(app, linux(home)).state).toBe("outdated");
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("removed");
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

  test("its mark is recognised like the POSIX one: rem and CRLF, at the launcher's own path", () => {
    const home = tempHome();
    const file = join(home, ".local", "bin", "argelanderspace");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    // The Windows text at the path this platform reads: only the `rem` mark line and the CRLF lines can make it the
    // app's, and it is not this platform's script, so it reads as the app's own but for elsewhere.
    writeFileSync(
      file,
      launcherScript(target, "win32", file.replace(/\//g, "\\").replace(/^\\/, "C:\\"))
    );
    expect(
      cliLauncherStatus({ node: "/opt/a/node", cli: "/opt/a/bin.js" }, linux(home)).state
    ).toBe("outdated");
    expect(uninstallCliLauncher(linux(home)).outcome).toBe("removed");
    expect(existsSync(file)).toBe(false);
  });

  test("delayed expansion is off, so a `!` in a path is taken as written", () => {
    const lines = launcherScript(target, "win32", file).split("\r\n");
    expect(lines).toContain("setlocal DisableDelayedExpansion");
    expect(lines).not.toContain("setlocal");
  });

  test("no echo line has a cmd metacharacter outside quotes that is not escaped, and what it shows is the message", () => {
    const text = launcherScript(target, "win32", file);
    const echoes = text
      .split("\r\n")
      .map((line) => /^(?:>&2 )?echo (.*)$/.exec(line)?.[1])
      .filter((rest): rest is string => rest !== undefined);
    expect(echoes.length).toBe(2);
    for (const rest of echoes) expect(unescapedMeta(rest)).toEqual([]);
    const shown = echoes.map(shownByEcho).join("\n");
    expect(shown).toContain("(Settings > Command line & agents)");
    expect(shown).toContain('"%AS_SELF%".');
    expect(shown).toContain("moved or removed.");
  });
});

describe("the Windows script and the console code page (desktop-app ticket 26)", () => {
  // A Chinese user name: cmd reads a batch file in the console's OEM code page (936, 437, …), not UTF-8, so these
  // characters must not be in the file at all.
  const local = "C:\\Users\\张三\\AppData\\Local";
  const env = {
    LOCALAPPDATA: local,
    USERPROFILE: "C:\\Users\\张三",
    APPDATA: `C:\\Users\\张三\\AppData\\Roaming`,
  };
  const target = {
    node: `${local}\\ArgelanderSpace\\sidecar\\node\\node.exe`,
    cli: `${local}\\ArgelanderSpace\\sidecar\\app\\dist\\bin.js`,
  };
  const file = `${local}\\Programs\\argelanderspace\\bin\\argelanderspace.cmd`;

  test("paths under the user's folders are written through their variables, so the file is ASCII", () => {
    const text = launcherScript(target, "win32", file, env);
    expect([...text].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
    expect(text).toContain(
      'set "AS_NODE=%LOCALAPPDATA%\\ArgelanderSpace\\sidecar\\node\\node.exe"'
    );
    expect(text).toContain(
      'set "AS_CLI=%LOCALAPPDATA%\\ArgelanderSpace\\sidecar\\app\\dist\\bin.js"'
    );
    expect(text).toContain(
      'set "AS_SELF=%LOCALAPPDATA%\\Programs\\argelanderspace\\bin\\argelanderspace.cmd"'
    );
  });

  test("the longest matching variable wins, the match ignores case and stops at a folder boundary", () => {
    const text = launcherScript(
      { node: "c:\\users\\张三\\appdata\\local\\A\\node.exe", cli: "C:\\Users\\zhang\\bin.js" },
      "win32",
      "C:\\Users\\张三\\f.cmd",
      env
    ).split("\r\n");
    expect(text).toContain('set "AS_NODE=%LOCALAPPDATA%\\A\\node.exe"');
    expect(text).toContain('set "AS_SELF=%USERPROFILE%\\f.cmd"');
    expect(text).toContain('set "AS_CLI=C:\\Users\\zhang\\bin.js"');
    // `张三x` is another folder than `张三`: no variable, and a non-ASCII character is left, so it is refused (below).
    expect(() =>
      launcherScript(
        { node: "C:\\a\\node.exe", cli: "C:\\Users\\张三x\\bin.js" },
        "win32",
        "C:\\f.cmd",
        env
      )
    ).toThrow(/non-ASCII/);
  });

  test("a percent sign after the variable is still doubled; ASCII paths outside the variables are written as they are", () => {
    const text = launcherScript(
      { node: `${local}\\a 100%\\node.exe`, cli: "D:\\Apps\\x!^)\\bin.js" },
      "win32",
      file,
      env
    );
    expect(text).toContain('set "AS_NODE=%LOCALAPPDATA%\\a 100%%\\node.exe"');
    expect(text).toContain('set "AS_CLI=D:\\Apps\\x!^)\\bin.js"');
  });

  test("a non-ASCII path no variable covers cannot be written into it", () => {
    expect(() =>
      launcherScript({ ...target, node: "D:\\软件\\node.exe" }, "win32", file, env)
    ).toThrow(/non-ASCII/);
    // Without the variables (an environment that has none), the user's own folder is not covered either.
    expect(() => launcherScript(target, "win32", file, {})).toThrow(/non-ASCII/);
  });

  test("an ASCII path is written as it is, even under a variable's folder", () => {
    const ascii = {
      LOCALAPPDATA: "C:\\Users\\zhang\\AppData\\Local",
      USERPROFILE: "C:\\Users\\zhang",
    };
    const text = launcherScript(
      {
        node: "C:\\Users\\zhang\\AppData\\Local\\ArgelanderSpace\\sidecar\\node\\node.exe",
        cli: "C:\\Users\\zhang\\AppData\\Local\\ArgelanderSpace\\sidecar\\app\\dist\\bin.js",
      },
      "win32",
      "C:\\Users\\zhang\\AppData\\Local\\Programs\\argelanderspace\\bin\\argelanderspace.cmd",
      ascii
    ).split("\r\n");
    expect(text).toContain(
      'set "AS_NODE=C:\\Users\\zhang\\AppData\\Local\\ArgelanderSpace\\sidecar\\node\\node.exe"'
    );
    expect(text).toContain(
      'set "AS_SELF=C:\\Users\\zhang\\AppData\\Local\\Programs\\argelanderspace\\bin\\argelanderspace.cmd"'
    );
    expect(text.join("\n")).not.toMatch(/%(LOCALAPPDATA|USERPROFILE)%/);
  });

  test("Program Files: %ProgramW6432% (always the 64-bit folder) is taken before %ProgramFiles% when both fit", () => {
    const pf = "C:\\程序文件";
    const text = launcherScript(
      { node: `${pf}\\ArgelanderSpace\\node.exe`, cli: `${pf}\\ArgelanderSpace\\bin.js` },
      "win32",
      "C:\\f.cmd",
      { ProgramFiles: pf, ProgramW6432: pf }
    ).split("\r\n");
    expect(text).toContain('set "AS_NODE=%ProgramW6432%\\ArgelanderSpace\\node.exe"');
    // Only %ProgramFiles% set (a 32-bit view has no %ProgramW6432%): that one.
    expect(
      launcherScript({ node: `${pf}\\A\\node.exe`, cli: "C:\\b.js" }, "win32", "C:\\f.cmd", {
        ProgramFiles: pf,
      }).split("\r\n")
    ).toContain('set "AS_NODE=%ProgramFiles%\\A\\node.exe"');
  });

  test("the text the status compares and the install writes depends on the process's variables", () => {
    // The same app, two environments that cover it differently: the texts differ, so a launcher written under one
    // environment reads as `outdated` under the other (cliLauncherStatus compares this text; on Linux the Windows
    // launcher's folder cannot be made, so the comparison itself is not run here).
    const app = {
      node: "C:\\Users\\张三\\AppData\\Roaming\\A\\node.exe",
      cli: "C:\\Users\\张三\\AppData\\Roaming\\A\\bin.js",
    };
    const self = "C:\\Users\\张三\\f.cmd";
    const one = launcherScript(app, "win32", self, { USERPROFILE: "C:\\Users\\张三" });
    const two = launcherScript(app, "win32", self, {
      USERPROFILE: "C:\\Users\\张三",
      APPDATA: "C:\\Users\\张三\\AppData\\Roaming",
    });
    expect(one).toContain('set "AS_NODE=%USERPROFILE%\\AppData\\Roaming\\A\\node.exe"');
    expect(two).toContain('set "AS_NODE=%APPDATA%\\A\\node.exe"');
    expect(one).not.toBe(two);
  });

  test("a status for Windows read on another system's paths only reads (nothing there: not_installed)", () => {
    const home = tempHome();
    const localDir = join(home, "Local");
    const winEnv = { LOCALAPPDATA: localDir, PATH: "" };
    const app = { node: join(localDir, "A", "node.exe"), cli: join(localDir, "A", "bin.js") };
    expect(cliLauncherStatus(app, { platform: "win32", home, env: winEnv }).state).toBe(
      "not_installed"
    );
  });
});

describe("the AppImage offers no command-line tool (desktop-app ticket 26)", () => {
  const mount = "/tmp/.mount_ArgelaB3xQ9z";
  const inside = {
    node: `${mount}/usr/lib/argelanderspace/sidecar/node/bin/node`,
    cli: `${mount}/usr/lib/argelanderspace/sidecar/app/dist/bin.js`,
  };

  test("the CLI running from the AppImage's own folder (APPDIR) is the AppImage", () => {
    // The AppImage runtime sets APPIMAGE and APPDIR; the AppRun hook sets APPDIR for an extracted one too.
    expect(cliLauncherUnavailable(inside, { APPIMAGE: "/home/u/A.AppImage", APPDIR: mount })).toBe(
      "appimage"
    );
    expect(cliLauncherUnavailable(inside, { APPDIR: `${mount}/` })).toBe("appimage");
  });

  test("APPDIR is compared after resolving it: a doubled slash or a link in TMPDIR still counts", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-launcher-appdir-")));
    made.push(root);
    const real = join(root, "real", ".mount_ArgelaB3xQ9z");
    mkdirSync(join(real, "usr"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const target = {
      node: join(real, "usr", "node"),
      cli: join(real, "usr", "bin.js"),
    };
    expect(
      cliLauncherUnavailable(target, { APPDIR: join(root, "link", ".mount_ArgelaB3xQ9z") })
    ).toBe("appimage");
    expect(cliLauncherUnavailable(target, { APPDIR: `${root}/real//.mount_ArgelaB3xQ9z` })).toBe(
      "appimage"
    );
  });

  test("anything else is not: no APPDIR, a CLI outside it (a variable inherited from another AppImage), a relative one", () => {
    expect(cliLauncherUnavailable(inside, {})).toBeNull();
    expect(cliLauncherUnavailable(inside, { APPIMAGE: "/home/u/A.AppImage" })).toBeNull();
    const deb = {
      node: "/usr/lib/argelanderspace/sidecar/node/bin/node",
      cli: "/usr/lib/argelanderspace/sidecar/app/dist/bin.js",
    };
    expect(cliLauncherUnavailable(deb, { APPIMAGE: "/x.AppImage", APPDIR: mount })).toBeNull();
    // Another folder whose name only begins like it.
    expect(cliLauncherUnavailable(inside, { APPDIR: "/tmp/.mount_Argela" })).toBeNull();
    expect(cliLauncherUnavailable(inside, { APPDIR: "tmp/.mount_ArgelaB3xQ9z" })).toBeNull();
  });
});

/** The cmd metacharacters of an echo line's text that are outside double quotes and not escaped with `^`. */
function unescapedMeta(rest: string): string[] {
  const bad: string[] = [];
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string;
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "^") i++;
    else if ("&|<>()".includes(c)) bad.push(c);
  }
  return bad;
}

/** What cmd's echo shows of a text with no unescaped metacharacter: `^x` outside quotes is `x`. */
function shownByEcho(rest: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string;
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "^") {
      i++;
      out += rest[i] ?? "";
    } else out += c;
  }
  return out;
}

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

  test("an npm install finds dist/skills beside the entry (project-intake ticket 12)", () => {
    const home = tempHome();
    const dist = join(home, "lib", "node_modules", "argelanderspace", "dist");
    mkdirSync(join(dist, "skills"), { recursive: true });
    writeFileSync(join(dist, "skills", "README.md"), "# skills\n");
    expect(bundledSkillsDir(join(dist, "bin.js"))).toBe(join(dist, "skills"));
    // A local install in a project that has its own skills/ gets the package's, never the project's.
    const project = tempHome();
    const local = join(project, "node_modules", "argelanderspace", "dist");
    mkdirSync(join(local, "skills"), { recursive: true });
    writeFileSync(join(local, "skills", "README.md"), "# the package's\n");
    mkdirSync(join(project, "skills"));
    writeFileSync(join(project, "skills", "README.md"), "# the project's own\n");
    expect(bundledSkillsDir(join(local, "bin.js"))).toBe(join(local, "skills"));
  });

  test("dist/skills counts only with its README and only beside a dist/ entry", () => {
    const home = tempHome();
    const dist = join(home, "node_modules", "argelanderspace", "dist");
    mkdirSync(join(dist, "skills"), { recursive: true });
    expect(bundledSkillsDir(join(dist, "bin.js"))).toBeNull();
    writeFileSync(join(dist, "skills", "README.md"), "# skills\n");
    expect(bundledSkillsDir(join(dist, "bin.js"))).toBe(join(dist, "skills"));
    // an entry not in a dist folder does not take a skills/ beside it
    mkdirSync(join(home, "plain", "skills"), { recursive: true });
    writeFileSync(join(home, "plain", "skills", "README.md"), "# x\n");
    expect(bundledSkillsDir(join(home, "plain", "bin.js"))).toBeNull();
  });

  test("none where there is no such folder (an npm install without one, say)", () => {
    const home = tempHome();
    mkdirSync(join(home, "lib", "node_modules", "argelanderspace", "dist"), { recursive: true });
    expect(
      bundledSkillsDir(join(home, "lib", "node_modules", "argelanderspace", "dist", "bin.js"))
    ).toBeNull();
    // A folder named skills without the README is not taken for it.
    mkdirSync(join(home, "skills"));
    expect(bundledSkillsDir(join(home, "a", "b", "c", "bin.js"))).toBeNull();
  });

  test("a project's own skills/README.md is not the application's: a local npm install is not taken for a package (copilot ticket 58)", () => {
    const project = tempHome();
    mkdirSync(join(project, "node_modules", "argelanderspace", "dist"), { recursive: true });
    mkdirSync(join(project, "skills"));
    writeFileSync(join(project, "skills", "README.md"), "# the project's own skills\n");
    expect(
      bundledSkillsDir(join(project, "node_modules", "argelanderspace", "dist", "bin.js"))
    ).toBeNull();
    // the same folder reached from a pnpm-style store path
    mkdirSync(
      join(project, "node_modules", ".pnpm", "x", "node_modules", "argelanderspace", "dist"),
      {
        recursive: true,
      }
    );
    expect(
      bundledSkillsDir(
        join(
          project,
          "node_modules",
          ".pnpm",
          "x",
          "node_modules",
          "argelanderspace",
          "dist",
          "bin.js"
        )
      )
    ).toBeNull();
  });
});

describe("the bundled tutorial sample (in-app-tutorial ticket 15)", () => {
  const MARK = "argelanderspace-tutorial.json";

  /** A sample folder at `dir`, with its marker file unless told otherwise. */
  function sample(dir: string, marked = true): void {
    mkdirSync(dir, { recursive: true });
    if (marked) writeFileSync(join(dir, MARK), "{}\n");
  }

  test("the desktop package: tutorial/ under the resources, beside sidecar/", () => {
    const resources = join(tempHome(), "usr", "lib", "argelanderspace");
    const bin = join(resources, "sidecar", "app", "dist", "bin.js");
    mkdirSync(dirname(bin), { recursive: true });
    sample(join(resources, "tutorial"));
    expect(bundledTutorialDir(bin)).toBe(join(resources, "tutorial"));
    // a dist/tutorial inside the sidecar is not where the package keeps it
    rmSync(join(resources, "tutorial"), { recursive: true });
    sample(join(dirname(bin), "tutorial"));
    expect(bundledTutorialDir(bin)).toBeNull();
  });

  test("the development form (packages/app/dist and packages/cli/dist): dist/tutorial/", () => {
    const repo = tempHome();
    for (const pkg of ["app", "cli"]) {
      const dist = join(repo, "packages", pkg, "dist");
      sample(join(dist, "tutorial"));
      expect(bundledTutorialDir(join(dist, "bin.js"))).toBe(join(dist, "tutorial"));
    }
    // the repository root's tutorial/ is not taken for it
    rmSync(join(repo, "packages", "app", "dist", "tutorial"), { recursive: true });
    sample(join(repo, "tutorial"));
    expect(bundledTutorialDir(join(repo, "packages", "app", "dist", "bin.js"))).toBeNull();
  });

  test("an npm install: dist/tutorial/ beside the CLI", () => {
    const dist = join(tempHome(), "lib", "node_modules", "argelanderspace", "dist");
    sample(join(dist, "tutorial"));
    expect(bundledTutorialDir(join(dist, "bin.js"))).toBe(join(dist, "tutorial"));
  });

  test("none without the marker file, without the folder, or when the marker is a folder", () => {
    const home = tempHome();
    const resources = join(home, "res");
    const packaged = join(resources, "sidecar", "app", "dist", "bin.js");
    mkdirSync(dirname(packaged), { recursive: true });
    expect(bundledTutorialDir(packaged)).toBeNull(); // no folder
    sample(join(resources, "tutorial"), false);
    writeFileSync(join(resources, "tutorial", "NOTICE.md"), "notice\n");
    expect(bundledTutorialDir(packaged)).toBeNull(); // folder, no marker

    const dist = join(home, "repo", "packages", "app", "dist");
    sample(join(dist, "tutorial"), false);
    expect(bundledTutorialDir(join(dist, "bin.js"))).toBeNull();
    mkdirSync(join(dist, "tutorial", MARK));
    expect(bundledTutorialDir(join(dist, "bin.js"))).toBeNull(); // a folder by the marker's name
    // a marker file where the folder should be
    const flat = join(home, "flat", "dist");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "tutorial"), "not a folder\n");
    expect(bundledTutorialDir(join(flat, "bin.js"))).toBeNull();
  });
});
