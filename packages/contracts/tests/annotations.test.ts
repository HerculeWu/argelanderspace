/**
 * Positive/negative coverage of the annotation zod schemas (Stage 8 MS1):
 * Annotation id format, body trim rule, the target discriminated union
 * (document / structure+snapshot / text+container), text-range bounds,
 * AnnotationsFile field rules, and the `annotation.changed` WS message
 * (standalone schema + membership in the WsServerMessage union).
 */

import { describe, expect, it } from "vitest";
import {
  AnnotationSchema,
  AnnotationStructureTargetSchema,
  AnnotationsFileSchema,
  AnnotationTargetSchema,
  AnnotationTextTargetSchema,
  WsAnnotationChangedSchema,
} from "../src/annotations.js";
import { WsServerMessageSchema } from "../src/jobs.js";

const DOCUMENT_TARGET = { type: "document" } as const;

const STRUCTURE_TARGET = {
  type: "structure",
  id: "fig-2",
  kind: "figure",
  snapshot: { number: "2", label: "fig:rar", caption: "The RAR.", asset_hash: "deadbeef" },
} as const;

const TEXT_TARGET = {
  type: "text",
  block: "p-3",
  container: { type: "list_item", index: 1 },
  start: 2,
  end: 9,
  quote: "ntext o",
} as const;

const VALID_ANNOTATION = {
  id: "a_0123abcd",
  target: TEXT_TARGET,
  body: "这里 $E=mc^2$ 的推导跳了一步",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};

const VALID_FILE = {
  version: 1,
  rev: 3,
  content_fingerprint: "9f2c1a7e4b8d03f6a5c2e91b7d4f6083a1c5e7b9d2f406183a5c7e9b1d3f50729",
  annotations: [VALID_ANNOTATION],
};

describe("AnnotationSchema", () => {
  it("parses an annotation for each target type", () => {
    for (const target of [DOCUMENT_TARGET, STRUCTURE_TARGET, TEXT_TARGET]) {
      expect(AnnotationSchema.safeParse({ ...VALID_ANNOTATION, target }).success).toBe(true);
    }
  });

  it("rejects malformed ids (prefix, length, non-hex, uppercase)", () => {
    for (const id of ["a_0123abc", "a_0123abcde", "a_0123abcg", "a_0123ABCD", "b_0123abcd", "a_"]) {
      expect(AnnotationSchema.safeParse({ ...VALID_ANNOTATION, id }).success).toBe(false);
    }
  });

  it("rejects a trim-empty body but stores raw bytes (no trimming)", () => {
    for (const body of ["", "   ", "\n\t "]) {
      expect(AnnotationSchema.safeParse({ ...VALID_ANNOTATION, body }).success).toBe(false);
    }
    const padded = AnnotationSchema.safeParse({ ...VALID_ANNOTATION, body: "  保留空白  \n" });
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.body).toBe("  保留空白  \n");
  });

  it("rejects non-ISO timestamps", () => {
    expect(
      AnnotationSchema.safeParse({ ...VALID_ANNOTATION, created_at: "2026-09-10" }).success
    ).toBe(false);
    expect(AnnotationSchema.safeParse({ ...VALID_ANNOTATION, updated_at: "now" }).success).toBe(
      false
    );
  });
});

describe("target union", () => {
  it("discriminates on type and rejects unknown discriminators", () => {
    expect(AnnotationTargetSchema.safeParse({ type: "block", id: "p-1" }).success).toBe(false);
    expect(AnnotationTargetSchema.safeParse({}).success).toBe(false);
  });

  it("document target takes no extra requirement", () => {
    expect(AnnotationTargetSchema.safeParse({ type: "document" }).success).toBe(true);
  });

  it("structure target accepts every kind of the closed enum, rejects others", () => {
    for (const kind of [
      "section",
      "paragraph",
      "list",
      "equation",
      "figure",
      "table",
      "code",
      "algorithm",
    ]) {
      const t = { type: "structure", id: "x-1", kind, snapshot: {} };
      expect(AnnotationTargetSchema.safeParse(t).success).toBe(true);
    }
    for (const kind of ["block", "reference", ""]) {
      const t = { type: "structure", id: "x-1", kind, snapshot: {} };
      expect(AnnotationTargetSchema.safeParse(t).success).toBe(false);
    }
  });

  it("structure target requires id and snapshot", () => {
    const { id: _i, ...noId } = STRUCTURE_TARGET;
    const { snapshot: _s, ...noSnap } = STRUCTURE_TARGET;
    expect(AnnotationStructureTargetSchema.safeParse(noId).success).toBe(false);
    expect(AnnotationStructureTargetSchema.safeParse(noSnap).success).toBe(false);
    expect(AnnotationStructureTargetSchema.safeParse({ ...STRUCTURE_TARGET, id: "" }).success).toBe(
      false
    );
  });

  it("snapshot is one all-optional object covering every kind's fields", () => {
    const full = {
      number: "3.2",
      heading: "结果",
      text: "段落正文",
      ordered: true,
      items: ["a", "b"],
      label: "eq:x",
      latex: "E=mc^2",
      caption: "图注",
      footnote: "注",
      asset_hash: "ab12",
      table_body: "<tr>…</tr>",
      lang: "python",
      body: "algorithm body",
    };
    const t = { type: "structure", id: "tab-1", kind: "table", snapshot: full };
    expect(AnnotationStructureTargetSchema.safeParse(t).success).toBe(true);
    // and the empty snapshot is legal (fields are filled per kind by writers)
    expect(
      AnnotationStructureTargetSchema.safeParse({
        type: "structure",
        id: "sec-1",
        kind: "section",
        snapshot: {},
      }).success
    ).toBe(true);
    // wrong field types are still rejected
    expect(
      AnnotationStructureTargetSchema.safeParse({
        type: "structure",
        id: "x",
        kind: "list",
        snapshot: { items: "not-an-array" },
      }).success
    ).toBe(false);
  });

  it("text target accepts all three container kinds", () => {
    for (const container of [
      { type: "content" },
      { type: "caption" },
      { type: "list_item", index: 0 },
    ]) {
      const t = { ...TEXT_TARGET, container };
      expect(AnnotationTextTargetSchema.safeParse(t).success).toBe(true);
    }
  });

  it("list_item index must be an int ≥ 0", () => {
    for (const index of [-1, 1.5, "1", Number.NaN]) {
      const t = { ...TEXT_TARGET, container: { type: "list_item", index } };
      expect(AnnotationTextTargetSchema.safeParse(t).success).toBe(false);
    }
  });

  it("text range requires int start ≥ 0 and end > start", () => {
    expect(AnnotationTextTargetSchema.safeParse({ ...TEXT_TARGET, start: -1 }).success).toBe(false);
    expect(AnnotationTextTargetSchema.safeParse({ ...TEXT_TARGET, start: 0.5 }).success).toBe(
      false
    );
    expect(AnnotationTextTargetSchema.safeParse({ ...TEXT_TARGET, start: 5, end: 5 }).success).toBe(
      false
    );
    expect(AnnotationTextTargetSchema.safeParse({ ...TEXT_TARGET, start: 5, end: 4 }).success).toBe(
      false
    );
    expect(AnnotationTextTargetSchema.safeParse({ ...TEXT_TARGET, start: 0, end: 1 }).success).toBe(
      true
    );
  });

  it("text target requires block and quote", () => {
    const { block: _b, ...noBlock } = TEXT_TARGET;
    const { quote: _q, ...noQuote } = TEXT_TARGET;
    expect(AnnotationTextTargetSchema.safeParse(noBlock).success).toBe(false);
    expect(AnnotationTextTargetSchema.safeParse(noQuote).success).toBe(false);
  });
});

describe("AnnotationsFileSchema", () => {
  it("parses the empty epoch document and a full file", () => {
    expect(
      AnnotationsFileSchema.safeParse({
        version: 1,
        rev: 0,
        content_fingerprint: "ab",
        annotations: [],
      }).success
    ).toBe(true);
    expect(AnnotationsFileSchema.safeParse(VALID_FILE).success).toBe(true);
  });

  it("rejects a wrong version literal", () => {
    for (const version of [2, "1", 0]) {
      expect(AnnotationsFileSchema.safeParse({ ...VALID_FILE, version }).success).toBe(false);
    }
  });

  it("rejects a negative or non-integer rev", () => {
    for (const rev of [-1, 1.5, "3"]) {
      expect(AnnotationsFileSchema.safeParse({ ...VALID_FILE, rev }).success).toBe(false);
    }
  });

  it("requires version / rev / content_fingerprint / annotations", () => {
    for (const key of ["version", "rev", "content_fingerprint", "annotations"]) {
      const partial: Record<string, unknown> = { ...VALID_FILE };
      delete partial[key];
      expect(AnnotationsFileSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("rejects an embedded invalid annotation", () => {
    const bad = { ...VALID_FILE, annotations: [{ ...VALID_ANNOTATION, body: "  " }] };
    expect(AnnotationsFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("WsAnnotationChangedSchema", () => {
  const bare = {
    type: "annotation.changed",
    doc_id: "arxiv-2501.17225",
    at: "2026-09-10T10:00:00.000Z",
  };

  it("parses with and without cause", () => {
    expect(WsAnnotationChangedSchema.safeParse(bare).success).toBe(true);
    for (const cause of ["put", "invalidate", "external"]) {
      expect(WsAnnotationChangedSchema.safeParse({ ...bare, cause }).success).toBe(true);
    }
  });

  it("rejects an unknown cause, missing doc_id/at, or an empty doc_id", () => {
    expect(WsAnnotationChangedSchema.safeParse({ ...bare, cause: "patch" }).success).toBe(false);
    expect(
      WsAnnotationChangedSchema.safeParse({ type: "annotation.changed", at: bare.at }).success
    ).toBe(false);
    expect(
      WsAnnotationChangedSchema.safeParse({ type: "annotation.changed", doc_id: bare.doc_id })
        .success
    ).toBe(false);
    expect(WsAnnotationChangedSchema.safeParse({ ...bare, doc_id: "" }).success).toBe(false);
  });

  it("is a member of the WsServerMessage union (plan.changed still parses)", () => {
    const parsed = WsServerMessageSchema.safeParse({ ...bare, cause: "invalidate" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("annotation.changed");
      if (parsed.data.type === "annotation.changed") {
        expect(parsed.data.doc_id).toBe("arxiv-2501.17225");
      }
    }
    const planMsg = { type: "plan.changed", cause: "put", at: "2026-09-10T10:00:00.000Z" };
    expect(WsServerMessageSchema.safeParse(planMsg).success).toBe(true);
  });
});
