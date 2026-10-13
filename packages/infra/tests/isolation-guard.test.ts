import { resolveGlobalDirs } from "../src/global-dirs.js";
import { resolveLogDir } from "../src/log/files.js";
import { describeUserDirsGuard } from "./user-dirs-guard.js";

describeUserDirsGuard(() => {
  const dirs = resolveGlobalDirs();
  return { "global data": dirs.dataDir, "global cache": dirs.cacheDir, logs: resolveLogDir() };
});
