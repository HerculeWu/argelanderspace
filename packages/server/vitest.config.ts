import { defineConfig } from "vitest/config";

// Server tests never touch the machine's real per-user directories, global data included: the first setup file points
// the home directory at a throwaway one before anything else is imported (packages/infra/tests/isolate-user-dirs.ts).
// The second makes a Copilot host built without its own account probe see no mail accounts.
export default defineConfig({
  test: { setupFiles: ["../infra/tests/isolate-user-dirs.ts", "./tests/setup-isolation.ts"] },
});
