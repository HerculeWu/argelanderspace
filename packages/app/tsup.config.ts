import { defineConfig } from "tsup";

// Decision 22 (single-package bundle): cli + server + core + infra + their
// npm deps are inlined into one ESM file; the workspace packages are
// devDependencies so tsup bundles them instead of externalizing them.
//
// `mupdf` stays external on purpose, twice over:
//  1. its WASM loader resolves `mupdf-wasm.wasm` relative to its own
//     `import.meta.url` — inlining the loader would point that URL at this
//     bundle, where no .wasm sits next to it;
//  2. it is AGPL-3.0 (Artifex) — shipping it as its own npm dependency keeps
//     its code and license out of this MIT-licensed tarball (same shape as
//     the Python original depending on PyMuPDF).
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  external: ["mupdf"],
  // Some CJS deps (safer-buffer via iconv-lite) hide `require("buffer")`
  // from static analysis; give the ESM bundle a real createRequire-based
  // top-level `require` so esbuild's __require shim picks it up instead of
  // its throwing stub (tsup's shims only cover __filename/__dirname).
  shims: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  dts: false,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
