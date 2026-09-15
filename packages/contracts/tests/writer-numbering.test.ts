/**
 * Writer numbering fusion (Stage 10 M3, D14): the event/aux fixtures below
 * are the REAL output of a single-pass pdflatex + argelander.sty probe
 * (2026-09-15, session inbox F5) — report class, so numbers are chapter-wise
 * (1.1, 1.2…). Cell attribution comes from the assembly line map.
 */

import { describe, expect, it } from "vitest";
import {
  fuseNumberingEvents,
  parseAuxLabels,
  WriterNumberingFileSchema,
  WriterNumberingResponseSchema,
} from "../src/writer-numbering.js";

// verbatim probe events (report class, single pass)
const EVENTS = `{"type":"label","id":"label-000001","key":"ch:one","file":"main.tex","line":6,"page":"1"}
{"type":"section","id":"section-000001","name":"section","number":"1.1","title":"Intro","file":"main.tex","line":7,"page":"1"}
{"type":"label","id":"label-000002","key":"sec:intro","file":"main.tex","line":7,"page":"1"}
{"type":"mathnum","id":"math-000001","env":"equation","number":"1.1","file":"main.tex","line":12,"page":"1"}
{"type":"label","id":"label-000003","key":"eq:vc","file":"main.tex","line":12,"page":"1"}
{"type":"mathnum","id":"math-000002","env":"align","number":"1.2","file":"main.tex","line":16,"page":"1"}
{"type":"label","id":"label-000004","key":"eq:ab","file":"main.tex","line":16,"page":"1"}
{"type":"section","id":"section-000002","name":"section","number":"1.2","title":"Method","file":"main.tex","line":17,"page":"1"}
{"type":"mathnum","id":"math-000003","env":"equation","number":"1.3","file":"main.tex","line":21,"page":"1"}
{"type":"label","id":"label-000005","key":"eq:e","file":"main.tex","line":21,"page":"1"}
{"broken json tail`;

const AUX = `\\newlabel{ch:one}{{1}{1}{}{}{}}
\\newlabel{sec:intro}{{1.1}{1}{}{}{}}
\\newlabel{eq:vc}{{1.1}{1}{}{}{}}
\\newlabel{eq:ab}{{1.2}{1}{}{}{}}
\\newlabel{eq:e}{{1.3}{1}{}{}{}}
`;

const RANGES = [
  { cell: "c_aaaa0001", startLine: 5, endLine: 16 },
  { cell: "c_bbbb0002", startLine: 17, endLine: 30 },
];

describe("parseAuxLabels", () => {
  it("maps every label to its printed number", () => {
    expect(parseAuxLabels(AUX)).toEqual({
      "ch:one": "1",
      "sec:intro": "1.1",
      "eq:vc": "1.1",
      "eq:ab": "1.2",
      "eq:e": "1.3",
    });
    expect(parseAuxLabels("")).toEqual({});
  });
});

describe("fuseNumberingEvents", () => {
  const facts = fuseNumberingEvents(EVENTS, AUX, RANGES);

  it("sections carry number/title/cell/label", () => {
    expect(facts.sections).toEqual([
      { number: "1.1", title: "Intro", cell: "c_aaaa0001", label: "sec:intro" },
      { number: "1.2", title: "Method", cell: "c_bbbb0002", label: null },
    ]);
  });

  it("equations group per env block (one line = one target), labels bound by line", () => {
    expect(facts.equations).toEqual([
      { number: "1.1", env: "equation", cell: "c_aaaa0001", label: "eq:vc" },
      { number: "1.2", env: "align", cell: "c_aaaa0001", label: "eq:ab" },
      { number: "1.3", env: "equation", cell: "c_bbbb0002", label: "eq:e" },
    ]);
  });

  it("labels come from the aux; a truncated tail line is tolerated", () => {
    expect(facts.labels["eq:e"]).toBe("1.3");
    expect(facts.labels["sec:intro"]).toBe("1.1");
  });

  it("events outside every cell range map to cell null", () => {
    const f = fuseNumberingEvents(EVENTS, AUX, [
      { cell: "c_zzzz9999", startLine: 100, endLine: 200 },
    ]);
    expect(f.sections.every((s) => s.cell === null)).toBe(true);
  });
});

describe("numbering file/response schemas", () => {
  it("round-trip the persisted file shape (looseObject keeps unknown keys)", () => {
    const file = WriterNumberingFileSchema.parse({
      version: 1,
      at: "2026-09-15T12:00:00.000Z",
      texHash: "deadbeef",
      facts: { sections: [], equations: [], labels: {} },
      lastError: null,
      futureField: { keep: true },
    });
    expect(file.futureField).toEqual({ keep: true });
  });

  it("response: never/ok/stale status enum", () => {
    expect(
      WriterNumberingResponseSchema.safeParse({ status: "never", facts: null, lastError: null })
        .success
    ).toBe(true);
    expect(WriterNumberingResponseSchema.safeParse({ status: "weird" }).success).toBe(false);
  });
});
