import { resolveGlobalDirs } from "@argelanderspace/infra";
import { describeUserDirsGuard } from "../../infra/tests/user-dirs-guard.js";

describeUserDirsGuard(() => {
  const dirs = resolveGlobalDirs();
  return { "global data": dirs.dataDir, "global cache": dirs.cacheDir };
});
