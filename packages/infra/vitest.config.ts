import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // env-paths (and its dependency is-safe-filename) fixes homedir at import;
    // inlining lets global-dirs tests re-import it per simulated platform.
    server: { deps: { inline: ["env-paths", "is-safe-filename"] } },
  },
});
