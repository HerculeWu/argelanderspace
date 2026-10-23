import { cliLauncherFile, resolveUserBinDir } from "../src/cli-launcher.js";
import { resolveGlobalDirs } from "../src/global-dirs.js";
import { resolveLogDir } from "../src/log/files.js";
import { resolveRecentProjectsPath } from "../src/recent-projects.js";
import { resolveShelfDir } from "../src/shelf/store.js";
import { resolveTutorialProgressPath } from "../src/tutorial-progress.js";
import { describeUserDirsGuard } from "./user-dirs-guard.js";

describeUserDirsGuard(() => {
  const dirs = resolveGlobalDirs();
  return {
    "global data": dirs.dataDir,
    "global cache": dirs.cacheDir,
    logs: resolveLogDir(),
    "recent projects": resolveRecentProjectsPath(),
    // The tutorial progress (in-app-tutorial ticket 18).
    "tutorial progress": resolveTutorialProgressPath(),
    // The Shelf (shelf ticket 01): no test reads or writes the real one.
    Shelf: resolveShelfDir(),
    // The command-line tool's launcher (desktop-app ticket 24): no test writes a real executable directory.
    "user executables": resolveUserBinDir(),
    "CLI launcher": cliLauncherFile(),
    // On Windows the two above are its own (%LOCALAPPDATA%); written with this machine's separators only there.
    "user executables (macOS)": resolveUserBinDir({ platform: "darwin" }),
  };
});
