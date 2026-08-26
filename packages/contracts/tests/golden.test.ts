/**
 * Golden acceptance: the 6 frozen Python-pipeline outputs in
 * `<repo>/tests/golden/` must all validate against the Document zod schema
 * (M0 acceptance gate), plus a few negative cases.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentSchema } from "../src/document.js";

// packages/contracts/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = `${REPO_ROOT}/tests/golden`;

interface ManifestEntry {
  doc_id: string;
  pipeline: string;
  stats: Record<string, number>;
}

const manifest = JSON.parse(readFileSync(`${GOLDEN_DIR}/manifest.json`, "utf8")) as {
  papers: ManifestEntry[];
};

function loadGolden(docId: string): unknown {
  return JSON.parse(readFileSync(`${GOLDEN_DIR}/${docId}.json`, "utf8"));
}

describe("DocumentSchema vs golden pipeline outputs", () => {
  it("manifest lists exactly the 6 golden papers", () => {
    expect(manifest.papers).toHaveLength(6);
  });

  for (const entry of manifest.papers) {
    it(`parses ${entry.doc_id} (${entry.pipeline} pipeline)`, () => {
      const raw = loadGolden(entry.doc_id);
      const result = DocumentSchema.safeParse(raw);
      if (!result.success) {
        // Surface a readable diff instead of a bare assertion failure.
        expect.unreachable(`schema rejected ${entry.doc_id}: ${result.error.message}`);
      }
      expect(result.data.doc_id).toBe(entry.doc_id);
    });

    it(`preserves ${entry.doc_id} stats (manifest cross-check)`, () => {
      const doc = DocumentSchema.parse(loadGolden(entry.doc_id));
      for (const [key, value] of Object.entries(entry.stats)) {
        expect(doc.stats?.[key as keyof typeof doc.stats]).toBe(value);
      }
    });
  }
});

describe("DocumentSchema negative cases", () => {
  it("rejects a document without doc_id", () => {
    const doc = { ...(loadGolden("aa39341-20") as Record<string, unknown>) };
    delete doc.doc_id;
    expect(DocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects an unknown block type", () => {
    const doc = DocumentSchema.parse(loadGolden("aa39341-20"));
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
