import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + image requests to the FastAPI backend on :8000,
// so the frontend can use same-origin paths (/api/..., /images/...) and the
// exact same code works when FastAPI serves the production build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8000",
      "/images": "http://localhost:8000",
    },
  },
});
