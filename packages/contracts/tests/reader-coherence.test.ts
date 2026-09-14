import { expect, test } from "vitest";
import { CoherentAnnotationsReadSchema } from "../src/reader-coherence.js";

const response = {
  version: 1,
  ir: {
    version: 1,
    docId: "demo",
    sections: [],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/synthetic", main_tex: "main.tex" },
    meta: { title: "Synthetic", authors: ["Test Author"] },
  },
  file: { version: 1, rev: 0, content_fingerprint: "a".repeat(64), annotations: [] },
  assets: [{ imgPath: "a.svg", sha256: "b".repeat(64) }],
};

test("opt-in contract preserves the actual stored IR fields, not only the DocIr subset", () => {
  expect(CoherentAnnotationsReadSchema.parse(response)).toEqual(response);
});

test("representation requires valid IR, annotations and actual SHA-256 digests", () => {
  for (const bad of [
    { ...response, version: 2 },
    { ...response, ir: { docId: "demo" } },
    { ...response, file: { ...response.file, rev: -1 } },
    { ...response, assets: [{ imgPath: "a.svg", sha256: "random-cache-token" }] },
  ])
    expect(CoherentAnnotationsReadSchema.safeParse(bad).success).toBe(false);
});
