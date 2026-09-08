import { defineConfig } from "tsup";

// Decision 22 (single-package bundle): cli + server + core + infra + their
// npm deps are inlined into one ESM file; the workspace packages are
// devDependencies so tsup bundles them instead of externalizing them.
//
// MS3b: `mupdf` (the old external, kept out twice over for its WASM loader
// and AGPL license) is gone with the deleted raster pipeline. The
// createRequire banner STAYS — removing it was verified to break the bundle:
// `ws` (the WebSocket dep) is CJS and does `require("events")` at runtime,
// which esbuild's throwing `__require` stub rejects without a real
// top-level require. (The original banner comment blamed safer-buffer via
// iconv-lite; the live consumer is `ws`.)
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  shims: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  dts: false,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
