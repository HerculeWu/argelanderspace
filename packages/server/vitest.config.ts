import { defineConfig } from "vitest/config";

// Server tests never touch the machine's real global data: the global dirs point at a throwaway directory, and a
// Copilot host built without its own account probe sees no mail accounts (tests/setup-isolation.ts).
export default defineConfig({
  test: { setupFiles: ["./tests/setup-isolation.ts"] },
});
