import { resolveGlobalDirs } from "../src/global-dirs.js";
import { describeUserDirsGuard } from "./user-dirs-guard.js";

describeUserDirsGuard(() => {
  const dirs = resolveGlobalDirs();
  return { "global data": dirs.dataDir, "global cache": dirs.cacheDir };
});
