import { defineConfig } from "vitest/config";

// Tests, and the CLI processes they spawn from their own environment, never resolve the real per-user directories:
// see packages/infra/tests/isolate-user-dirs.ts.
export default defineConfig({
  test: { setupFiles: ["../infra/tests/isolate-user-dirs.ts"] },
});
