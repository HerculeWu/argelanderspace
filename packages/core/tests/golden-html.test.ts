/**
 * M3c golden gate: the TS publisher-HTML pipeline must reproduce the frozen
 * Python outputs in `<repo>/tests/golden/` field-for-field.
 *
 * For each archived doc the test runs core's `ingestHtml` fully offline (the
 * fixture page cache under `tests/fixtures/htmlcache/`, real pandoc on PATH,
 * placeholder asset downloads — see `tests/helpers/html-ports.ts`), parses the
 * emitted `<doc_id>.json`, and diffs it against the golden file recursively,
 * printing the first N divergence paths on failure.
 *
 * Baseline pre-verification (2026-08-26, astro env): the Python pipeline
 * re-run offline from the same cache reproduces both goldens with 0 diffs, so
 * any divergence here is a TS-port artifact, not environment drift.
 *
 * Allowlist policy: strict deep equality after JSON parse; any intentional
 * exemption must be an explicit per-path entry in {@link GOLDEN_ALLOWLIST}
 * with a one-line justification. `source.path` is the publisher URL (not a
 * local path), `img_path` values are deterministic URL-derived basenames, and
 * no fetch timestamps are recorded — nothing here is non-deterministic
 * offline.
 *
 * Current allowlist: EMPTY.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ingestHtml } from "../src/pipelines/html/pipeline.js";
import { diffJson, type Json } from "./helpers/diff-json.js";
import { HAVE_PANDOC, testHtmlFetcher, testMathml } from "./helpers/html-ports.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");
const MANIFEST = JSON.parse(
  readFileSync(
    join(fileURLToPath(new URL("./fixtures", import.meta.url)), "htmlcache", "manifest.json"),
    "utf-8"
  )
) as { docs: Array<{ doc_id: string; source: string; golden: string }> };

/** How many divergence paths the reporter prints before truncating. */
const MAX_REPORTED_DIFFS = 50;

/**
 * Intentional golden divergences, per path prefix, each with a justification.
 * EMPTY by design (see the header comment).
 */
const GOLDEN_ALLOWLIST: ReadonlyArray<{ pathPrefix: string; why: string }> = [];

function allowlisted(path: string): boolean {
  return GOLDEN_ALLOWLIST.some((e) => path.startsWith(e.pathPrefix));
}

describe.skipIf(!HAVE_PANDOC)("golden-html: TS pipeline vs frozen Python output", () => {
  for (const entry of MANIFEST.docs) {
    test(`${entry.doc_id}: 0 field diffs`, async () => {
      const outRoot = mkdtempSync(join(tmpdir(), `golden-html-${entry.doc_id}-`));
      const doc = await ingestHtml(
        entry.source,
        { fetcher: testHtmlFetcher, mathml: testMathml },
        { outRoot }
      );
      expect(doc.doc_id).toBe(entry.doc_id);
      // Compare the *written* file so JSON serialization is covered too.
      const emitted = JSON.parse(
        readFileSync(join(outRoot, doc.doc_id, `${doc.doc_id}.json`), "utf-8")
      ) as Json;
      const golden = JSON.parse(
        readFileSync(join(GOLDEN_DIR, `${entry.doc_id}.json`), "utf-8")
      ) as Json;
      const diffs = diffJson(emitted, golden).filter((d) => !allowlisted(d.split(" — ")[0] ?? ""));
      const report = diffs.slice(0, MAX_REPORTED_DIFFS).join("\n");
      expect(
        diffs.length,
        `${diffs.length} field diffs vs golden (first ${Math.min(diffs.length, MAX_REPORTED_DIFFS)}):\n${report}`
      ).toBe(0);
    }, 120_000);
  }
});
