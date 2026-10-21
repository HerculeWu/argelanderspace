#!/usr/bin/env node
// Makes the regenerable parts of the tutorial sample (in-app-tutorial ticket 16). Run by hand by the sample's maker,
// after `corepack pnpm -r build`; NOT part of `pnpm -r test` (it downloads from arXiv, `regenerate` needs TeX, `cache`
// needs the maker's ADS token). Its rules live in tutorial-sample-lib.mjs, tested by tutorial-sample.test.mjs.
//
//   node packages/app/scripts/tutorial-sample.mjs <regenerate|cache|assets> [--sample-dir <dir>]
//
//   regenerate  re-ingest the pinned e-print 2103.12080v1 (TeX Live needed); only the IR and assets/ go into the
//               sample; the preset annotations' fingerprint is recomputed and every target and argument source anchor
//               is checked against the new IR, the Jerabkova Work against the Doc and its title.
//   cache       the three pinned ADS discovery entries of the Röser seed, without abstracts. The token is the one
//               saved in the workbench (the credential store, purpose `ads`); it is never printed or written.
//   assets      the pinned e-print 2202.06973v1 repacked, unchanged, as tutorial-assets/evans-oh-2022-source.zip.
//
// --sample-dir defaults to tutorial-sample/ at the repository root. Each run is all or nothing: on any failure the
// sample is left byte for byte as it was (exit 1; the failed checks are printed one per line); on success the marker's
// `sample` goes up by one. The sample's total size is printed at the end; over 100 MB nothing is written (exit 3).
// Hand edits of the sample's frozen files never go through here and never change `sample`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestTexSource, readAdsToken } from "../../infra/dist/index.js";
import { EXIT, runSampleCommand } from "./tutorial-sample-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
let sampleDir = resolve(repoRoot, "tutorial-sample");
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--sample-dir" && args[i + 1]) sampleDir = resolve(args[++i]);
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(EXIT.usage);
  }
}

const result = await runSampleCommand(command, sampleDir, {
  fetchImpl: fetch,
  ingest: (source, { outRoot, docId, fetchImpl }) =>
    ingestTexSource(source, {
      outRoot,
      docId,
      noCache: true,
      fetchImpl,
      onProgress: (m) => console.log(`  ${m}`),
    }),
  readToken: () => readAdsToken(),
});
process.exitCode = result.code;
