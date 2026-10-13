import { DEFAULT_PORT } from "@argelanderspace/contracts";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Dev server proxies API + image + WebSocket requests to the ArgelanderSpace
// server on its default port, so the frontend can use same-origin paths
// (/api/..., /images/..., /ws) and the exact same code works when the server
// hosts the production build. A server started on another port (`--port`, or
// `port` in config.toml) is not reached by this proxy.
const backend = `http://localhost:${DEFAULT_PORT}`;
export default defineConfig({
  plugins: [react(), {
    name: "adopted-icon-notices",
    generateBundle() {
      for (const [fileName, source] of [
        ["THIRD_PARTY_LICENSES.md", new URL("../../THIRD_PARTY_LICENSES.md", import.meta.url)],
        ["icons.provenance.json", new URL("./src/ui/icons.provenance.json", import.meta.url)],
      ] as const) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(source, "utf8") });
      }
    },
  }],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": backend,
      "/images": backend,
      "/ws": { target: backend, ws: true },
    },
  },
});
