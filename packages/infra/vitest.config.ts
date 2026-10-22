import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never resolve the real per-user directories: see tests/isolate-user-dirs.ts.
    globalSetup: ["./tests/global-temp-dir.ts"],
    setupFiles: ["./tests/isolate-user-dirs.ts", "./tests/track-temp-dirs.ts"],
    // env-paths (and its dependency is-safe-filename) fixes homedir at import;
    // inlining lets global-dirs tests re-import it per simulated platform.
    server: { deps: { inline: ["env-paths", "is-safe-filename"] } },
  },
});
