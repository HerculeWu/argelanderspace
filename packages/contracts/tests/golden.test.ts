/**
 * DocumentSchema unit tests (the retired Document JSON shape, kept for the
 * MS4-bridge fallback): structural negative cases. The golden-file
 * acceptance half left with the retired `tests/golden/arxiv-*.json` in MS3b;
 * the new stored-IR goldens are validated in `tex-golden.test.ts`.
 *
 * The two retired-shape golden Documents now live as the MS4-bridge fixtures
 * `packages/core/tests/fixtures/document-arxiv-*.json`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentSchema } from "../src/document.js";

// packages/contracts/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BRIDGE = `${REPO_ROOT}/packages/core/tests/fixtures/document-arxiv-2501.17225.json`;

function loadBridge(): unknown {
  return JSON.parse(readFileSync(BRIDGE, "utf8"));
}

describe("DocumentSchema", () => {
  it("still parses the MS4-bridge Document fixture", () => {
    const result = DocumentSchema.safeParse(loadBridge());
    if (!result.success) {
      expect.unreachable(`schema rejected the bridge fixture: ${result.error.message}`);
    }
    expect(result.data.doc_id).toBe("arxiv-2501.17225");
  });

  it("rejects a document without doc_id", () => {
    const doc = { ...(loadBridge() as Record<string, unknown>) };
    delete doc.doc_id;
    expect(DocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects an unknown block type", () => {
    const doc = DocumentSchema.parse(loadBridge());
    const section = doc.structure?.find((s) => s.blocks?.length);
    expect(section).toBeDefined();
    const bad = {
      ...doc,
      structure: [
        {
          ...section,
          blocks: [{ id: "x-1", type: "video", page_idx: 0 }],
        },
      ],
    };
    expect(DocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a paragraph block without text", () => {
    const bad = {
      doc_id: "neg-case",
      structure: [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          blocks: [{ id: "p-1", type: "paragraph" }],
        },
      ],
    };
    expect(DocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a citation with an unknown `via`", () => {
    const bad = {
      doc_id: "neg-case",
      citations: [{ raw: "(X 2020)", via: "smoke-signals", resolved: true }],
    };
    expect(DocumentSchema.safeParse(bad).success).toBe(false);
  });
});
