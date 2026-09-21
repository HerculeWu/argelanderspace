import { arxivDocId, normArxiv, uploadDocId } from "@argelanderspace/core";
import { describe, expect, it } from "vitest";
import {
  arxivAcquisitionDocId,
  uploadAcquisitionDocId,
} from "../src/library/acquisitionTargets";

describe("manual acquisition target parity", () => {
  it.each([
    [" arXiv:2609.17036V12 ", "arxiv-2609.17036"],
    ["astro-ph/9901234v2", "arxiv-astro-ph-9901234"],
    ["ARXIV:Math.GT/0309136V3", "arxiv-math.gt-0309136"],
  ])("matches the core normalized arXiv target for %s", (input, literal) => {
    const normalized = normArxiv(input);
    expect(normalized).not.toBeNull();
    expect(arxivAcquisitionDocId(input)).toBe(literal);
    expect(arxivAcquisitionDocId(input)).toBe(arxivDocId(normalized as string));
  });

  it.each([
    ["DOI:10.1234/Example.Mixed", "upload-doi-10-1234-example-mixed-aa205f"],
    [
      `work:${"A".repeat(60)}`,
      "upload-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-f254e6",
    ],
    ["论文/恒星", "upload-work-d46d51"],
    ["arxiv:ASTRO-PH/9901234", "upload-arxiv-astro-ph-9901234-e7cbcb"],
  ])("matches the core upload target for %s", async (workId, literal) => {
    expect(await uploadAcquisitionDocId(workId)).toBe(literal);
    expect(await uploadAcquisitionDocId(workId)).toBe(uploadDocId(workId));
  });
});
