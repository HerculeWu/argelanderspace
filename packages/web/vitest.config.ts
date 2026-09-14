import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: vitest 4 bundles vite 6+ while the
// production build still runs vite 5, so the test runner must not load the
// app's vite config (and needs no react plugin — esbuild handles JSX via the
// tsconfig `jsx: react-jsx` setting).
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
