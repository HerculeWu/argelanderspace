/**
 * M3a golden gate: the TS LaTeX pipeline must reproduce the frozen Python
 * outputs in `<repo>/tests/golden/` field-for-field.
 *
 * For each cached arXiv source the test runs core's `ingestLatex` fully offline
 * (fixture source trees under `tests/fixtures/latex/`, real pandoc on PATH,
 * placeholder rasterization — see `tests/helpers/latex-ports.ts`), parses the
 * emitted `<doc_id>.json`, and diffs it against the golden file recursively,
 * printing the first N divergence paths on failure.
 *
 * Allowlist policy: the default is strict deep equality after JSON parse. Any
 * intentional exemption must be an explicit, per-path entry in
 * {@link GOLDEN_ALLOWLIST} below with a one-line justification. `img_path`
 * values are deterministic `stem__ext.png` encodings of the source path (no
 * content hashes), so they are compared strictly like everything else.
 *
 * Current allowlist: EMPTY — both papers diff clean, zero exemptions.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ingestLatex } from "../src/pipelines/latex/pipeline.js";
import { HAVE_PANDOC, testAcquire, testPandoc, testRaster } from "./helpers/latex-ports.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");

/** The two arXiv papers with frozen LaTeX-pipeline goldens. */
const PAPERS = ["2501.17225", "2012.05220"] as const;

/** How many divergence paths the reporter prints before truncating. */
const MAX_REPORTED_DIFFS = 50;

/**
 * Intentional golden divergences, per path prefix, each with a justification.
 * EMPTY by design: nothing about this pipeline's JSON is non-deterministic
 * offline (source.path is the arXiv e-print URL, not a local path; the JSON is
 * written before meta.output_path is set, so no absolute paths leak in).
 */
const GOLDEN_ALLOWLIST: ReadonlyArray<{ pathPrefix: string; why: string }> = [];

// --------------------------------------------------------------------------- //
// recursive field-by-field diff
// --------------------------------------------------------------------------- //

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: Json): v is { [k: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Collect human-readable paths where `got` and `want` diverge (in-order). */
export function diffJson(got: Json, want: Json, path = "$", out: string[] = []): string[] {
  if (isObj(got) && isObj(want)) {
    for (const k of Object.keys(want)) {
      const w = want[k] as Json;
      if (!(k in got)) {
        out.push(`${path}.${k} — missing in emitted (golden: ${preview(w)})`);
      } else {
        diffJson(got[k] as Json, w, `${path}.${k}`, out);
      }
    }
    for (const k of Object.keys(got)) {
      if (!(k in want)) {
        out.push(`${path}.${k} — extra in emitted (${preview(got[k] as Json)})`);
      }
    }
    return out;
  }
  if (Array.isArray(got) && Array.isArray(want)) {
    if (got.length !== want.length) {
      out.push(`${path} — array length ${got.length} != golden ${want.length}`);
    }
    for (let i = 0; i < Math.min(got.length, want.length); i++) {
      diffJson(got[i] as Json, want[i] as Json, `${path}[${i}]`, out);
    }
    return out;
  }
  if (got !== want) {
    out.push(`${path} — ${preview(got)} != golden ${preview(want)}`);
  }
  return out;
}

function preview(v: Json): string {
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

function allowlisted(path: string): boolean {
  return GOLDEN_ALLOWLIST.some((e) => path.startsWith(e.pathPrefix));
}

// --------------------------------------------------------------------------- //
// the gate
// --------------------------------------------------------------------------- //

describe.skipIf(!HAVE_PANDOC)("golden-latex: TS pipeline vs frozen Python output", () => {
  for (const arx of PAPERS) {
    test(`arxiv-${arx}: 0 field diffs`, async () => {
      const outRoot = mkdtempSync(join(tmpdir(), `golden-latex-${arx}-`));
      const doc = await ingestLatex(
        arx,
        { pandoc: testPandoc, acquire: testAcquire, raster: testRaster },
        { outRoot }
      );
      // Compare the *written* file so JSON serialization is covered too.
      const emitted = JSON.parse(
        readFileSync(join(outRoot, doc.doc_id, `${doc.doc_id}.json`), "utf-8")
      ) as Json;
      const golden = JSON.parse(
        readFileSync(join(GOLDEN_DIR, `${doc.doc_id}.json`), "utf-8")
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
