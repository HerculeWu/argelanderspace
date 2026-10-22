import { defineConfig } from "vitest/config";

// Temporary directories the tests make under the system temp directory are removed when each file has run:
// see packages/infra/tests/track-temp-dirs.ts.
export default defineConfig({
  test: {
    globalSetup: ["../infra/tests/global-temp-dir.ts"],
    setupFiles: ["../infra/tests/track-temp-dirs.ts"],
  },
});
