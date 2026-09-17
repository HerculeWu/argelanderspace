/**
 * Positive/negative coverage of the Stage 14 discovery zod schemas:
 * DiscoveryPaper nullable fields, dual related+useful roles, rank rules,
 * the single citation edge kind, and the version/provider literals.
 */

import { describe, expect, it } from "vitest";
import {
  DiscoveryEdgeSchema,
  DiscoveryGraphSchema,
  DiscoveryPaperSchema,
  DiscoveryWarningSchema,
} from "../src/discovery.js";

const SEED = {
  bibcode: "2023A&A...673A.114H",
  title: "Improving the open cluster census. II.",
  authors: ["Hunt, E. L.", "Reffert, S."],
  year: 2023,
  venue: "A&A",
  abstract: "We present...",
  citationCount: 438,
  doi: "10.1051/0004-6361/202346285",
  arxivId: "2306.12345",
  roles: ["seed"],
  libraryId: null,
};

const RELATED = {
  ...SEED,
  bibcode: "2021A&A...646A.104H",
  roles: ["related"],
  relatedRank: 1,
  libraryId: "doi:10.1051/0004-6361/202039341",
};

const DUAL = {
  ...SEED,
  bibcode: "2020A&A...640A...1C",
  roles: ["related", "useful"],
  relatedRank: 3,
  usefulRank: 2,
};

const USEFUL = {
  ...SEED,
  bibcode: "2023A&A...674A...1G",
  roles: ["useful"],
  usefulRank: 1,
};

const VALID_GRAPH = {
  version: 1,
  provider: "ads",
  seed: SEED.bibcode,
  nodes: [SEED, RELATED, DUAL, USEFUL],
  edges: [
    { from: RELATED.bibcode, to: SEED.bibcode, kind: "citation" },
    { from: USEFUL.bibcode, to: SEED.bibcode, kind: "citation" },
  ],
  warnings: [],
};

describe("DiscoveryPaperSchema", () => {
  it("parses a fully-populated paper", () => {
    expect(DiscoveryPaperSchema.safeParse(RELATED).success).toBe(true);
  });

  it("accepts nullable abstract/year/doi/arxivId and empty authors", () => {
    const p = {
      ...SEED,
      year: null,
      abstract: null,
      doi: null,
      arxivId: null,
      citationCount: null,
      authors: [],
    };
    expect(DiscoveryPaperSchema.safeParse(p).success).toBe(true);
  });

  it("accepts a dual related+useful role with both ranks", () => {
    const r = DiscoveryPaperSchema.safeParse(DUAL);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.roles).toEqual(["related", "useful"]);
      expect(r.data.relatedRank).toBe(3);
      expect(r.data.usefulRank).toBe(2);
    }
  });

  it("rejects non-positive / non-integer ranks", () => {
    expect(DiscoveryPaperSchema.safeParse({ ...RELATED, relatedRank: 0 }).success).toBe(false);
    expect(DiscoveryPaperSchema.safeParse({ ...RELATED, relatedRank: -1 }).success).toBe(false);
    expect(DiscoveryPaperSchema.safeParse({ ...RELATED, relatedRank: 1.5 }).success).toBe(false);
    expect(DiscoveryPaperSchema.safeParse({ ...USEFUL, usefulRank: 0 }).success).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(DiscoveryPaperSchema.safeParse({ ...SEED, roles: ["foundation"] }).success).toBe(false);
  });
});

describe("DiscoveryEdgeSchema", () => {
  it("accepts the only legal kind: citation", () => {
    expect(DiscoveryEdgeSchema.safeParse({ from: "a", to: "b", kind: "citation" }).success).toBe(
      true
    );
  });

  it("rejects similarity / co-citation / recommendation edge kinds", () => {
    for (const kind of ["similarity", "cocitation", "foundation", "recommendation"]) {
      expect(DiscoveryEdgeSchema.safeParse({ from: "a", to: "b", kind }).success).toBe(false);
    }
  });
});

describe("DiscoveryWarningSchema", () => {
  it("accepts useful_unavailable and rejects unknown codes", () => {
    expect(DiscoveryWarningSchema.safeParse({ code: "useful_unavailable" }).success).toBe(true);
    expect(DiscoveryWarningSchema.safeParse({ code: "similar_unavailable" }).success).toBe(false);
  });
});

describe("DiscoveryGraphSchema", () => {
  it("parses a valid graph (seed + related + dual + useful-only)", () => {
    const r = DiscoveryGraphSchema.safeParse(VALID_GRAPH);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodes).toHaveLength(4);
  });

  it("parses a seed-only graph with a warning", () => {
    const g = {
      ...VALID_GRAPH,
      nodes: [SEED],
      edges: [],
      warnings: [{ code: "useful_unavailable" }],
    };
    expect(DiscoveryGraphSchema.safeParse(g).success).toBe(true);
  });

  it("rejects wrong version / provider literals", () => {
    expect(DiscoveryGraphSchema.safeParse({ ...VALID_GRAPH, version: 2 }).success).toBe(false);
    expect(DiscoveryGraphSchema.safeParse({ ...VALID_GRAPH, provider: "openalex" }).success).toBe(
      false
    );
  });
});
