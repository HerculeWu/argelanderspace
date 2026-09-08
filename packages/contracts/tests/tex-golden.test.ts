/**
 * Golden acceptance for the Stage 5 tex goldens: `tests/golden/tex/arxiv-*.json`
 * must validate against the TexDocIr zod schema, plus negative cases.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocIrSchema } from "../src/doc-ir.js";
import { TexDocIrSchema } from "../src/tex-ir.js";

// packages/contracts/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = `${REPO_ROOT}/tests/golden/tex`;

const goldens = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("TexDocIrSchema vs frozen tex goldens", () => {
  it("finds the two golden papers", () => {
    expect(goldens).toEqual(["arxiv-2012.05220.json", "arxiv-2501.17225.json"]);
  });

  for (const file of goldens) {
    it(`parses ${file}`, () => {
      const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}/${file}`, "utf8"));
      const result = TexDocIrSchema.safeParse(raw);
      if (!result.success) {
        expect.unreachable(`schema rejected ${file}: ${result.error.message}`);
      }
      expect(result.data.version).toBe(1);
      expect(result.data.source.type).toBe("latex");
      expect(result.data.source.main_tex.length).toBeGreaterThan(0);
    });

    it(`${file} also satisfies the DocIr base shape (web-consumable)`, () => {
      const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}/${file}`, "utf8"));
      expect(DocIrSchema.safeParse(raw).success).toBe(true);
    });
  }

  it("rejects a wrong version", () => {
    const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}/arxiv-2501.17225.json`, "utf8"));
    expect(TexDocIrSchema.safeParse({ ...raw, version: 2 }).success).toBe(false);
  });

  it("rejects a missing source block", () => {
    const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}/arxiv-2501.17225.json`, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.source;
    expect(TexDocIrSchema.safeParse(raw).success).toBe(false);
  });
});
