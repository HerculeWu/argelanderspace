import { defineConfig } from "vitest/config";

// Tests, and the CLI processes they spawn from their own environment, never resolve the real per-user directories:
// see packages/infra/tests/isolate-user-dirs.ts.
export default defineConfig({
  test: {
    setupFiles: ["../infra/tests/isolate-user-dirs.ts", "../infra/tests/track-temp-dirs.ts"],
    globalSetup: ["../infra/tests/global-temp-dir.ts"],
    // Almost every case starts a CLI process (node boot plus the program's own imports). Under a loaded parallel run
    // that passes the 5s default without anything being wrong; a hung process still fails at this limit.
    testTimeout: 30_000,
  },
});
