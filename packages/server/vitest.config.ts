import { defineConfig } from "vitest/config";

// Server tests never touch the machine's real per-user directories, global data included: the first setup file points
// the home directory at a throwaway one before anything else is imported (packages/infra/tests/isolate-user-dirs.ts).
// The second removes the temporary directories each test file makes (and global-temp-dir.ts sweeps the run's own
// temporary directory at the end). The third makes a Copilot host built without its own account probe see no mail accounts.
export default defineConfig({
  test: {
    globalSetup: ["../infra/tests/global-temp-dir.ts"],
    setupFiles: [
      "../infra/tests/isolate-user-dirs.ts",
      "../infra/tests/track-temp-dirs.ts",
      "./tests/setup-isolation.ts",
    ],
  },
});
