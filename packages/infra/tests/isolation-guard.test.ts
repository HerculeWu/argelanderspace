import { cliLauncherFile, resolveUserBinDir } from "../src/cli-launcher.js";
import { resolveGlobalDirs } from "../src/global-dirs.js";
import { resolveLogDir } from "../src/log/files.js";
import { resolveRecentProjectsPath } from "../src/recent-projects.js";
import { describeUserDirsGuard } from "./user-dirs-guard.js";

describeUserDirsGuard(() => {
  const dirs = resolveGlobalDirs();
  return {
    "global data": dirs.dataDir,
    "global cache": dirs.cacheDir,
    logs: resolveLogDir(),
    "recent projects": resolveRecentProjectsPath(),
    // The command-line tool's launcher (desktop-app ticket 24): no test writes a real executable directory.
    "user executables": resolveUserBinDir(),
    "CLI launcher": cliLauncherFile(),
    // On Windows the two above are its own (%LOCALAPPDATA%); written with this machine's separators only there.
    "user executables (macOS)": resolveUserBinDir({ platform: "darwin" }),
  };
});
