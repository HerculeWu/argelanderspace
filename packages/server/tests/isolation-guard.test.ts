import {
  cliLauncherFile,
  resolveGlobalDirs,
  resolveLogDir,
  resolveRecentProjectsPath,
  resolveShelfDir,
  resolveTutorialProgressPath,
  resolveUserBinDir,
} from "@argelanderspace/infra";
import { describeUserDirsGuard } from "../../infra/tests/user-dirs-guard.js";

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
